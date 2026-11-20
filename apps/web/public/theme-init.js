// Runs before the page paints: applies the saved theme choice so the page never flashes the wrong theme.
// An external file, because the Content Security Policy allows scripts from this site and nonce-tagged ones only.
// The storage key matches THEME_KEY in src/lib/theme.ts, and a test holds the two together.
(function () {
  try {
    var choice = window.localStorage.getItem("sluice-theme");
    if (choice === "light" || choice === "dark") document.documentElement.setAttribute("data-theme", choice);
  } catch (e) {
    // storage is blocked: the system setting decides
  }
})();
