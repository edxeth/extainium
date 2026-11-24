// Theme setting: System, Light or Dark. theme-boot.js applies the cached value
// before the first paint; this module keeps it in sync with chrome.storage.
import { getTheme, recordObservedScheme, setTheme } from "./lib/store.js";

export { setTheme };
const CACHE = "extainium.theme";

async function readPrefs() {
  const { theme, observedScheme } = await getTheme();
  return { theme, observedScheme };
}

const dark = matchMedia("(prefers-color-scheme: dark)");
const ownScheme = () => (dark.matches ? "dark" : "light");

// observe: true on the options page (records what it sees for the popup); false in the popup.
function apply(prefs, observe) {
  const scheme = prefs.theme !== "system" ? prefs.theme : (!observe && prefs.observedScheme) || ownScheme();
  document.documentElement.dataset.theme = scheme;
  delete document.documentElement.dataset.themePending; // set by theme-boot.js on a first open
  localStorage.setItem(CACHE, JSON.stringify(prefs));
}

// Applies the stored theme, follows later changes, and returns the theme setting.
export async function startTheme({ observe }) {
  const prefs = await readPrefs();
  apply(prefs, observe);
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.settings) readPrefs().then((p) => apply(p, observe));
  });
  if (observe) {
    await recordObservedScheme(ownScheme()); // writes only on a change
    dark.addEventListener("change", () => recordObservedScheme(ownScheme()));
  }
  return prefs.theme;
}
