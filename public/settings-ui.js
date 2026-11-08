/* Books settings: voucher numbering series and period locks. Every change here is written to the edit log. */

const TYPES = ["Payment", "Receipt", "Contra", "Journal", "Sales", "Purchase", "Debit Note", "Credit Note"];
const dateLabel = value => /^\d{4}-\d{2}-\d{2}$/.test(value || "") ? value.split("-").reverse().join("-") : value || "";
const two = value => String(value).padStart(2, "0");
const whenLabel = iso => {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "";
  return `${two(at.getDate())}-${two(at.getMonth() + 1)}-${at.getFullYear()} ${two(at.getHours())}:${two(at.getMinutes())}`;
};
const slug = type => type.toLowerCase().replace(/\s+/g, "-");

const LOCKS = {
  books: {
    title: "Books",
    action: "Lock books up to this date",
    effect: "A books lock stops anyone passing, altering or removing vouchers, GST documents and stock journals dated on or before the lock date, and stops changes to opening balances.",
  },
  gst: {
    title: "GST returns",
    action: "Lock GST returns up to this date",
    effect: "A GST lock stops changes to GST invoices and notes, and to their credit, reverse-charge and amendment decisions, dated on or before the lock date, so filed returns stay as filed.",
  },
};

export async function viewSettings(route, token, ui) {
  if (!route.id) throw new Error("Open a company to change its settings");
  const { root, api, still, page, esc } = ui;
  const base = `/api/companies/${encodeURIComponent(route.id)}`;
  const book = `#/c/${encodeURIComponent(route.id)}`;
  const [meta, numberingView, lockView] = await Promise.all([api(`${base}/meta`), api(`${base}/numbering`), api(`${base}/locks`)]);
  if (!still(token)) return;
  const company = meta.company;
  let numbering = numberingView.numbering;
  let preview = numberingView.preview;
  let previewDate = numberingView.date;
  let locks = lockView.locks;
  let numberingRequest = crypto.randomUUID();
  const lockRequests = { books: crypto.randomUUID(), gst: crypto.randomUUID() };

  document.title = `Books settings · ${company.name}`;
  root.innerHTML = page({ company, title: "Books settings", lede: "Voucher numbering and period locks for this company.",
    body: `<p class="quiet">Every change on this page is written to the edit log with the time and, for locks, the reason. <a href="${book}/audit">Open the edit log</a></p>
      <section class="subsection" aria-labelledby="numbering-title"><h2 id="numbering-title">Numbering series</h2>
        <p>Each voucher type gets its next number from its series. A number you type on a voucher still wins.</p>
        <form id="numbering-form" novalidate>
          <div class="table-scroll"><table class="numbering-table"><thead><tr><th>Voucher type</th><th>Prefix</th><th>Suffix</th><th>Width</th><th>Restart each financial year</th><th>Next number</th><th data-preview-head>Next voucher</th></tr></thead><tbody data-numbering-rows></tbody></table></div>
          <p class="form-note" id="numbering-help">In a prefix or suffix, <span class="code">{fy}</span> becomes the financial year, for example 26-27. Width pads the number with zeros: width 4 turns 7 into 0007. Leave the next number blank to continue after the highest number already used. The last column shows what the next voucher will get, as saved.</p>
          <p class="form-message" role="alert" data-numbering-error tabindex="-1"></p>
          <p class="status" role="status" data-numbering-status></p>
          <div class="actions"><button type="submit">Save numbering</button></div>
        </form>
      </section>
      <section class="subsection" aria-labelledby="locks-title"><h2 id="locks-title">Period locks</h2>
        <p>Lock a period once its books are final or its GST returns are filed. Reports still read locked periods. Unlocking needs a reason too.</p>
        <div class="two lock-forms" data-lock-forms></div>
      </section>` });

  /* ---------- Numbering ---------- */
  const numberingForm = root.querySelector("#numbering-form");
  const rowsTarget = root.querySelector("[data-numbering-rows]");
  const numberingError = root.querySelector("[data-numbering-error]");
  const numberingStatus = root.querySelector("[data-numbering-status]");
  const widthOptions = selected => Array.from({ length: 9 }, (_, width) => `<option value="${width}"${width === selected ? " selected" : ""}>${width === 0 ? "No padding" : width === 1 ? "1 digit" : width + " digits"}</option>`).join("");
  const numberingRow = type => {
    const series = numbering[type] || { prefix: "", suffix: "", width: 0, restartEachFY: false };
    const key = slug(type);
    return `<tr data-type="${esc(type)}">
      <th scope="row">${esc(type)}</th>
      <td><label class="sr" for="prefix-${key}">${esc(type)} prefix</label><input id="prefix-${key}" class="code" name="prefix" maxlength="12" autocomplete="off" spellcheck="false" value="${esc(series.prefix)}" aria-describedby="numbering-help"></td>
      <td><label class="sr" for="suffix-${key}">${esc(type)} suffix</label><input id="suffix-${key}" class="code" name="suffix" maxlength="12" autocomplete="off" spellcheck="false" value="${esc(series.suffix)}" aria-describedby="numbering-help"></td>
      <td><label class="sr" for="width-${key}">${esc(type)} width</label><select id="width-${key}" name="width">${widthOptions(series.width)}</select></td>
      <td><label class="check"><input type="checkbox" name="restartEachFY"${series.restartEachFY ? " checked" : ""}><span class="sr">Restart ${esc(type)} numbers each financial year</span></label></td>
      <td><label class="sr" for="next-${key}">${esc(type)} next number</label><input id="next-${key}" name="next" type="number" min="1" max="999999999" step="1" inputmode="numeric" placeholder="Automatic" value="${esc(series.next ?? "")}"></td>
      <td><span class="code" data-preview>${esc(preview[type] || "")}</span><small data-stale hidden>Changes show after saving</small></td></tr>`;
  };
  const paintNumbering = () => {
    rowsTarget.innerHTML = TYPES.map(numberingRow).join("");
    root.querySelector("[data-preview-head]").textContent = `Next voucher on ${dateLabel(previewDate)}`;
  };
  paintNumbering();
  numberingForm.addEventListener("input", event => {
    const row = event.target.closest("tr[data-type]");
    if (row) row.querySelector("[data-stale]").hidden = false;
    numberingStatus.textContent = "";
  });
  const showNumberingError = message => {
    numberingStatus.textContent = "";
    numberingError.className = "form-message alert";
    numberingError.textContent = message;
    numberingError.scrollIntoView({ block: "nearest" });
    numberingError.focus({ preventScroll: true });
  };
  const collectNumbering = () => Object.fromEntries([...rowsTarget.querySelectorAll("tr[data-type]")].map(row => {
    const field = name => row.querySelector(`[name="${name}"]`);
    const next = field("next").value.trim();
    const type = row.dataset.type;
    if (next && !/^\d+$/.test(next)) throw new Error(`${type}: the next number is a whole number from 1 to 999999999`);
    return [type, { prefix: field("prefix").value.trim(), suffix: field("suffix").value.trim(), width: Number(field("width").value), restartEachFY: field("restartEachFY").checked, next: next ? Number(next) : null }];
  }));
  let savingNumbering = false;
  numberingForm.addEventListener("submit", async event => {
    event.preventDefault();
    if (savingNumbering) return;
    numberingError.textContent = "";
    let body;
    try { body = { numbering: collectNumbering(), expected: numbering, requestId: numberingRequest }; }
    catch (error) { showNumberingError(error.message); return; }
    savingNumbering = true;
    const button = numberingForm.querySelector("[type=submit]");
    button.disabled = true;
    try {
      const saved = await api(`${base}/numbering`, { method: "PUT", body });
      if (!still(token)) return;
      numberingRequest = crypto.randomUUID();
      const fresh = await api(`${base}/numbering`).catch(() => saved);
      if (!still(token)) return;
      numbering = fresh.numbering;
      preview = fresh.preview;
      previewDate = fresh.date;
      paintNumbering();
      numberingStatus.textContent = saved.replayed ? "Nothing changed in the numbering." : "Numbering saved";
    } catch (error) {
      if (still(token)) showNumberingError(error.message);
    } finally {
      savingNumbering = false;
      button.disabled = false;
    }
  });

  /* ---------- Period locks ---------- */
  const lockTarget = root.querySelector("[data-lock-forms]");
  const lockState = lock => {
    if (lock?.to) {
      return `<dl class="kv"><dt>Locked up to</dt><dd><strong>${esc(dateLabel(lock.to))}</strong> <span class="pill warn">Locked</span></dd><dt>Reason</dt><dd>${esc(lock.reason || "")}</dd><dt>Set on</dt><dd>${esc(whenLabel(lock.at))}</dd></dl>`;
    }
    const last = lock && lock.at ? `<dt>Last unlocked</dt><dd>${esc(whenLabel(lock.at))}</dd><dt>Reason</dt><dd>${esc(lock.reason || "")}</dd>` : "";
    return `<dl class="kv"><dt>Current lock</dt><dd>Not locked</dd>${last}</dl>`;
  };
  const lockForm = kind => {
    const copy = LOCKS[kind];
    const lock = locks[kind];
    return `<form class="lock-form" data-lock="${kind}" aria-labelledby="lock-${kind}-title">
      <h3 id="lock-${kind}-title">${esc(copy.title)}</h3>
      <p class="form-note">${esc(copy.effect)}</p>
      ${lockState(lock)}
      <p class="form-message" role="alert" data-lock-error tabindex="-1"></p>
      <p class="status" role="status" data-lock-status></p>
      <label>Lock up to <input type="date" name="to" required min="${esc(company.booksFrom)}" value="${esc(lock?.to || "")}"></label>
      <label>Reason <textarea name="reason" required maxlength="240" aria-describedby="lock-${kind}-reason-note"></textarea></label>
      <p class="field-note" id="lock-${kind}-reason-note">Required for locking and unlocking, up to 240 characters. It is kept in the edit log.</p>
      <div class="actions"><button type="submit">${esc(copy.action)}</button>${lock?.to ? `<button type="button" class="danger" data-unlock>Unlock</button>` : ""}</div>
    </form>`;
  };
  const savingLocks = { books: false, gst: false };
  const bindLockForm = form => {
    const kind = form.dataset.lock;
    const error = form.querySelector("[data-lock-error]");
    const status = form.querySelector("[data-lock-status]");
    const show = message => {
      status.textContent = "";
      error.className = "form-message alert";
      error.textContent = message;
      error.scrollIntoView({ block: "nearest" });
      error.focus({ preventScroll: true });
    };
    const send = async (to, done) => {
      if (savingLocks[kind]) return;
      const reason = form.elements.reason.value.trim();
      if (!reason) { show("Give a reason for this lock change in the reason box."); form.elements.reason.focus(); return; }
      if (to !== null && !/^\d{4}-\d{2}-\d{2}$/.test(to)) { show(`Enter the ${kind === "books" ? "books" : "GST"} lock date.`); form.elements.to.focus(); return; }
      savingLocks[kind] = true;
      error.textContent = "";
      const buttons = [...form.querySelectorAll("button")];
      for (const button of buttons) button.disabled = true;
      try {
        const saved = await api(`${base}/locks`, { method: "PUT", body: { [kind]: { to, reason }, expected: locks, requestId: lockRequests[kind] } });
        if (!still(token)) return;
        lockRequests[kind] = crypto.randomUUID();
        locks = saved.locks;
        paintLocks();
        const fresh = lockTarget.querySelector(`[data-lock="${kind}"] [data-lock-status]`);
        if (fresh) fresh.textContent = saved.replayed ? "Nothing changed in this lock." : done;
      } catch (err) {
        if (!still(token)) return;
        for (const button of buttons) button.disabled = false;
        show(err.message);
      } finally {
        savingLocks[kind] = false;
      }
    };
    form.addEventListener("submit", event => {
      event.preventDefault();
      const to = form.elements.to.value;
      send(to, `${LOCKS[kind].title} locked up to ${dateLabel(to)}.`);
    });
    form.querySelector("[data-unlock]")?.addEventListener("click", () => {
      if (!form.elements.reason.value.trim()) { show("Give a reason for unlocking in the reason box."); form.elements.reason.focus(); return; }
      if (!confirm(`Unlock ${kind === "books" ? "the books" : "GST returns"} up to ${dateLabel(locks[kind]?.to)}? Entries in that period can be changed again.`)) return;
      send(null, `${LOCKS[kind].title} unlocked.`);
    });
  };
  const paintLocks = () => {
    lockTarget.innerHTML = lockForm("books") + lockForm("gst");
    for (const form of lockTarget.querySelectorAll("[data-lock]")) bindLockForm(form);
  };
  paintLocks();
  return true;
}
