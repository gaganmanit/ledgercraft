// Ledger picker for voucher lines: an accessible combobox in front of the hidden ledger <select>.
// The <select name="ledger"> stays in the row and remains the source of truth, so collectLines(),
// the draft code and browser checks that call select_option keep working. No imports: the pure
// helpers at the top run under node:test, the DOM part receives formatINR and esc from app.js.

const MAX_OPTIONS = 60;
const WORD_BREAK = /[\s\-&(),./:]+/;

export function normalise(text) {
  return String(text ?? "").toLocaleLowerCase("en-IN").replace(/\s+/g, " ").trim();
}

/**
 * Ledgers whose name or group path contains the typed text, case-insensitively.
 * Order: name starts with the text, a word in the name starts with it, the name contains it,
 * the group path contains it, every typed word appears somewhere in name or path. Ties sort by name.
 * @param {{id: string, name: string, path?: string}[]} ledgers
 */
export function filterLedgers(ledgers, query) {
  const needle = normalise(query);
  const words = needle.split(" ").filter(Boolean);
  const ranked = [];
  for (const ledger of ledgers) {
    const name = normalise(ledger.name);
    const path = normalise(ledger.path);
    let rank;
    if (!needle) rank = 0;
    else if (name.startsWith(needle)) rank = 0;
    else if (name.split(WORD_BREAK).some(word => word.startsWith(needle))) rank = 1;
    else if (name.includes(needle)) rank = 2;
    else if (path.includes(needle)) rank = 3;
    else if (words.length > 1 && words.every(word => name.includes(word) || path.includes(word))) rank = 4;
    else continue;
    ranked.push({ ledger, rank });
  }
  ranked.sort((a, b) => a.rank - b.rank || a.ledger.name.localeCompare(b.ledger.name, "en-IN", { sensitivity: "base" }));
  return ranked.map(entry => entry.ledger);
}

/** The ledger whose name is exactly the typed text, ignoring case and extra spaces. */
export function exactLedger(ledgers, text) {
  const needle = normalise(text);
  if (!needle) return null;
  return ledgers.find(ledger => normalise(ledger.name) === needle) || null;
}

/** Closing balances by ledger id from a trial-balance response. Ledgers without movement are absent. */
export function balancesFromTrial(report) {
  const balances = new Map();
  for (const row of report?.rows || []) {
    if (row?.ledgerId && row.closing) balances.set(row.ledgerId, { paise: row.closing.paise, dc: row.closing.dc });
  }
  return balances;
}

/** Shared state for every picker on one voucher screen. Call notifyDirectory after changing it. */
export function createLedgerDirectory({ ledgers = [], groups = [], balances = null } = {}) {
  return { ledgers, groups, balances, subscribers: new Set() };
}

export function notifyDirectory(directory) {
  for (const update of directory.subscribers) update();
}

let pickerSerial = 0;

/**
 * Put a combobox in front of a ledger <select>.
 * @param {HTMLSelectElement} select
 * @param {{directory: object, esc: Function, formatINR: Function, createLedger: Function, afterChoose?: Function}} options
 */
export function installLedgerPicker(select, { directory, esc, formatINR, createLedger, afterChoose = () => {} }) {
  if (select.dataset.picker === "1") return;
  select.dataset.picker = "1";
  const base = select.id || `ledger-picker-${++pickerSerial}`;
  select.classList.add("sr");
  select.tabIndex = -1;
  select.setAttribute("aria-hidden", "true");

  const wrap = document.createElement("div");
  wrap.className = "ledger-picker";
  wrap.innerHTML = `<input id="${esc(base)}-find" type="text" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="${esc(base)}-list" autocomplete="off" spellcheck="false" placeholder="Type to find a ledger" />
    <div class="ledger-popup" hidden><ul class="ledger-list" id="${esc(base)}-list" role="listbox" aria-label="Ledgers"></ul><p class="ledger-more quiet" hidden></p></div>
    <div class="ledger-create" role="group" aria-labelledby="${esc(base)}-create-title" hidden>
      <p class="ledger-create-title" id="${esc(base)}-create-title">New ledger</p>
      <label>Name <input name="new-ledger-name" maxlength="80" autocomplete="off" /></label>
      <label>Group <select name="new-ledger-group"><option value="">Choose a group</option></select></label>
      <div class="ledger-create-actions"><button type="button" data-create-save>Save ledger</button><button type="button" class="ghost" data-create-cancel>Cancel</button></div>
      <p class="form-message alert" role="alert"></p>
    </div>`;
  select.after(wrap);
  const field = wrap.querySelector("[role=combobox]");
  const popup = wrap.querySelector(".ledger-popup");
  const list = wrap.querySelector("[role=listbox]");
  const more = wrap.querySelector(".ledger-more");
  const create = wrap.querySelector(".ledger-create");
  const createName = create.querySelector("[name=new-ledger-name]");
  const createGroup = create.querySelector("[name=new-ledger-group]");
  const createMessage = create.querySelector(".form-message");
  // The visible label now names the combobox; the select is hidden from assistive technology.
  const label = select.parentElement?.querySelector(`label[for="${CSS.escape(base)}"]`);
  if (label) label.htmlFor = field.id;
  else field.setAttribute("aria-label", "Ledger");

  let items = [];
  let active = -1;
  let open = false;
  let saving = false;

  const current = () => directory.ledgers.find(ledger => ledger.id === select.value) || null;
  const showSelected = () => { field.value = current()?.name || ""; };

  const balanceCell = ledger => {
    if (!directory.balances) return "";
    const balance = directory.balances.get(ledger.id);
    if (!balance?.paise) return `<span class="ledger-option-balance figure quiet">—</span>`;
    return `<span class="ledger-option-balance figure">${esc(formatINR(balance.paise))}<span class="dc">${esc(balance.dc)}</span></span>`;
  };

  function paint() {
    const query = field.value;
    const matches = filterLedgers(directory.ledgers, query);
    const shown = matches.slice(0, MAX_OPTIONS);
    items = shown.map(ledger => ({ kind: "ledger", ledger }));
    if (normalise(query) && !exactLedger(directory.ledgers, query)) items.push({ kind: "create", name: query.trim() });
    if (active >= items.length) active = items.length - 1;
    list.innerHTML = items.map((item, index) => item.kind === "create"
      ? `<li role="option" id="${esc(base)}-option-${index}" class="ledger-option ledger-option-create" data-index="${index}" aria-selected="${index === active}">Create a ledger named “${esc(item.name)}”</li>`
      : `<li role="option" id="${esc(base)}-option-${index}" class="ledger-option" data-index="${index}" aria-selected="${index === active}"><span class="ledger-option-name">${esc(item.ledger.name)}</span><span class="ledger-option-path quiet">${esc(item.ledger.path || "")}</span>${balanceCell(item.ledger)}</li>`).join("");
    const hidden = matches.length - shown.length;
    more.hidden = hidden <= 0;
    more.textContent = hidden > 0 ? `${hidden} more ledger${hidden === 1 ? "" : "s"} match. Keep typing to narrow the list.` : "";
    if (active >= 0) field.setAttribute("aria-activedescendant", `${base}-option-${active}`);
    else field.removeAttribute("aria-activedescendant");
    return items.length > 0;
  }

  function setActive(index) {
    active = Math.max(-1, Math.min(items.length - 1, index));
    for (const option of list.children) option.setAttribute("aria-selected", String(Number(option.dataset.index) === active));
    if (active >= 0) {
      field.setAttribute("aria-activedescendant", `${base}-option-${active}`);
      list.children[active]?.scrollIntoView({ block: "nearest" });
    } else field.removeAttribute("aria-activedescendant");
  }

  function openList(firstActive = active) {
    active = firstActive;
    if (!paint()) { closeList(); return; }
    open = true;
    popup.hidden = false;
    field.setAttribute("aria-expanded", "true");
    setActive(active);
  }

  function closeList() {
    open = false;
    active = -1;
    popup.hidden = true;
    field.setAttribute("aria-expanded", "false");
    field.removeAttribute("aria-activedescendant");
  }

  function setValue(id) {
    if (select.value !== id) {
      select.value = id;
      select.dispatchEvent(new Event("input", { bubbles: true }));
      select.dispatchEvent(new Event("change", { bubbles: true }));
    }
    showSelected();
  }

  /** Keep an exact typed match, clear the line when the text is empty, otherwise show the chosen ledger again. */
  function commitTyped() {
    const exact = exactLedger(directory.ledgers, field.value);
    if (exact) setValue(exact.id);
    else if (!normalise(field.value)) setValue("");
    else showSelected();
  }

  function choose(item) {
    if (!item) return;
    if (item.kind === "create") { openCreate(item.name); return; }
    closeList();
    setValue(item.ledger.id);
    afterChoose(select);
  }

  function openCreate(name) {
    closeList();
    if (createGroup.options.length === 1) {
      createGroup.insertAdjacentHTML("beforeend", directory.groups.map(group => `<option value="${esc(group.id)}">${esc(group.path)}</option>`).join(""));
    }
    createName.value = name;
    createMessage.textContent = "";
    create.hidden = false;
    (name ? createGroup : createName).focus();
  }

  function closeCreate() {
    create.hidden = true;
    createMessage.textContent = "";
    showSelected();
    field.focus();
  }

  async function saveCreate() {
    if (saving) return;
    const name = createName.value.trim();
    if (!name) { createMessage.textContent = "Enter a name for the new ledger."; createName.focus(); return; }
    if (!createGroup.value) { createMessage.textContent = "Choose the group the new ledger belongs to."; createGroup.focus(); return; }
    const existing = exactLedger(directory.ledgers, name);
    if (existing) { create.hidden = true; setValue(existing.id); afterChoose(select); return; }
    saving = true;
    const buttons = [...create.querySelectorAll("button")];
    for (const button of buttons) button.disabled = true;
    try {
      const ledger = await createLedger({ name, groupId: createGroup.value });
      if (!select.isConnected) return;
      create.hidden = true;
      createMessage.textContent = "";
      setValue(ledger.id);
      afterChoose(select);
    } catch (error) {
      createMessage.textContent = error.message;
      createName.focus();
    } finally {
      saving = false;
      for (const button of buttons) button.disabled = false;
    }
  }

  field.addEventListener("input", () => openList(normalise(field.value) ? 0 : -1));
  field.addEventListener("click", () => { if (!open) openList(); });
  field.addEventListener("keydown", event => {
    const plain = !event.metaKey && !event.ctrlKey && !event.altKey;
    if (event.key === "ArrowDown" && plain) {
      event.preventDefault();
      if (!open) openList(0); else setActive(active + 1);
    } else if (event.key === "ArrowDown" && event.altKey) {
      event.preventDefault();
      if (!open) openList();
    } else if (event.key === "ArrowUp" && plain) {
      event.preventDefault();
      if (open) setActive(Math.max(0, active - 1));
    } else if (event.key === "Enter" && plain && !event.shiftKey) {
      event.preventDefault();
      event.stopPropagation();
      if (open && active >= 0) { choose(items[active]); return; }
      const typed = normalise(field.value);
      commitTyped();
      if (typed && !exactLedger(directory.ledgers, field.value)) { openList(items.length ? 0 : -1); return; }
      closeList();
      if (select.value) afterChoose(select);
      else openList();
    } else if (event.key === "Escape") {
      if (open) { event.preventDefault(); event.stopPropagation(); closeList(); }
      else showSelected();
    } else if (event.key === "Tab") {
      if (open) closeList();
      commitTyped();
    }
  });
  wrap.addEventListener("focusout", event => {
    if (wrap.contains(event.relatedTarget)) return;
    if (open) closeList();
    if (create.hidden) commitTyped();
  });
  list.addEventListener("mousedown", event => event.preventDefault());
  list.addEventListener("click", event => {
    const option = event.target.closest("[data-index]");
    if (option) choose(items[Number(option.dataset.index)]);
  });
  create.addEventListener("keydown", event => {
    if (event.key === "Enter" && !event.metaKey && !event.ctrlKey && !event.altKey) { event.preventDefault(); event.stopPropagation(); saveCreate(); }
    else if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); closeCreate(); }
  });
  create.querySelector("[data-create-save]").addEventListener("click", saveCreate);
  create.querySelector("[data-create-cancel]").addEventListener("click", closeCreate);
  // Drafts, duplicates and browser checks set the select directly; show the chosen ledger by name.
  select.addEventListener("change", showSelected);
  directory.subscribers.add(() => { if (open) paint(); });
  showSelected();
}

/** The control a person types into for this line's ledger: the combobox when installed, else the select. */
export function ledgerControl(row) {
  return row.querySelector(".ledger-picker [role=combobox]") || row.querySelector("select[name=ledger]");
}
