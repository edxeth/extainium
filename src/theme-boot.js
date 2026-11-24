// Sets data-theme on <html> before the first paint. A classic script in <head>,
// before style.css: chrome.storage is async, so both pages keep a copy of the
// theme settings in localStorage (shared by the popup and the options page).
// theme.js reads chrome.storage afterwards and corrects the copy if it is stale.
(() => {
  const root = document.documentElement;
  const raw = localStorage.getItem("extainium.theme");
  let saved = {};
  try {
    saved = JSON.parse(raw || "{}");
  } catch {
    // A damaged copy: theme.js rewrites it from chrome.storage.
  }
  const own = matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  // System: the popup takes the scheme the options page last saw (Titanium reports
  // light in the popup while its tabs are dark); the options page uses its own.
  root.dataset.theme = saved.theme === "light" || saved.theme === "dark"
    ? saved.theme
    : (root.dataset.page === "popup" && saved.observedScheme) || own;
  // No copy yet (first open after an update): the guess above may be the wrong scheme.
  // Keep the page hidden until theme.js has applied the stored theme; the timeout makes
  // sure it never stays blank.
  if (!raw) {
    root.dataset.themePending = "";
    setTimeout(() => delete root.dataset.themePending, 300);
  }
})();
