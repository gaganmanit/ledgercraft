/* Applies the saved or system colour scheme before the first paint. Loaded as a classic script so the page never flashes the wrong theme. */
(function () {
  var stored = null;
  try { stored = localStorage.getItem("ledgercraft-theme"); } catch (error) { stored = null; }
  var dark = stored ? stored === "dark" : window.matchMedia("(prefers-color-scheme: dark)").matches;
  document.documentElement.dataset.theme = dark ? "dark" : "light";
})();
