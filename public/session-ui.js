/* Sign-in for a Mac shared by several people. Shown inside the shell once users exist and nobody is
   signed in, or when a session ends. On success the page that asked for it renders again. */

export async function viewSignIn(token, ui) {
  const { root, page, api, still, showAlert, focusNext, setSession, refreshSession, render } = ui;
  document.title = "Sign in to Ledgercraft";
  root.innerHTML = page({ company: null, locked: true, title: "Sign in",
    lede: "Several people use the books on this Mac. Sign in with your name and passphrase to open them.",
    body: `<form class="foot-form sign-in" id="sign-in" novalidate>
      <label>Name <input name="name" required maxlength="40" autocomplete="username" autocapitalize="words" spellcheck="false"></label>
      <label>Passphrase <input name="passphrase" type="password" required maxlength="512" autocomplete="current-password"></label>
      <div class="actions"><button type="submit">Sign in</button></div>
      <p class="field-note">Forgot your passphrase? The owner can set a new one on the Users page.</p>
    </form>` });
  const form = root.querySelector("#sign-in");
  const button = form.querySelector("[type=submit]");
  let busy = false;

  /* Return moves from the name to the passphrase; Return in the passphrase signs in. */
  form.addEventListener("keydown", event => {
    if (event.key !== "Enter" || event.isComposing || event.target !== form.elements.name) return;
    event.preventDefault();
    focusNext(form, event.target);
  });

  form.addEventListener("submit", async event => {
    event.preventDefault();
    if (busy) return;
    const name = form.elements.name.value.trim();
    const passphrase = form.elements.passphrase.value;
    if (!name || !passphrase) {
      showAlert(name ? "Enter your passphrase." : "Enter your name.", form);
      (name ? form.elements.passphrase : form.elements.name).focus();
      return;
    }
    busy = true;
    button.disabled = true;
    button.setAttribute("aria-busy", "true");
    try {
      const data = await api("/api/session", { method: "POST", body: { name, passphrase } });
      setSession({ signInRequired: true, user: data.user });
      if (still(token)) render();
    } catch (error) {
      busy = false;
      button.disabled = false;
      button.removeAttribute("aria-busy");
      if (!still(token)) return;
      /* Every user was removed in the meantime: the start link opens the books again. */
      if (error.status === 400) {
        const current = await refreshSession().catch(() => null);
        if (current && !current.signInRequired) { render(); return; }
      }
      form.elements.passphrase.value = "";
      showAlert(error.message, form);
      form.elements.passphrase.focus();
    }
  });
  form.elements.name.focus();
}
