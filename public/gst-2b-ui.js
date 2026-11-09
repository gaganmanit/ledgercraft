/* GSTR-2B reconciliation as a month-end tool: matching results with tolerance notes, IMS actions on
 * every statement row, the matching tolerance settings and the rule 37 watch for unpaid suppliers. */
import { parseRupees, todayISO } from "/money.js";
import { pagingNote } from "/table-export.js";

const fields = { type: "Type", number: "Number", date: "Date", taxable: "Taxable ₹", cgst: "CGST ₹", sgst: "SGST / UTGST ₹", igst: "IGST ₹", cess: "Cess ₹", total: "Total ₹", placeOfSupply: "Place of supply", reverseCharge: "Reverse charge" };
const monetary = new Set(["taxable","cgst","sgst","igst","cess","total"]);
const dateLabel = value => /^\d{4}-\d{2}-\d{2}$/.test(value || "") ? value.split("-").reverse().join("-") : value || "";
const STATUS_TONE = { Matched: "ok", "Matched within tolerance": "ok", Mismatch: "bad", Duplicate: "bad", Ambiguous: "warn", "Only in 2B": "warn", "Only in books": "warn", "Absent from selected pages": "warn" };
const ITC_LABEL = { Y: "Available", N: "Not available" };
const ITC_TONE = { Y: "ok", N: "warn" };
const IMS_ACTIONS = ["accept", "reject", "pending", "no-action"];
const IMS_LABEL = { accept: "Accepted", reject: "Rejected", pending: "Pending", "no-action": "No action" };
const IMS_TONE = { accept: "ok", reject: "bad", pending: "warn", "no-action": "" };
const IMS_CHOICE = { accept: "Accept", reject: "Reject", pending: "Keep pending", "no-action": "No action (deemed accepted)" };
const IMS_PAST = { accept: "accepted", reject: "rejected", pending: "kept pending", "no-action": "left without action" };
const HEADS = [["taxable", "Taxable value"], ["igst", "IGST"], ["cgst", "CGST"], ["sgst", "SGST / UTGST"], ["cess", "Cess"]];
const DIFF_HEADS = [["taxable", "Taxable"], ["igst", "IGST"], ["cgst", "CGST"], ["sgst", "SGST"], ["cess", "Cess"], ["total", "Total"]];
const DIFF_LABEL = { ...fields, taxable: "Taxable", cgst: "CGST", sgst: "SGST / UTGST", igst: "IGST", cess: "Cess", total: "Total" };
const MONTHS = ["January","February","March","April","May","June","July","August","September","October","November","December"];
const monthLabel = value => /^\d{4}-(0[1-9]|1[0-2])$/.test(value || "") ? `${MONTHS[Number(value.slice(5, 7)) - 1]} ${value.slice(0, 4)}` : value || "";
const plural = (n, one, many = one + "s") => `${Number(n).toLocaleString("en-IN")} ${n === 1 ? one : many}`;
const PAGE_ROWS = 200;
const REQUEST_ID = () => crypto.randomUUID();
const two = n => String(n).padStart(2, "0");
const whenLabel = iso => {
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? String(iso || "") : `${two(at.getDate())}-${two(at.getMonth() + 1)}-${at.getFullYear()} at ${two(at.getHours())}:${two(at.getMinutes())}`;
};

/* The signed-in role decides whether IMS actions and tolerance can be changed here. Viewers read only. */
let sessionRole = null;
function readRole() {
  sessionRole ||= fetch("/api/session").then(response => response.ok ? response.json() : {}).then(data => data.user ? data.user.role : "owner").catch(() => "owner");
  return sessionRole;
}

async function request(path, options = {}) {
  let response;
  try {
    response = await fetch(path, { method: options.method || "GET", headers: options.body ? { "content-type": "application/json" } : undefined, body: options.body ? JSON.stringify(options.body) : undefined });
  } catch {
    throw new Error("Ledgercraft could not reach its local server. Check that it is still running, then try again.");
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || (options.method && options.method !== "GET" ? "The book could not be updated" : "That information could not be loaded"));
  return data;
}

/* Shows a form's error beside it, announced to assistive technology, with focus moved to it. */
function formAlert(form, message) {
  const alert = form.querySelector("[data-form-error]");
  alert.textContent = message;
  alert.scrollIntoView({ block: "nearest" });
  alert.focus({ preventScroll: true });
}

/* Return moves to the next field, as in the rest of the books. */
function returnMovesOn(form) {
  form.addEventListener("keydown", event => {
    if (event.key !== "Enter" || event.shiftKey || event.metaKey || event.ctrlKey || event.altKey || event.isComposing) return;
    const from = event.target;
    if (!(from instanceof HTMLInputElement || from instanceof HTMLSelectElement)) return;
    event.preventDefault();
    const controls = [...form.querySelectorAll("input, select, textarea, button")].filter(el => !el.disabled && el.offsetParent !== null && el.type !== "hidden");
    const next = controls[controls.indexOf(from) + 1];
    if (!next) return;
    next.focus();
    if (next instanceof HTMLInputElement && typeof next.select === "function") next.select();
  });
}

const readDraft = key => { try { return JSON.parse(sessionStorage.getItem(key) || "null"); } catch { return null; } };
const writeDraft = (key, value) => { try { sessionStorage.setItem(key, JSON.stringify(value)); } catch { /* private browsing */ } };
const dropDraft = key => { try { sessionStorage.removeItem(key); } catch { /* private browsing */ } };

export function showMatches(target, result, { esc, href, formatINR }) {
  const companyPath = "/api/companies/" + href.slice("#/c/".length);
  const statement = result.statement && result.statement.id ? result.statement : null;
  const hashRegistration = new URLSearchParams(location.hash.split("?")[1] || "").get("registration") || "";
  const registrationId = statement?.registrationId || hashRegistration;
  const money = paise => esc(formatINR(paise || 0));
  const signed = paise => `${paise > 0 ? "+" : paise < 0 ? "−" : ""}₹${esc(formatINR(Math.abs(paise)))}`;
  const signedPlain = paise => `${paise > 0 ? "+" : paise < 0 ? "−" : ""}${esc(formatINR(Math.abs(paise)))}`;
  const taxOf = bucket => bucket ? (bucket.igstPaise || 0) + (bucket.cgstPaise || 0) + (bucket.sgstPaise || 0) + (bucket.cessPaise || 0) : 0;
  let model = { ...result, results: result.results };
  let limit = PAGE_ROWS;
  let openKey = null;
  let canEdit = false;
  let historyLoaded = false;

  target.innerHTML = `<h3>Matching results</h3>
    <div data-2b-summary></div>
    <div class="details-list" data-2b-settings></div>
    <p class="status" role="status" tabindex="-1" data-2b-status></p>
    <div class="toolbar"><label>Match status <select data-filter></select></label><label>IMS action <select data-ims-filter></select></label>
    <button type="button" class="ghost" data-export>Export matching report</button></div>
    <div data-table aria-live="off"></div>
    <div class="table-more" data-2b-more hidden><p class="quiet" data-2b-more-note></p><button type="button" class="ghost" data-2b-more-rows>Show ${PAGE_ROWS} more rows</button></div>
    <div class="subsection ims-rule37" data-2b-rule37></div>`;
  const summaryBox = target.querySelector("[data-2b-summary]");
  const settingsBox = target.querySelector("[data-2b-settings]");
  const statusLine = target.querySelector("[data-2b-status]");
  const filter = target.querySelector("[data-filter]"), imsFilter = target.querySelector("[data-ims-filter]");
  const table = target.querySelector("[data-table]");
  const more = target.querySelector("[data-2b-more]");
  const rule37Box = target.querySelector("[data-2b-rule37]");

  const pill = status => `<span class="pill${STATUS_TONE[status] ? " " + STATUS_TONE[status] : ""}">${esc(status)}</span>`;
  const imsKey = row => row.portalValue === undefined ? "" : row.ims?.action || "none";
  const rows = () => model.results.filter(row => (!filter.value || row.status === filter.value) && (!imsFilter.value || imsKey(row) === imsFilter.value));
  const format = (field, value) => value === undefined ? "—" : monetary.has(field) ? formatINR(value) : field === "date" ? dateLabel(value) : String(value);
  const amountCell = value => `<td class="figure${value === undefined ? " quiet" : ""}">${esc(format("total", value))}</td>`;
  const bookLink = (id, label) => `<a class="code" href="${href}/gst-document/${encodeURIComponent(id)}">${esc(label)}</a>`;
  /* In the matching table a document number may break only after a slash, and a date never breaks. */
  const codeWrap = text => String(text ?? "").split("/").map((part, i, all) => `<span class="ims-code-part">${esc(part)}${i < all.length - 1 ? "/" : ""}</span>`).join("<wbr>");
  const tableLink = (id, label) => `<a class="code" href="${href}/gst-document/${encodeURIComponent(id)}">${codeWrap(label)}</a>`;
  const dateSpan = value => `<span class="date-cell">${esc(dateLabel(value))}</span>`;

  function paintSummary() {
    const counts = new Map();
    for (const row of model.results) counts.set(row.status, (counts.get(row.status) || 0) + 1);
    const total = model.results.length;
    const imsCounts = model.imsCounts || {};
    const available = model.itcAvailable, excluded = model.itcExcludedByIms;
    const intro = `${plural(total, "row")} compared for <span class="code">${esc(model.gstin)}</span>${model.month ? ` in the ${esc(monthLabel(model.month))} statement` : ""}.`;
    const imsStrip = available ? `<div class="summary-strip ims-strip">${IMS_ACTIONS.map(action => `<div><span>${esc(IMS_LABEL[action])}</span><strong>${Number(imsCounts[action] || 0)}</strong></div>`).join("")}
      <div><span>No action recorded</span><strong>${Number(imsCounts.none || 0)}</strong></div>
      <div><span>ITC available ₹</span><strong>${money(taxOf(available))}</strong><small>${plural(available.count || 0, "document")}</small></div>
      <div><span>Left out by IMS ₹</span><strong>${money(taxOf(excluded))}</strong><small>${plural(excluded?.count || 0, "document")}</small></div></div>` : "";
    const headTable = available ? `<div class="details-list"><details><summary>ITC by tax head <small>Documents the statement marks as ITC available</small></summary>
      <div class="table-scroll"><table class="ims-itc-table"><thead><tr><th>Treatment</th><th>Documents</th>${HEADS.map(([, label]) => `<th class="figure">${esc(label)} ₹</th>`).join("")}<th class="figure">Total tax ₹</th></tr></thead><tbody>
      ${[["Available ITC", available], ["Left out by IMS action", excluded]].map(([label, bucket]) => `<tr><th scope="row">${esc(label)}</th><td>${Number(bucket?.count || 0)}</td>${HEADS.map(([head]) => `<td class="figure">${money(bucket?.[head + "Paise"])}</td>`).join("")}<td class="figure">${money(taxOf(bucket))}</td></tr>`).join("")}
      </tbody></table></div><p class="form-note">Credit notes reduce the figures. Rejected and pending documents are left out of available ITC; a document without action counts as accepted when GSTR-2B is generated.</p></details></div>` : "";
    const imsNote = statement ? (canEdit ? "" : `<p class="quiet">Your role can view IMS actions. An owner or accountant records them.</p>`)
      : `<p class="notice">Save the original files with this company to record IMS actions on these rows.</p>`;
    summaryBox.innerHTML = `<p>${intro}</p>
      ${counts.size ? `<div class="summary-strip">${[...counts].map(([status, n]) => `<div><span>${esc(status)}</span><strong>${n}</strong></div>`).join("")}</div>` : ""}
      ${imsStrip}${headTable}
      ${model.partial ? `<p class="notice">Compared with ${model.pageCount} selected document ${model.pageCount === 1 ? "page" : "pages"}. Include the GSTN file-count summary to check that the statement is complete.</p>` : ""}
      ${model.exceptions?.length ? `<ul class="attention-rule">${model.exceptions.map(e => `<li>${esc(e)}</li>`).join("")}</ul>` : ""}
      ${imsNote}`;
    const keep = filter.value, keepIms = imsFilter.value;
    filter.innerHTML = `<option value="">All results</option>${[...counts].map(([s, n]) => `<option value="${esc(s)}">${esc(s)} (${n})</option>`).join("")}`;
    filter.value = counts.has(keep) ? keep : "";
    const imsChoices = [...IMS_ACTIONS, "none"].filter(action => imsCounts[action]);
    imsFilter.innerHTML = `<option value="">All rows</option>${imsChoices.map(action => `<option value="${action}">${esc(action === "none" ? "No action recorded" : IMS_LABEL[action])} (${Number(imsCounts[action])})</option>`).join("")}`;
    imsFilter.value = imsChoices.includes(keepIms) ? keepIms : "";
    imsFilter.closest("label").hidden = !model.imsCounts;
  }

  function notesHtml(r) {
    const lines = [];
    if (r.notes?.includes("date-differs") && Number.isInteger(r.dateDifferenceDays)) {
      const days = Math.abs(r.dateDifferenceDays);
      lines.push(`Date differs by ${plural(days, "day")}`);
    }
    if (r.notes?.includes("amount-within-tolerance")) lines.push("Amounts within tolerance");
    return lines.map(line => `<div class="quiet">${esc(line)}</div>`).join("");
  }
  /* One line per differing field under the status pill: books, then 2B, then the signed gap, and "within tolerance" when the
     pill does not already say so. A signed amount gap the field lines do not already show stays as a "2B minus books" line. */
  function differenceList(r) {
    const items = r.differences.map(field => {
      const pair = r.values[field], within = r.tolerated?.includes(field) && r.status !== "Matched within tolerance";
      let gap = "";
      if (monetary.has(field)) {
        const paise = Number.isFinite(r.amountDifferences?.[field]) ? r.amountDifferences[field] : Number.isFinite(pair.portal - pair.book) ? pair.portal - pair.book : null;
        if (paise) gap = signedPlain(paise);
      } else if (field === "date" && Number.isInteger(r.dateDifferenceDays)) gap = esc(plural(Math.abs(r.dateDifferenceDays), "day"));
      const note = [gap, within ? "within tolerance" : ""].filter(Boolean).join(", ");
      const shown = value => field === "date" && value !== undefined ? dateSpan(value) : esc(format(field, value));
      return `<div><dt>${esc(DIFF_LABEL[field] || field)}</dt><dd>${shown(pair.book)} books, ${shown(pair.portal)} in 2B${note ? ` <span class="quiet">(${note})</span>` : ""}</dd></div>`;
    });
    const rest = DIFF_HEADS.filter(([head]) => r.amountDifferences?.[head] && !r.differences.includes(head));
    if (rest.length) items.push(`<div><dt>2B minus books</dt><dd>${rest.map(([head, label]) => `${esc(label)} ${signed(r.amountDifferences[head])}`).join(", ")}</dd></div>`);
    return items.length ? `<dl class="ims-diffs">${items.join("")}</dl>` : "";
  }
  function imsCell(r) {
    if (r.portalValue === undefined) return `<span class="quiet">Not in 2B</span>`;
    const ims = r.ims || { action: null, source: "none" };
    const parts = [];
    const actionPill = ims.action ? `<span class="pill${IMS_TONE[ims.action] ? " " + IMS_TONE[ims.action] : ""}">${esc(IMS_LABEL[ims.action])}</span>` : "";
    if (ims.source === "recorded") {
      parts.push(`<div class="ims-action-line">${actionPill} <span class="quiet">on ${dateSpan(ims.at)}${ims.inherited ? ", recorded on an earlier statement" : ""}</span></div>`);
      if (ims.reason) parts.push(`<div class="ims-reason">${esc(ims.reason)}</div>`);
    } else {
      parts.push(actionPill ? `<div class="ims-action-line">${actionPill}</div>` : `<div class="quiet">No action recorded</div>`);
      if (!ims.action && r.imsStatus) parts.push(`<div class="quiet">Portal code <span class="code">${esc(r.imsStatus)}</span></div>`);
      if (ims.source === "portal") parts.push(`<div class="quiet">Status from the portal</div>`);
    }
    const history = Array.isArray(r.history) ? r.history : [];
    const earlier = ims.source === "recorded" && !ims.inherited ? history.slice(0, -1) : history;
    if (earlier.length) parts.push(`<details class="ims-history"><summary>Earlier actions <small>${earlier.length}</small></summary><ol>${earlier.slice().reverse().map(item => `<li><span class="pill${IMS_TONE[item.action] ? " " + IMS_TONE[item.action] : ""}">${esc(IMS_LABEL[item.action] || item.action)}</span> on ${esc(dateLabel(item.at))}.${item.reason ? ` ${esc(item.reason)}` : ""}<small>Recorded ${esc(whenLabel(item.recordedAt))}</small></li>`).join("")}</ol></details>`);
    if (statement && canEdit && r.rowKey) {
      const open = openKey === r.rowKey;
      parts.push(`<div><button type="button" class="ghost" data-ims-open="${esc(r.rowKey)}" aria-expanded="${open}" aria-controls="ims-form-${esc(r.rowKey.slice(0, 16))}">${ims.source === "recorded" && !ims.inherited ? "Change action" : "Record action"}</button></div>`);
    }
    return parts.join("");
  }
  /* A short pill for what the statement says about ITC, the statement reason inside it, and an IMS exclusion as a second line. */
  function itcCell(r) {
    if (!r.statementITC && !r.reason) return "";
    const parts = [ITC_LABEL[r.statementITC] || r.statementITC, r.reason].filter(Boolean);
    const tone = ITC_TONE[r.statementITC];
    return `<span class="pill${tone ? " " + tone : ""}">${parts.map((text, i) => `<span>${esc(text)}${i < parts.length - 1 ? ":" : ""}</span>`).join(" ")}</span>${r.statementITC === "Y" && r.itcAvailable === false ? `<small>Left out by IMS</small>` : ""}`;
  }
  const draftKey = rowKey => `ledgercraft-ims-draft:${statement?.id}:${rowKey}`;
  function formRow(r) {
    const draft = readDraft(draftKey(r.rowKey)) || {};
    const current = r.ims?.source === "recorded" && !r.ims.inherited ? r.ims.action : "";
    const action = IMS_ACTIONS.includes(draft.action) ? draft.action : current || "accept";
    const today = todayISO();
    const at = /^\d{4}-\d{2}-\d{2}$/.test(draft.at || "") ? draft.at : today < r.date ? r.date : today;
    return `<tr class="ims-form-row" id="ims-form-${esc(r.rowKey.slice(0, 16))}"><td colspan="8"><form class="ims-action-form" data-ims-form="${esc(r.rowKey)}">
      <p class="form-message alert" role="alert" tabindex="-1" data-form-error></p>
      <fieldset><legend>IMS action for <span class="code">${esc(r.number)}</span> from <span class="code">${esc(r.gstin)}</span></legend>
      <div class="ims-action-fields"><label>Action <select name="action">${IMS_ACTIONS.map(value => `<option value="${value}"${value === action ? " selected" : ""}>${esc(IMS_CHOICE[value])}</option>`).join("")}</select></label>
      <label>Action date <input type="date" name="at" required value="${esc(at)}" min="${esc(r.date)}"></label>
      <label>Reason <input name="reason" maxlength="240" autocomplete="off" value="${esc(draft.reason || "")}" aria-describedby="ims-reason-note-${esc(r.rowKey.slice(0, 16))}"></label></div>
      <p class="form-note" id="ims-reason-note-${esc(r.rowKey.slice(0, 16))}">Give a reason of 3 to 240 characters to reject a document or keep it pending. Rejected and pending documents are left out of available ITC.</p>
      <div class="actions"><button type="submit">Record IMS action</button><button type="button" class="ghost" data-ims-cancel>Cancel</button></div>
      </fieldset></form></td></tr>`;
  }

  function drawTable() {
    const list = rows();
    const shown = list.slice(0, limit);
    const body = shown.map(r => {
      const section = [r.section ? esc(r.section.toUpperCase()) : "", r.date ? dateSpan(r.date) : ""].filter(Boolean).join(", ");
      const original = r.original ? `<div class="quiet">Originally ${esc(r.original.type)} <span class="code">${codeWrap(r.original.number)}</span> dated ${dateSpan(r.original.date)}</div>` : "";
      const match = r.bookId ? tableLink(r.bookId, r.values.number.book) : (r.candidates || []).map(c => tableLink(c.id, c.number)).join(", ");
      const row = `<tr${r.rowKey && openKey === r.rowKey ? ' aria-selected="true"' : ""}><td class="ims-status">${pill(r.status)}${differenceList(r) || notesHtml(r)}</td><td class="code ims-gstin">${esc(r.gstin)}</td><td class="ims-doc"><span class="code">${codeWrap(r.number)}</span>${section ? `<div class="quiet">${section}</div>` : ""}${original}</td><td class="ims-doc">${match || "—"}${r.bookDate ? `<div class="quiet">Posted ${dateSpan(r.bookDate)}</div>` : ""}</td>${amountCell(r.bookValue)}${amountCell(r.portalValue)}<td class="ims-itc">${itcCell(r) || "—"}</td><td class="ims-cell">${imsCell(r)}</td></tr>`;
      return row + (r.rowKey && openKey === r.rowKey && statement && canEdit ? formRow(r) : "");
    }).join("");
    const head = [["Status"], ["Supplier GSTIN"], ["Document"], ["Book entry"], ["Books ₹", "figure"], ["2B ₹", "figure"], ["2B ITC"], ["IMS"]];
    table.innerHTML = `<div class="table-scroll"><table class="ims-table"${historyLoaded || !statement ? "" : ' aria-busy="true"'}><thead><tr>${head.map(([label, type]) => `<th${type ? ` class="${type}"` : ""}>${esc(label)}</th>`).join("")}</tr></thead><tbody>${body || `<tr><td colspan="8" class="quiet">No rows have this status and IMS action. Choose All results and All rows to see every row.</td></tr>`}</tbody></table></div>`;
    more.hidden = list.length <= limit;
    more.querySelector("[data-2b-more-note]").textContent = pagingNote(shown.length, list.length);
    const form = table.querySelector("[data-ims-form]");
    if (form) bindActionForm(form);
  }

  function openForm(rowKey) {
    openKey = rowKey;
    drawTable();
    table.querySelector(`[data-ims-form="${CSS.escape(rowKey)}"] select[name="action"]`)?.focus();
  }
  function closeForm(focusBack = true) {
    const key = openKey;
    openKey = null;
    drawTable();
    if (focusBack && key) table.querySelector(`[data-ims-open="${CSS.escape(key)}"]`)?.focus();
  }

  function bindActionForm(form) {
    const rowKey = form.dataset.imsForm;
    const row = model.results.find(r => r.rowKey === rowKey);
    const save = () => writeDraft(draftKey(rowKey), { action: form.elements.action.value, at: form.elements.at.value, reason: form.elements.reason.value });
    returnMovesOn(form);
    form.addEventListener("input", () => { save(); delete form.dataset.requestId; });
    form.addEventListener("change", save);
    form.addEventListener("keydown", event => { if (event.key === "Escape") { event.preventDefault(); closeForm(); } });
    form.querySelector("[data-ims-cancel]").addEventListener("click", () => closeForm());
    form.addEventListener("submit", async event => {
      event.preventDefault();
      if (form.dataset.busy === "true") return;
      const action = form.elements.action.value, at = form.elements.at.value, reason = form.elements.reason.value.trim().replace(/\s+/g, " ");
      if (!/^\d{4}-\d{2}-\d{2}$/.test(at)) return formAlert(form, "Enter the date of the IMS action.");
      if (at < row.date) return formAlert(form, `The IMS action cannot be dated before the supplier document date, ${dateLabel(row.date)}.`);
      if ((action === "reject" || action === "pending") && reason.length < 3) return formAlert(form, `Give a reason of at least 3 characters to ${action === "reject" ? "reject this document" : "keep this document pending"}.`);
      if (reason.length > 240) return formAlert(form, "Keep the reason within 240 characters.");
      const button = form.querySelector('button[type="submit"]');
      form.dataset.busy = "true"; button.disabled = true;
      form.dataset.requestId ||= REQUEST_ID();
      const history = Array.isArray(row.history) ? row.history : null;
      const expected = { recordId: history ? history.at(-1)?.id ?? null : row.ims?.source === "recorded" && !row.ims.inherited ? row.ims.recordId : null };
      try {
        const saved = await request(`${companyPath}/gst-returns/ims/actions`, { method: "POST", body: { registration: registrationId, statementId: statement.id, rowKey, action, reason, at, requestId: form.dataset.requestId, expected } });
        if (!target.isConnected) return;
        dropDraft(draftKey(rowKey));
        Object.assign(row, { ims: saved.ims, history: saved.history });
        openKey = null;
        statusLine.textContent = `IMS action recorded. ${row.number} from ${row.gstin} is ${IMS_PAST[action]} on ${dateLabel(at)}.`;
        await refresh();
        const again = table.querySelector(`[data-ims-open="${CSS.escape(rowKey)}"]`);
        if (again) again.focus(); else statusLine.focus({ preventScroll: true });
      } catch (error) {
        if (!target.isConnected) return;
        form.dataset.busy = "false"; button.disabled = false;
        formAlert(form, error.message);
      }
    });
  }

  /* Reloads the saved statement with its IMS history, counts and ITC totals. */
  async function refresh() {
    if (!statement || !registrationId) return;
    try {
      const view = await request(`${companyPath}/gst-returns/ims?${new URLSearchParams({ registration: registrationId, statement: statement.id })}`);
      if (!target.isConnected) return;
      model = { ...model, ...view, results: [...view.rows, ...(view.bookOnly || [])], gstin: view.gstin || model.gstin, month: view.month || model.month };
      historyLoaded = true;
      paintSummary();
      drawTable();
    } catch (error) {
      if (!target.isConnected) return;
      historyLoaded = true;
      drawTable();
      statusLine.textContent = "";
      summaryBox.insertAdjacentHTML("beforeend", `<p class="quiet">IMS history could not be loaded. ${esc(error.message)}</p>`);
    }
  }

  table.addEventListener("click", event => {
    const opener = event.target.closest("[data-ims-open]");
    if (!opener) return;
    if (openKey === opener.dataset.imsOpen) closeForm(); else openForm(opener.dataset.imsOpen);
  });
  table.addEventListener("keydown", event => {
    if (event.key !== "Escape") return;
    const details = event.target.closest("details[open]");
    if (details) { details.open = false; details.querySelector("summary").focus(); }
  });
  filter.onchange = () => { limit = PAGE_ROWS; drawTable(); };
  imsFilter.onchange = () => { limit = PAGE_ROWS; drawTable(); };
  more.querySelector("[data-2b-more-rows]").addEventListener("click", () => { limit += PAGE_ROWS; drawTable(); });

  target.querySelector("[data-export]").onclick = () => {
    const header = ["Match status","Notes","GSTIN","Section","Document","Book posting date","Original number","Original date","ITC","Reason","IMS on portal","IMS action","IMS action date","IMS reason","Counts as available ITC","Candidates","Differences",
      ...Object.values(fields).flatMap(label=>[label+" (books)",label+" (2B)"]), ...DIFF_HEADS.map(([, label]) => `${label} 2B minus books`)];
    const csvRows = rows().map(r=>[r.status,[...notesHtml(r).matchAll(/>([^<]+)</g)].map(m=>m[1]).join("; "),r.gstin,r.section,r.number,r.bookDate || (r.bookId ? r.date : ""),r.original?.number,r.original?.date,r.statementITC,r.reason,r.imsStatus,
      r.ims?.action ? IMS_LABEL[r.ims.action] : "",r.ims?.at || "",r.ims?.reason || "",r.portalValue === undefined ? "" : r.itcAvailable ? "Yes" : "No",
      r.candidates?.map(c=>c.number).join(" | "),r.differences.map(f=>fields[f]).join(", "),
      ...Object.keys(fields).flatMap(f=>["book","portal"].map(side => {
        const value = r.values[f][side];
        return value === undefined ? "" : monetary.has(f) ? formatINR(value).replaceAll(",","") : value;
      })),
      ...DIFF_HEADS.map(([head]) => r.amountDifferences ? formatINR(r.amountDifferences[head]).replaceAll(",","") : "")]);
    for (const exception of model.exceptions || []) csvRows.push(["Separate review","","","","","","","","",exception]);
    const cell = value => {
      const raw = String(value ?? "");
      const safe = /^[\s]*[=+@-]/.test(raw) && !/^-?\d+(\.\d+)?$/.test(raw) ? "'" + raw : raw;
      return '"' + safe.replaceAll('"','""') + '"';
    };
    const data = [header,...csvRows].map(r=>r.map(cell).join(",")).join("\r\n")+"\r\n";
    const blob = URL.createObjectURL(new Blob(["﻿",data],{type:"text/csv;charset=utf-8"}));
    const a=document.createElement("a"); a.href=blob; a.download=`GSTR-2B-${model.gstin}-${model.month}.csv`; target.append(a); a.click(); a.remove();
    setTimeout(()=>URL.revokeObjectURL(blob), 60000);
  };

  /* ---------- Matching tolerance ---------- */
  const toleranceDraftKey = `ledgercraft-2b-tolerance-draft:${companyPath}`;
  const rupees = paise => (paise / 100).toFixed(2);
  const toleranceSentence = settings => {
    const values = HEADS.map(([head]) => settings.tolerance[head + "Paise"]);
    const amounts = values.every(value => value === values[0]) ? `₹${formatINR(values[0])} on taxable value and each tax head` : HEADS.map(([head, label]) => `₹${formatINR(settings.tolerance[head + "Paise"])} on ${label === "Taxable value" ? "taxable value" : label}`).join(", ");
    return `${amounts}, ${plural(settings.dateToleranceDays, "day")} on supplier dates.`;
  };
  function paintSettings(settings, message = "") {
    const draft = readDraft(toleranceDraftKey);
    const value = head => draft && typeof draft[head] === "string" ? draft[head] : rupees(settings.tolerance[head + "Paise"]);
    const days = draft && typeof draft.days === "string" ? draft.days : String(settings.dateToleranceDays);
    const maxRupees = formatINR(settings.limits.maxPaise);
    settingsBox.innerHTML = `<details class="ims-tolerance"${message || draft ? " open" : ""}><summary>Matching tolerance <small>${esc(toleranceSentence(settings))} ${settings.source === "saved" ? "Saved for this company." : "Default settings."}</small></summary>
      <form class="form-grid" data-tolerance-form>
      <p class="form-message alert wide" role="alert" tabindex="-1" data-form-error></p>
      <p class="form-note wide">A row whose only differences fall within these limits shows as matched within tolerance. The invoice total may differ by the sum of the amount limits.</p>
      <fieldset${canEdit ? "" : " disabled"}><legend>Allowed difference</legend><div class="tax-heads">${HEADS.map(([head, label]) => `<label>${esc(label)} ₹ <input name="${head}" inputmode="decimal" autocomplete="off" value="${esc(value(head))}"></label>`).join("")}</div>
      <div class="form-grid"><label>Supplier date, days <input name="days" type="number" inputmode="numeric" min="0" max="${settings.limits.maxDays}" step="1" value="${esc(days)}"></label></div>
      <p class="form-note">Each amount allows ₹0.00 to ₹${esc(maxRupees)}. Supplier dates allow 0 to ${settings.limits.maxDays} days. The defaults are ₹${esc(formatINR(settings.defaults.tolerance.taxablePaise))} per amount and ${plural(settings.defaults.dateToleranceDays, "day")}.</p></fieldset>
      <dl class="kv wide"><dt>In use</dt><dd>${settings.source === "saved" ? "Saved settings for this company" : "Default settings"}</dd></dl>
      ${draft ? `<p class="form-note wide">Unsaved changes are shown. Save them or use the defaults.</p>` : ""}
      ${canEdit ? `<div class="actions wide"><button type="submit">Save tolerance</button><button type="button" class="ghost" data-tolerance-defaults>Use the defaults</button></div>`
        : `<p class="quiet wide">Your role can view the tolerance. An owner or accountant can change it.</p>`}
      <p class="status wide" role="status" tabindex="-1" data-tolerance-status>${esc(message)}</p>
      </form></details>`;
    const form = settingsBox.querySelector("[data-tolerance-form]");
    if (!canEdit) return;
    returnMovesOn(form);
    const keepDraft = () => { writeDraft(toleranceDraftKey, { ...Object.fromEntries(HEADS.map(([head]) => [head, form.elements[head].value])), days: form.elements.days.value }); delete form.dataset.requestId; };
    form.addEventListener("input", keepDraft);
    form.querySelector("[data-tolerance-defaults]").addEventListener("click", () => {
      for (const [head] of HEADS) form.elements[head].value = rupees(settings.defaults.tolerance[head + "Paise"]);
      form.elements.days.value = String(settings.defaults.dateToleranceDays);
      keepDraft();
      form.querySelector("[data-tolerance-status]").textContent = "Default limits filled in. Save tolerance to use them.";
    });
    form.addEventListener("submit", async event => {
      event.preventDefault();
      if (form.dataset.busy === "true") return;
      const tolerance = {};
      for (const [head, label] of HEADS) {
        let paise;
        try { paise = parseRupees(form.elements[head].value); }
        catch { form.elements[head].focus(); return formAlert(form, `Enter the ${label === "Taxable value" ? "taxable value" : label} tolerance in rupees, such as 1.00.`); }
        if (paise > settings.limits.maxPaise) { form.elements[head].focus(); return formAlert(form, `Keep the ${label === "Taxable value" ? "taxable value" : label} tolerance within ₹${maxRupees}.`); }
        tolerance[head + "Paise"] = paise;
      }
      const dayText = form.elements.days.value.trim();
      const dateToleranceDays = Number(dayText);
      if (!/^\d+$/.test(dayText) || dateToleranceDays > settings.limits.maxDays) { form.elements.days.focus(); return formAlert(form, `Use 0 to ${settings.limits.maxDays} days for supplier dates.`); }
      const button = form.querySelector('button[type="submit"]');
      form.dataset.busy = "true"; button.disabled = true;
      form.dataset.requestId ||= REQUEST_ID();
      try {
        const saved = await request(`${companyPath}/gst-returns/reconcile-2b/settings`, { method: "POST", body: { tolerance, dateToleranceDays, requestId: form.dataset.requestId, expected: { tolerance: settings.tolerance, dateToleranceDays: settings.dateToleranceDays } } });
        if (!target.isConnected) return;
        dropDraft(toleranceDraftKey);
        const next = { ...settings, ...saved.settings };
        if (statement) {
          paintSettings(next, saved.replayed ? "These limits were already saved." : "Tolerance saved. The statement was matched again with the new limits.");
          await refresh();
        } else paintSettings(next, saved.replayed ? "These limits were already saved." : "Tolerance saved. Match the files again to apply the new limits.");
        settingsBox.querySelector("[data-tolerance-status]")?.focus({ preventScroll: true });
      } catch (error) {
        if (!target.isConnected) return;
        form.dataset.busy = "false"; button.disabled = false;
        formAlert(form, error.message);
      }
    });
  }
  async function loadSettings() {
    try {
      const settings = await request(`${companyPath}/gst-returns/reconcile-2b/settings`);
      if (target.isConnected) paintSettings(settings);
    } catch (error) {
      if (target.isConnected) settingsBox.innerHTML = `<p class="quiet">The matching tolerance could not be loaded. ${esc(error.message)}</p>`;
    }
  }

  /* ---------- Rule 37: suppliers unpaid beyond 180 days ---------- */
  const partyLink = row => row.partyLedgerId ? `<a href="${href}/parties/${encodeURIComponent(row.partyLedgerId)}">${esc(row.partyName || "Supplier")}</a>` : esc(row.partyName || "Supplier");
  const documentCell = row => `<span class="code">${esc(row.supplierInvoiceNumber || row.number)}</span><div class="quiet">${bookLink(row.invoiceId, row.number)}, ${row.basis === "bill-wise" ? "bill-wise" : "ledger balance"}</div>`;
  const sum = (list, pick) => list.reduce((total, row) => total + (pick(row) || 0), 0);
  function paintRule37(watch, message = "") {
    if (!watch) { rule37Box.innerHTML = ""; return; }
    const listed = watch.rows || [], soon = watch.approaching || [];
    const sgst = value => (value?.sgstPaise || 0) + (value?.utgstPaise || 0);
    const reverseHead = `<th>Supplier</th><th>Document</th><th>Supplier date</th><th>Days outstanding</th><th class="figure">Unpaid ₹</th><th class="figure">CGST to reverse ₹</th><th class="figure">SGST / UTGST to reverse ₹</th><th class="figure">IGST to reverse ₹</th><th class="figure">Cess to reverse ₹</th><th>Reverse in GSTR-3B for</th><th class="figure">Indicative interest ₹</th>`;
    const reverseRows = listed.map(row => `<tr><th scope="row">${partyLink(row)}</th><td>${documentCell(row)}</td><td class="date-cell">${esc(dateLabel(row.supplierInvoiceDate))}</td><td>${Number(row.daysOutstanding)}</td><td class="figure">${money(row.unpaidPaise)}</td><td class="figure">${money(row.itcToReverse?.cgstPaise)}</td><td class="figure">${money(sgst(row.itcToReverse))}</td><td class="figure">${money(row.itcToReverse?.igstPaise)}</td><td class="figure">${money(row.itcToReverse?.cessPaise)}</td><td>${esc(monthLabel(row.reversalPeriod))}</td><td class="figure">${money(row.interest?.indicativePaise)}</td></tr>`).join("");
    const totals = watch.totals || {};
    const reverseTable = listed.length ? `<div class="table-scroll"><table class="ims-rule37-table"><thead><tr>${reverseHead}</tr></thead><tbody>${reverseRows}</tbody>
      <tfoot><tr class="total"><th scope="row" colspan="4">Total</th><td class="figure">${money(sum(listed, row => row.unpaidPaise))}</td><td class="figure">${money(totals.cgstPaise)}</td><td class="figure">${money(sgst(totals))}</td><td class="figure">${money(totals.igstPaise)}</td><td class="figure">${money(totals.cessPaise)}</td><td></td><td class="figure">${money(sum(listed, row => row.interest?.indicativePaise))}</td></tr></tfoot></table></div>
      <p class="form-note">Interest is indicative: 18% a year under section 50(3), from the date the credit was availed to ${esc(dateLabel(watch.asOf))}, and payable only on credit actually used.</p>`
      : `<p class="empty">No supplier invoice with claimed ITC is unpaid beyond 180 days as at ${esc(dateLabel(watch.asOf))}.</p>`;
    const soonTable = soon.length ? `<h4>Approaching 180 days</h4><p class="quiet">Pay these suppliers before the 180 days end to keep the credit.</p>
      <div class="table-scroll"><table class="ims-rule37-table"><thead><tr><th>Supplier</th><th>Document</th><th>Supplier date</th><th>Days outstanding</th><th>180 days end on</th><th class="figure">Unpaid ₹</th><th class="figure">ITC at risk ₹</th></tr></thead><tbody>
      ${soon.map(row => `<tr><th scope="row">${partyLink(row)}</th><td>${documentCell(row)}</td><td class="date-cell">${esc(dateLabel(row.supplierInvoiceDate))}</td><td>${Number(row.daysOutstanding)}</td><td class="date-cell">${esc(dateLabel(row.deadline))}</td><td class="figure">${money(row.unpaidPaise)}</td><td class="figure">${money(row.itcToReversePaise)}</td></tr>`).join("")}</tbody>
      <tfoot><tr class="total"><th scope="row" colspan="5">Total</th><td class="figure">${money(sum(soon, row => row.unpaidPaise))}</td><td class="figure">${money(sum(soon, row => row.itcToReversePaise))}</td></tr></tfoot></table></div>` : "";
    const issues = watch.issues?.length ? `<ul class="attention-rule">${watch.issues.map(issue => `<li>${issue.invoiceId ? `${bookLink(issue.invoiceId, "Open document")}: ` : ""}${esc(issue.message)}</li>`).join("")}</ul>` : "";
    rule37Box.innerHTML = `<h3>Unpaid beyond 180 days</h3>
      <p class="subsection-intro">Rule 37 requires you to add back the input tax credit on a supplier invoice you have not paid within 180 days of its date, in the GSTR-3B for the month after the 180 days end, with interest, and lets you claim it again once you pay.</p>
      <form class="toolbar" data-rule37-form><label>Position as at <input type="date" name="asOf" required value="${esc(watch.asOf)}"></label><button type="submit" class="ghost">Show position</button></form>
      <p class="form-message alert" role="alert" tabindex="-1" data-rule37-error></p>
      <p class="only-print">Position as at ${esc(dateLabel(watch.asOf))}.</p>
      <p class="sr" role="status">${esc(message)}</p>
      ${issues}${reverseTable}${soonTable}`;
    const form = rule37Box.querySelector("[data-rule37-form]");
    form.addEventListener("submit", async event => {
      event.preventDefault();
      const asOf = form.elements.asOf.value;
      const error = rule37Box.querySelector("[data-rule37-error]");
      if (!/^\d{4}-\d{2}-\d{2}$/.test(asOf)) { error.textContent = "Choose the date to review unpaid suppliers."; error.focus(); return; }
      const button = form.querySelector("button");
      button.disabled = true;
      try {
        const query = new URLSearchParams({ asOf, ...(registrationId ? { registration: registrationId } : {}) });
        const next = await request(`${companyPath}/gst-returns/ims/rule37?${query}`);
        if (!target.isConnected) return;
        paintRule37(next, `${plural((next.rows || []).length, "invoice")} unpaid beyond 180 days as at ${dateLabel(asOf)}.`);
        rule37Box.querySelector('[name="asOf"]').focus();
      } catch (failure) {
        if (!target.isConnected) return;
        button.disabled = false;
        error.textContent = failure.message; error.scrollIntoView({ block: "nearest" }); error.focus({ preventScroll: true });
      }
    });
  }

  paintSummary();
  drawTable();
  paintRule37(result.rule37);
  readRole().then(role => {
    if (!target.isConnected) return;
    canEdit = role === "owner" || role === "accountant";
    paintSummary();
    loadSettings();
    if (statement) refresh(); else drawTable();
  });
}
