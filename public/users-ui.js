/* Users and roles for a Mac shared by several people (lib/users.js). Owner only. While no user exists,
   whoever opened the start link is the owner and this page adds the first one, which turns sign-in on. */

const ROLES = [
  ["owner", "Owner", "Changes everything, including users, period locks, voucher numbering and new companies."],
  ["accountant", "Accountant", "Passes and alters entries, reconciles banks and prepares GST returns. Cannot change users, locks or numbering."],
  ["viewer", "Viewer", "Reads every report and downloads it. Cannot change anything."],
];
const ROLE_NAME = Object.fromEntries(ROLES.map(([value, label]) => [value, label]));
const PASSPHRASE_MIN = 10;
const DRAFT_KEY = "ledgercraft-user-draft";
const FLASH_KEY = "ledgercraft-users-flash";
const two = value => String(value).padStart(2, "0");
const dayLabel = iso => {
  const at = new Date(iso || "");
  return Number.isNaN(at.getTime()) ? "" : `${two(at.getDate())}-${two(at.getMonth() + 1)}-${at.getFullYear()}`;
};

export async function viewUsers(route, token, ui) {
  const { root, api, still, page, esc, showAlert, focusNext, session, isOwner, setSession, refreshSession, render } = ui;
  const meta = route.id ? await api(`/api/companies/${encodeURIComponent(route.id)}/meta`) : null;
  if (!still(token)) return true;
  const company = meta?.company || null;
  document.title = company ? `Users · ${company.name}` : "Ledgercraft users";
  const flash = sessionStorage.getItem(FLASH_KEY) || "";
  sessionStorage.removeItem(FLASH_KEY);

  if (!isOwner()) {
    root.innerHTML = page({ company, title: "Users", status: flash, error: "Only the owner can manage users", body: `<p class="empty">Ask the owner to add a user, change a role or set a new passphrase.</p>` });
    return true;
  }
  const { users = [] } = await api("/api/users");
  if (!still(token)) return true;
  const first = users.length === 0;
  const me = session.user?.id || "";
  let draft = {};
  try { draft = JSON.parse(sessionStorage.getItem(DRAFT_KEY) || "{}") || {}; } catch { draft = {}; }

  const roleOptions = (selected, only = null) => ROLES.filter(([value]) => !only || value === only)
    .map(([value, label]) => `<option value="${esc(value)}"${value === selected ? " selected" : ""}>${esc(label)}</option>`).join("");
  const status = user => user.disabledAt
    ? `<span class="pill warn">Disabled</span> <span class="quiet">since ${esc(dayLabel(user.disabledAt))}</span>`
    : `<span class="pill ok">Active</span>`;
  const rows = users.map(user => `<tr>
      <th scope="row">${esc(user.name)}${user.id === me ? ` <span class="quiet">(you)</span>` : ""}</th>
      <td>${esc(ROLE_NAME[user.role] || user.role)}</td>
      <td class="date-cell">${esc(dayLabel(user.createdAt))}</td>
      <td>${status(user)}</td>
      <td><button type="button" class="ghost" data-edit-user="${esc(user.id)}" aria-label="Change ${esc(user.name)}">Change</button></td></tr>`).join("");
  const passphraseFields = (prefix, label) => `<label>${esc(label)} <input name="passphrase" type="password" required minlength="${PASSPHRASE_MIN}" maxlength="512" autocomplete="new-password" aria-describedby="${prefix}-passphrase-note"></label>
      <label>Type it again <input name="confirm" type="password" required minlength="${PASSPHRASE_MIN}" maxlength="512" autocomplete="new-password"></label>
      <p class="field-note wide" id="${prefix}-passphrase-note">At least ${PASSPHRASE_MIN} characters. A short sentence is easy to remember and hard to guess. Ledgercraft cannot show it again.</p>`;
  /* showAlert fills this line, so a form's error sits at the top of that form across both columns. */
  const formError = `<p class="form-message alert wide" role="alert" tabindex="-1" data-form-error></p>`;
  const roleGuide = `<dl class="kv users-roles">${ROLES.map(([, label, detail]) => `<dt>${esc(label)}</dt><dd>${esc(detail)}</dd>`).join("")}</dl>`;

  const list = first
    ? `<ul class="attention-rule"><li>Nobody signs in yet, so whoever opens the start link can change everything.</li><li>Once a user exists, everyone must sign in to open these books, including in the Mac app.</li><li>The first user is an owner, and this browser stays signed in as that owner.</li></ul>`
    : `<div class="table-scroll"><table class="users-table"><thead><tr><th>Name</th><th>Role</th><th>Added</th><th>Status</th><th><span class="sr">Change</span></th></tr></thead><tbody>${rows}</tbody></table></div>`;

  root.innerHTML = page({ company, title: "Users", status: flash,
    lede: first
      ? "Add the first user to turn sign-in on for the books on this Mac."
      : "Everyone who opens these books signs in with a name and passphrase. The role decides what they can change, and the edit log names who made each change.",
    body: `${list}
      <section class="subsection" id="user-edit" hidden aria-labelledby="user-edit-title">
        <h2 id="user-edit-title">Change user</h2>
        <form class="form-grid" id="user-details">
          ${formError}
          <label>Name <input name="name" required minlength="2" maxlength="40" autocomplete="off" spellcheck="false"></label>
          <label>Role <select name="role">${roleOptions("")}</select></label>
          <div class="actions wide"><button type="submit">Save changes</button><button type="button" class="ghost" data-close-edit>Close</button></div>
        </form>
        <form class="form-grid" id="user-passphrase">
          <h3 class="wide">Set a new passphrase</h3>
          ${formError}
          ${passphraseFields("reset", "New passphrase")}
          <p class="form-note wide">Every other session of this user ends at once. Give them the new passphrase in person.</p>
          <div class="actions wide"><button type="submit">Set passphrase</button></div>
        </form>
        <form class="form-grid" id="user-access">
          <h3 class="wide">Access</h3>
          ${formError}
          <p class="form-note wide" data-access-note></p>
          <div class="actions wide"><button type="button" class="ghost" data-toggle-user></button><button type="button" class="danger" data-remove-user>Remove user</button></div>
        </form>
      </section>
      <section class="subsection" aria-labelledby="user-add-title">
        <h2 id="user-add-title">${first ? "Add the first owner" : "Add a user"}</h2>
        <form class="form-grid" id="user-add">
          ${formError}
          <label>Name <input name="name" required minlength="2" maxlength="40" autocomplete="off" spellcheck="false" value="${esc(draft.name || "")}"></label>
          <label>Role <select name="role">${first ? roleOptions("owner", "owner") : roleOptions(draft.role || "accountant")}</select></label>
          ${first ? `<p class="field-note wide">The first user is always an owner.</p>` : ""}
          ${passphraseFields("add", "Passphrase")}
          <div class="actions wide"><button type="submit">${first ? "Add the owner and turn on sign-in" : "Add user"}</button></div>
        </form>
        ${roleGuide}
      </section>` });

  const addForm = root.querySelector("#user-add");
  const editSection = root.querySelector("#user-edit");
  const detailsForm = root.querySelector("#user-details");
  const passForm = root.querySelector("#user-passphrase");
  const accessForm = root.querySelector("#user-access");
  const toggleButton = accessForm.querySelector("[data-toggle-user]");
  let editing = null;
  let busy = false;

  /* Return moves to the next field; Return in the last field saves the form. */
  for (const form of [addForm, detailsForm, passForm]) {
    form.addEventListener("keydown", event => {
      if (event.key !== "Enter" || event.isComposing || event.metaKey || event.ctrlKey || !event.target.matches("input, select")) return;
      event.preventDefault();
      const fields = [...form.elements].filter(control => control.matches("input, select"));
      if (event.target === fields.at(-1)) form.requestSubmit();
      else focusNext(form, event.target);
    });
  }

  /* The add form keeps its name and role as a draft; passphrases are never stored. */
  const saveDraft = () => {
    try { sessionStorage.setItem(DRAFT_KEY, JSON.stringify({ name: addForm.elements.name.value, role: addForm.elements.role.value })); } catch { /* storage unavailable */ }
  };
  addForm.addEventListener("input", saveDraft);
  addForm.addEventListener("change", saveDraft);

  /* Shared checks and the busy state for every write. Errors stay next to the form that caused them. */
  const checkedPassphrase = form => {
    const passphrase = form.elements.passphrase.value;
    if ([...passphrase].length < PASSPHRASE_MIN) { showAlert(`A passphrase needs at least ${PASSPHRASE_MIN} characters`, form); form.elements.passphrase.focus(); return null; }
    if (passphrase !== form.elements.confirm.value) { showAlert("The two passphrases differ. Type the same passphrase in both fields.", form); form.elements.confirm.focus(); return null; }
    return passphrase;
  };
  const write = async (form, button, work, message) => {
    if (busy) return;
    busy = true;
    if (button) { button.disabled = true; button.setAttribute("aria-busy", "true"); }
    try {
      const result = await work();
      if (!still(token)) return;
      sessionStorage.setItem(FLASH_KEY, typeof message === "function" ? message(result) : message);
      /* A change to your own user can end your session or your owner role: read it again first. */
      await refreshSession();
      render();
    } catch (error) {
      busy = false;
      if (button) { button.disabled = false; button.removeAttribute("aria-busy"); }
      if (!error.signIn && still(token)) showAlert(error.message, form);
    }
  };
  const expected = user => ({ name: user.name, role: user.role, disabledAt: user.disabledAt ?? null });
  const userPath = user => `/api/users/${encodeURIComponent(user.id)}`;

  addForm.addEventListener("submit", event => {
    event.preventDefault();
    const name = addForm.elements.name.value.trim();
    if (name.length < 2) { showAlert("Use a name between 2 and 40 characters", addForm); addForm.elements.name.focus(); return; }
    const passphrase = checkedPassphrase(addForm);
    if (passphrase === null) return;
    const role = addForm.elements.role.value;
    write(addForm, addForm.querySelector("[type=submit]"), async () => {
      const data = await api("/api/users", { method: "POST", body: { name, role, passphrase } });
      sessionStorage.removeItem(DRAFT_KEY);
      if (data.signedIn) setSession({ signInRequired: true, user: { id: data.user.id, name: data.user.name, role: data.user.role } });
      return data;
    }, data => data.signedIn
      ? `${data.user.name} is the owner. Everyone now signs in to open these books, including in the Mac app.`
      : `${data.user.name} added as ${ROLE_NAME[data.user.role].toLowerCase()}.`);
  });

  const openEditor = user => {
    editing = user;
    editSection.hidden = false;
    root.querySelector("#user-edit-title").textContent = user.id === me ? `Change ${user.name} (you)` : `Change ${user.name}`;
    detailsForm.elements.name.value = user.name;
    detailsForm.elements.role.value = user.role;
    passForm.elements.passphrase.value = "";
    passForm.elements.confirm.value = "";
    for (const alert of editSection.querySelectorAll("[data-form-error]")) alert.textContent = "";
    toggleButton.textContent = user.disabledAt ? "Enable user" : "Disable user";
    accessForm.querySelector("[data-access-note]").textContent = user.disabledAt
      ? `${user.name} cannot sign in. Enable the user to let them sign in again with their passphrase.`
      : `Disabling signs ${user.id === me ? "you" : user.name} out at once and stops sign-in until enabled again. Removing deletes the user; edit log entries keep the name.`;
    detailsForm.elements.name.focus();
    detailsForm.elements.name.select();
  };
  const closeEditor = () => {
    const back = editing ? root.querySelector(`[data-edit-user="${CSS.escape(editing.id)}"]`) : null;
    editing = null;
    editSection.hidden = true;
    back?.focus();
  };
  for (const button of root.querySelectorAll("[data-edit-user]")) {
    button.addEventListener("click", () => {
      const user = users.find(item => item.id === button.dataset.editUser);
      if (user && !busy) openEditor(user);
    });
  }
  root.querySelector("[data-close-edit]").addEventListener("click", closeEditor);
  editSection.addEventListener("keydown", event => {
    if (event.key === "Escape" && !busy) { event.preventDefault(); closeEditor(); }
  });

  detailsForm.addEventListener("submit", event => {
    event.preventDefault();
    if (!editing) return;
    const user = editing;
    const name = detailsForm.elements.name.value.trim();
    const role = detailsForm.elements.role.value;
    if (name === user.name && role === user.role) { showAlert("Nothing has changed. Change the name or the role, then save.", detailsForm); return; }
    write(detailsForm, detailsForm.querySelector("[type=submit]"),
      () => api(userPath(user), { method: "PUT", body: { name, role, expected: expected(user) } }),
      data => `${data.user.name} is now ${ROLE_NAME[data.user.role].toLowerCase()}${data.user.name !== user.name ? `, renamed from ${user.name}` : ""}.`);
  });

  passForm.addEventListener("submit", event => {
    event.preventDefault();
    if (!editing) return;
    const user = editing;
    const passphrase = checkedPassphrase(passForm);
    if (passphrase === null) return;
    write(passForm, passForm.querySelector("[type=submit]"),
      () => api(userPath(user), { method: "PUT", body: { passphrase, expected: expected(user) } }),
      user.id === me ? "Your new passphrase is set. You stay signed in here, and your other sessions have ended." : `New passphrase set for ${user.name}. Their other sessions have ended.`);
  });

  toggleButton.addEventListener("click", () => {
    if (!editing || busy) return;
    const user = editing;
    const disable = !user.disabledAt;
    if (disable && !confirm(`Disable ${user.name}? ${user.id === me ? "You are" : "They are"} signed out at once and cannot sign in until enabled again.`)) return;
    write(accessForm, toggleButton,
      () => api(userPath(user), { method: "PUT", body: { disabled: disable, expected: expected(user) } }),
      disable ? `${user.name} is disabled and cannot sign in.` : `${user.name} can sign in again.`);
  });

  accessForm.querySelector("[data-remove-user]").addEventListener("click", event => {
    if (!editing || busy) return;
    const user = editing;
    if (!confirm(`Remove ${user.name}? ${user.id === me ? "You are signed out and cannot" : "They can no longer"} sign in. Edit log entries keep the name.`)) return;
    write(accessForm, event.currentTarget,
      () => api(userPath(user), { method: "DELETE" }),
      `${user.name} removed.`);
  });
  return true;
}
