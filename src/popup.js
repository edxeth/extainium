import { trackedView } from "./lib/manager.js";
import { friendly } from "./friendly.js";
import { startTheme } from "./theme.js";

const $ = (id) => document.getElementById(id);

function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k in el) el[k] = v;
    else el.setAttribute(k, v);
  }
  el.append(...children.flat().filter((c) => c !== null && c !== false && c !== undefined));
  return el;
}

const plural = (n, one, many) => `${n} ${new Intl.PluralRules().select(n) === "one" ? one : many}`;
const when = (at) => new Date(at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

// Owner avatar with the installed extension's icon as a corner badge, as on the options cards.
function avatar(v) {
  const { record, ext } = v;
  // Store and self-hosted records have no owner picture: the extension icon is the image.
  if ((v.source || "github") !== "github") {
    const icon = ext && ext.icons && ext.icons.length ? [...ext.icons].sort((a, b) => b.size - a.size)[0].url : null;
    const initial = h("span", { className: "fallback", hidden: !!icon, "aria-hidden": "true" }, (v.title || "?").slice(0, 1));
    const img = icon ? h("img", { className: "owner", alt: "", width: 48, height: 48, src: icon, onerror: () => { img.hidden = true; initial.hidden = false; } }) : null;
    return h("div", { className: "avatar" }, img, initial);
  }
  const initial = h("span", { className: "fallback", hidden: true, "aria-hidden": "true" }, record.owner.slice(0, 1));
  const img = h("img", {
    className: "owner", alt: "", width: 48, height: 48, decoding: "async",
    src: `https://github.com/${encodeURIComponent(record.owner)}.png?size=96`,
    onerror: () => { img.hidden = true; initial.hidden = false; },
  });
  const icon = ext && ext.icons && ext.icons.length
    ? [...ext.icons].sort((a, b) => b.size - a.size)[0].url
    : null;
  return h("div", { className: "avatar" }, img, initial,
    icon ? h("img", { className: "ext", alt: "", width: 24, height: 24, src: icon, onerror: (e) => e.target.remove() }) : null);
}

const titleOf = (v) => (v.ext ? v.ext.name : v.title || v.key);

function row(v) {
  // github: the release tag; cws, updateUrl: the CRX version.
  const latest = v.latest.tag || v.latest.version;
  const pending = v.pendingInstall && (v.pendingInstall.tag === latest || v.pendingInstall.version === latest);
  return h("li", {},
    avatar(v),
    h("div", { className: "row-text" },
      h("strong", {}, titleOf(v)),
      h("span", { className: "versions-line" },
        h("span", { className: "visually-hidden" }, "Installed "), v.ext.version,
        h("span", { "aria-hidden": "true" }, " → "), h("span", { className: "visually-hidden" }, ", latest "),
        h("span", { className: "to" }, latest),
        v.sourceLabel ? ` · ${v.sourceLabel}` : null,
        pending ? " · waiting for the browser" : null)));
}

// A release that would install as another extension: confirmed in Extainium.
function attentionRow(v) {
  return h("li", {},
    avatar(v),
    h("div", { className: "row-text" },
      h("strong", {}, titleOf(v)),
      h("span", { className: "versions-line attention" },
        `${v.record.identityChange.tag || v.record.identityChange.asset} installs as a new extension. Review in Extainium.`)));
}

async function render() {
  const view = await trackedView();
  const updates = view.filter((v) => v.state === "update");
  const attention = view.filter((v) => v.state === "identity-change");
  const state = !view.length ? "empty" : updates.length ? "update" : attention.length ? "attention" : "current";
  document.body.dataset.state = state;
  const summary = state === "empty"
    ? "No tracked extensions"
    : state === "update"
      ? `${plural(updates.length, "update", "updates")} available`
      : state === "attention"
        ? `${plural(attention.length, "extension needs", "extensions need")} attention`
        : "All up to date";
  // A live region: write only a changed headline, so a check with the same result is not read twice.
  if ($("summary").textContent !== summary) $("summary").textContent = summary;
  $("emptyHint").hidden = state !== "empty";
  $("check").hidden = state === "empty";
  $("updates").replaceChildren(...updates.map(row), ...attention.map(attentionRow));
  const { lastCheck } = await chrome.storage.local.get("lastCheck");
  const tracked = state === "current" ? `${plural(view.length, "extension", "extensions")} tracked · ` : "";
  $("lastCheck").textContent = state === "empty"
    ? ""
    : tracked + (lastCheck
      ? `Last checked ${when(lastCheck.at)}${lastCheck.errors.length ? ` · ${plural(lastCheck.errors.length, "error", "errors")}` : ""}`
      : "Not checked yet. Checks run every 6 hours.");
  $("lastCheck").hidden = !$("lastCheck").textContent;
}

// #error is a persistent alert region; it is empty when there is nothing to say.
function showErrors(errors) {
  if (!errors.length) return $("error").replaceChildren();
  if (errors.length > 1) {
    return $("error").replaceChildren(
      h("strong", {}, `${errors.length} checks failed. Open Extainium to see which.`));
  }
  const f = friendly(errors[0]);
  $("error").replaceChildren(
    h("strong", {}, "Check failed"), h("span", {}, f.text), h("span", { className: "detail" }, f.detail));
}

// aria-disabled, not disabled, so the button keeps focus while the check runs.
$("check").addEventListener("click", async () => {
  const button = $("check");
  if (button.getAttribute("aria-disabled") === "true") return;
  button.setAttribute("aria-disabled", "true");
  button.setAttribute("aria-busy", "true");
  button.textContent = "Checking…";
  try {
    const res = await chrome.runtime.sendMessage({ type: "check" });
    showErrors(res.error ? [res.error] : res.errors);
  } catch (e) {
    showErrors([e.message]);
  } finally {
    button.removeAttribute("aria-disabled");
    button.removeAttribute("aria-busy");
    button.textContent = "Check all";
    await render();
  }
});

$("open").addEventListener("click", () => chrome.runtime.openOptionsPage());

startTheme({ observe: false });
render();
