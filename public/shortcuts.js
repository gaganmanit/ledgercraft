// Keyboard shortcuts: the "?" list and the Option (Alt) voucher keys. The key mapping is pure and
// tested under node:test; installShortcuts adds the dialog and the document listeners.

/** Voucher type keys. Matched on event.code so that Option dead keys on a Mac do not matter. */
export const VOUCHER_KEYS = [
  ["KeyC", "C", "Contra"],
  ["KeyP", "P", "Payment"],
  ["KeyR", "R", "Receipt"],
  ["KeyJ", "J", "Journal"],
  ["KeyS", "S", "Sales"],
  ["KeyU", "U", "Purchase"],
  ["KeyD", "D", "Debit Note"],
  ["KeyN", "N", "Credit Note"],
];

export function isMacPlatform(platform) {
  return /mac|iphone|ipad|ipod/i.test(String(platform || ""));
}

/** The voucher type an Option/Alt + letter press opens, or null. Shift, Command and Control cancel it. */
export function voucherTypeForKey(event) {
  if (!event?.altKey || event.metaKey || event.ctrlKey || event.shiftKey) return null;
  return VOUCHER_KEYS.find(([code]) => code === event.code)?.[2] || null;
}

/** True when the person is typing, so single-key shortcuts must leave the key alone. */
export function isTypingTarget(target) {
  if (!target) return false;
  if (target.isContentEditable) return true;
  return ["INPUT", "TEXTAREA", "SELECT"].includes(String(target.tagName || "").toUpperCase());
}

export function isHelpKey(event) {
  return event?.key === "?" && !event.metaKey && !event.ctrlKey && !event.altKey;
}

/** "⌥P" on a Mac, "Alt+P" elsewhere. */
export function voucherKeyLabel(type, mac) {
  const letter = VOUCHER_KEYS.find(([, , name]) => name === type)?.[1];
  if (!letter) return "";
  return mac ? `⌥${letter}` : `Alt+${letter}`;
}

/** aria-keyshortcuts value for a voucher type, such as "Alt+P". */
export function voucherKeyShortcut(type) {
  const letter = VOUCHER_KEYS.find(([, , name]) => name === type)?.[1];
  return letter ? `Alt+${letter}` : "";
}

/** Rows for the shortcuts dialog, grouped. Each row is [action, key label]. */
export function shortcutList(mac) {
  const command = mac ? "⌘" : "Ctrl+";
  const option = mac ? "⌥" : "Alt+";
  const enter = mac ? "⏎" : "Enter";
  return [
    ["Anywhere", [["Find a ledger, voucher or page", `${command}K`], ["Show this list", "?"]]],
    ["Voucher entry", [["Pass the voucher", `${command}${enter}`], ["Add a line or fill the missing amount", `${option}${enter}`], ["Move to the next field", enter]]],
    ["New voucher, when a company is open", VOUCHER_KEYS.map(([, , type]) => [type, voucherKeyLabel(type, mac)])],
  ];
}

/**
 * @param {{esc: Function, parseRoute: Function}} options
 * @returns {{open: Function, mac: boolean}}
 */
export function installShortcuts({ esc, parseRoute }) {
  const mac = isMacPlatform(navigator.userAgentData?.platform || navigator.platform);
  const dialog = document.createElement("dialog");
  dialog.className = "shortcuts";
  dialog.setAttribute("aria-labelledby", "shortcuts-title");
  dialog.innerHTML = `<div class="shortcuts-head"><h2 id="shortcuts-title">Keyboard shortcuts</h2><button type="button" class="ghost" data-close-shortcuts aria-label="Close keyboard shortcuts">Esc</button></div>
    <div class="shortcuts-body">${shortcutList(mac).map(([group, rows]) => `<section><h3>${esc(group)}</h3><dl>${rows.map(([action, key]) => `<div><dt>${esc(action)}</dt><dd><kbd>${esc(key)}</kbd></dd></div>`).join("")}</dl></section>`).join("")}
    <p class="quiet">Single-key shortcuts wait while you are typing in a field.</p></div>`;
  document.body.append(dialog);
  let returnFocus = null;
  const open = () => {
    if (dialog.open) return;
    returnFocus = document.activeElement;
    dialog.showModal();
    dialog.querySelector("[data-close-shortcuts]").focus();
  };
  dialog.querySelector("[data-close-shortcuts]").addEventListener("click", () => dialog.close());
  dialog.addEventListener("click", event => { if (event.target === dialog) dialog.close(); });
  dialog.addEventListener("close", () => { if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true }); returnFocus = null; });
  document.addEventListener("click", event => { if (event.target.closest("[data-shortcuts]")) open(); });
  document.addEventListener("keydown", event => {
    if (event.defaultPrevented || event.isComposing || isTypingTarget(event.target)) return;
    if (isHelpKey(event)) {
      event.preventDefault();
      if (dialog.open) dialog.close(); else open();
      return;
    }
    const type = voucherTypeForKey(event);
    if (!type) return;
    const { id } = parseRoute();
    if (!id) return;
    event.preventDefault();
    if (dialog.open) dialog.close();
    document.querySelector("dialog[open]")?.close();
    location.hash = "#/c/" + encodeURIComponent(id) + "/v/" + encodeURIComponent(type);
  });
  window.addEventListener("hashchange", () => { if (dialog.open) dialog.close(); });
  return { open, mac };
}
