export function installFinder({ api, esc, parseRoute, routes }) {
  const dialog = document.createElement("dialog");
  dialog.className = "finder";
  dialog.setAttribute("aria-label", "Find in Ledgercraft");
  dialog.innerHTML = '<div class="finder-head"><label for="find-query">Find a ledger, voucher, narration or page</label><button type="button" class="ghost" aria-label="Close search">Esc</button></div><input id="find-query" type="search" role="combobox" aria-expanded="true" aria-controls="find-list" aria-autocomplete="list" placeholder="Type to search this book" autocomplete="off"><div class="find-list" id="find-list" role="listbox" aria-label="Results"></div>';
  document.body.append(dialog);
  const field = dialog.querySelector("input");
  const list = dialog.querySelector(".find-list");
  let serial = 0, timer;
  async function update() {
    const token = ++serial;
    const { id } = parseRoute();
    const needle = field.value.trim();
    const choices = routes(id).filter(x => x.title.toLowerCase().includes(needle.toLowerCase()));
    function paint(items) {
      list.innerHTML = items.map((x, i) => `<a role="option" id="find-option-${i}" href="${esc(x.href)}"><span><strong>${esc(x.title)}</strong><small>${esc(x.detail || x.kind || "")}</small></span></a>`).join("") || '<p class="quiet" role="option" aria-disabled="true">Nothing in this book matches. Try a ledger name, a voucher number or a word from a narration.</p>';
    }
    paint(choices.slice(0, 12));
    if (id && needle) {
      try {
        const { matches } = await api(`/api/companies/${encodeURIComponent(id)}/find?q=${encodeURIComponent(needle)}`);
        if (token !== serial || !dialog.open) return;
        paint([...matches.map(x => ({ ...x, href: `#/c/${encodeURIComponent(id)}/${x.route}` })), ...choices]);
      } catch (err) { if (token === serial) list.textContent = err.message; }
    }
  }
  field.addEventListener("input", () => { serial++; clearTimeout(timer); timer = setTimeout(update, 90); });
  function open() {
    if (!dialog.open) dialog.showModal();
    field.value = "";
    field.focus();
    update();
  }
  document.addEventListener("click", event => {
    if (event.target.closest("[data-find]")) open();
  });
  document.addEventListener("keydown", event => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") { event.preventDefault(); open(); }
  });
  dialog.querySelector("button").onclick = () => dialog.close();
  dialog.addEventListener("click", event => { if (event.target === dialog || event.target.closest("a")) dialog.close(); });
  dialog.addEventListener("keydown", event => {
    const links = [...list.querySelectorAll("a")];
    const index = links.indexOf(document.activeElement);
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const next = event.key === "ArrowDown" ? index + 1 : index - 1;
      (links[Math.min(links.length - 1, Math.max(-1, next))] || field).focus();
    } else if (event.key === "Enter" && event.target === field && links.length) {
      event.preventDefault(); links[0].click();
    }
  });
  dialog.addEventListener("close", () => { serial++; clearTimeout(timer); });
  window.addEventListener("hashchange", () => { if (dialog.open) dialog.close(); });
}
