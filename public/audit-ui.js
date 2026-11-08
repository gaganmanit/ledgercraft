/* Edit log: the append-only, hash-chained record of every change to the books (Rule 3(1), Companies (Accounts) Rules 2014). */

const PAGE = 100;
const ENTITIES = [
  ["voucher", "Voucher"],
  ["ledger", "Ledger"],
  ["group", "Group"],
  ["gst-document", "GST document"],
  ["gst-master", "GST master"],
  ["stock-journal", "Stock journal"],
  ["reconciliation", "Reconciliation"],
  ["numbering", "Numbering"],
  ["lock", "Period lock"],
  ["company", "Company"],
];
const ENTITY_LABEL = Object.fromEntries(ENTITIES);
const ACTIONS = {
  create: ["Created", "ok"],
  alter: ["Altered", "info"],
  delete: ["Deleted", "bad"],
  lock: ["Locked", "warn"],
  unlock: ["Unlocked", "warn"],
  restore: ["Restored", ""],
  import: ["Imported", ""],
};
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const dateLabel = value => ISO.test(value || "") ? value.split("-").reverse().join("-") : value || "";
const two = value => String(value).padStart(2, "0");
const whenLabel = iso => {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso || "";
  return `${two(at.getDate())}-${two(at.getMonth() + 1)}-${at.getFullYear()} ${two(at.getHours())}:${two(at.getMinutes())}`;
};
const count = value => Number(value || 0).toLocaleString("en-IN");

export async function viewAudit(route, token, ui) {
  if (!route.id) throw new Error("Open a company to read its edit log");
  const { root, api, still, page, esc, readPeriod } = ui;
  const base = `/api/companies/${encodeURIComponent(route.id)}`;
  const book = `#/c/${encodeURIComponent(route.id)}`;
  const meta = await api(`${base}/meta`);
  if (!still(token)) return;
  const company = meta.company;
  const period = readPeriod(company);
  const params = new URLSearchParams(location.hash.split("?")[1] || "");
  const initial = {
    from: ISO.test(params.get("from") || "") ? params.get("from") : period.from,
    to: ISO.test(params.get("to") || "") ? params.get("to") : period.to,
    entity: ENTITY_LABEL[params.get("entity")] ? params.get("entity") : "",
    q: params.get("q") || "",
  };

  document.title = `Edit log · ${company.name}`;
  root.innerHTML = page({ company, title: "Edit log",
    lede: "Every change to these books, newest first, with the time it was made. The log cannot be switched off or edited, and each entry is chained to the one before it.",
    body: `<div class="sheet-tools"><span class="period-echo" data-audit-echo></span><span class="sheet-actions"><button type="button" class="ghost" data-print-sheet>Print</button></span></div>
      <p class="only-print" data-audit-print></p>
      <form class="toolbar" id="audit-filter" role="search" aria-label="Edit log filter">
        <label>From <input type="date" name="from" required value="${esc(initial.from)}"></label>
        <label>To <input type="date" name="to" required value="${esc(initial.to)}"></label>
        <label>Entry type <select name="entity"><option value="">All entries</option>${ENTITIES.map(([value, label]) => `<option value="${esc(value)}"${value === initial.entity ? " selected" : ""}>${esc(label)}</option>`).join("")}</select></label>
        <label class="grow">Search <input type="search" name="q" value="${esc(initial.q)}" placeholder="Voucher number, ledger, reason or words in the summary" autocomplete="off"></label>
      </form>
      <p class="form-message" role="alert" data-audit-error tabindex="-1"></p>
      <div class="audit-chain" data-audit-chain aria-live="polite"></div>
      <div data-audit-body aria-busy="true"><p class="quiet">Reading the edit log.</p></div>
      <div class="table-more" data-audit-more hidden><p class="quiet" data-audit-count></p><button type="button" class="ghost" data-audit-next>Show ${PAGE} more entries</button></div>` });

  const form = root.querySelector("#audit-filter");
  const errorBox = root.querySelector("[data-audit-error]");
  const chainBox = root.querySelector("[data-audit-chain]");
  const bodyBox = root.querySelector("[data-audit-body]");
  const more = root.querySelector("[data-audit-more]");
  const countLine = root.querySelector("[data-audit-count]");
  const echo = root.querySelector("[data-audit-echo]");
  const printLine = root.querySelector("[data-audit-print]");
  let entries = [];
  let total = 0;
  let request = 0;
  let filters = { ...initial };

  const filterValues = () => ({ from: form.elements.from.value, to: form.elements.to.value, entity: form.elements.entity.value, q: form.elements.q.value.trim() });
  const query = (offset) => {
    const values = new URLSearchParams({ from: filters.from, to: filters.to, offset: String(offset), limit: String(PAGE) });
    if (filters.entity) values.set("entity", filters.entity);
    if (filters.q) values.set("q", filters.q);
    return values;
  };

  const target = entry => {
    if (entry.action === "delete") return "";
    const type = entry.after?.type || entry.before?.type;
    if (entry.entity === "voucher" && type && entry.id) return `${book}/v/${encodeURIComponent(type)}/${encodeURIComponent(entry.id)}`;
    if (entry.entity === "gst-document" && /^v-gst-/.test(entry.id || "")) return `${book}/gst-document/${encodeURIComponent(entry.id)}`;
    if (entry.entity === "gst-document" && /^v-/.test(entry.id || "") && type) return `${book}/v/${encodeURIComponent(type)}/${encodeURIComponent(entry.id)}`;
    if (entry.entity === "ledger" && entry.id) return `${book}/ledger/${encodeURIComponent(entry.id)}`;
    return "";
  };
  const rowHtml = entry => {
    const [label, tone] = ACTIONS[entry.action] || [entry.action || "Changed", ""];
    const reference = entry.number || entry.id || "";
    const href = target(entry);
    const referenceHtml = reference ? (href ? `<a class="code" href="${esc(href)}">${esc(reference)}</a>` : `<span class="code">${esc(reference)}</span>`) : "";
    const extra = entry.revision !== undefined && entry.revision !== null ? `<small>Revision ${esc(entry.revision)}</small>` : "";
    return `<tr>
      <td class="date-cell">${esc(whenLabel(entry.at))}</td>
      <td><span class="pill${tone ? " " + tone : ""}">${esc(label)}</span></td>
      <td>${esc(ENTITY_LABEL[entry.entity] || entry.entity || "")}${referenceHtml ? `<div>${referenceHtml}</div>` : ""}</td>
      <td>${esc(entry.summary || "")}${extra}</td>
      <td>${esc(entry.reason || "")}</td></tr>`;
  };
  const describe = () => {
    const kind = filters.entity ? ENTITY_LABEL[filters.entity].toLowerCase() + " entries" : "all entries";
    const words = filters.q ? `, matching “${filters.q}”` : "";
    return `${dateLabel(filters.from)} to ${dateLabel(filters.to)}, ${kind}${words}`;
  };
  const paintChain = data => {
    if (data.verified) {
      chainBox.innerHTML = `<p><span class="pill ok">Chain verified</span> <span class="quiet">Every entry in the log still links to the one before it, so nothing has been altered or removed.</span></p>`;
      return;
    }
    const problems = Array.isArray(data.problems) ? data.problems : [];
    const first = problems[0]?.line;
    chainBox.innerHTML = `<p><span class="pill bad">${first ? `Chain broken at line ${esc(count(first))}` : "Chain broken"}</span> <span class="quiet">The edit log file has been changed outside Ledgercraft. Restore it from a backup and keep this copy for review.</span></p>${problems.length ? `<ul class="attention-rule">${problems.map(problem => `<li>Line ${esc(count(problem.line))}: ${esc(problem.reason)}</li>`).join("")}</ul>` : ""}`;
  };
  const paint = () => {
    echo.textContent = describe();
    printLine.textContent = `Edit log for ${describe()}. ${count(entries.length)} of ${count(total)} entries shown.`;
    bodyBox.removeAttribute("aria-busy");
    if (!entries.length) {
      const filtered = filters.entity || filters.q;
      bodyBox.innerHTML = filtered
        ? `<p class="empty">No entries match this type and search between ${esc(dateLabel(filters.from))} and ${esc(dateLabel(filters.to))}. Choose All entries, clear the search or widen the dates.</p>`
        : `<p class="empty">No changes were logged between ${esc(dateLabel(filters.from))} and ${esc(dateLabel(filters.to))}. The edit log starts with the first change made after this release, so pass a voucher or edit a ledger and it appears here. Widen the dates to see earlier entries.</p>`;
      more.hidden = true;
      return;
    }
    bodyBox.innerHTML = `<div class="table-scroll"><table class="audit-table"><thead><tr><th>When</th><th>Action</th><th>Record</th><th>Summary</th><th>Reason</th></tr></thead><tbody>${entries.map(rowHtml).join("")}</tbody></table></div>`;
    more.hidden = entries.length >= total;
    countLine.textContent = `Showing ${count(entries.length)} of ${count(total)} entries`;
  };
  const showError = message => {
    errorBox.className = "form-message alert";
    errorBox.textContent = message;
    errorBox.scrollIntoView({ block: "nearest" });
  };
  const load = async (append = false) => {
    const ticket = ++request;
    const offset = append ? entries.length : 0;
    if (!append) bodyBox.setAttribute("aria-busy", "true");
    try {
      const data = await api(`${base}/audit?${query(offset)}`);
      if (!still(token) || ticket !== request) return;
      errorBox.textContent = "";
      entries = append ? entries.concat(data.entries || []) : (data.entries || []);
      total = data.total || 0;
      paintChain(data);
      paint();
    } catch (error) {
      if (!still(token) || ticket !== request) return;
      bodyBox.removeAttribute("aria-busy");
      showError(error.message);
    }
  };

  let timer = 0;
  const apply = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (!still(token)) return;
      const next = filterValues();
      if (!ISO.test(next.from) || !ISO.test(next.to)) return;
      if (next.from > next.to) { showError("The From date is after the To date. Choose an earlier From date."); return; }
      filters = next;
      load(false);
    }, 250);
  };
  form.addEventListener("input", apply);
  form.addEventListener("change", apply);
  form.addEventListener("submit", event => { event.preventDefault(); apply(); });
  root.querySelector("[data-audit-next]").addEventListener("click", () => load(true));
  await load(false);
  return true;
}
