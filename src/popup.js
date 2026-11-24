import { trackedView } from "./lib/manager.js";

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
function avatar(record, ext) {
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

function row(v) {
  const pending = v.pendingInstall && v.pendingInstall.tag === v.latest.tag;
  return h("li", {},
    avatar(v.record, v.ext),
    h("div", { className: "row-text" },
      h("strong", {}, v.ext ? v.ext.name : v.key),
      h("span", { className: "versions-line" },
        h("span", { className: "visually-hidden" }, "Installed "), v.ext.version,
        h("span", { "aria-hidden": "true" }, " → "), h("span", { className: "visually-hidden" }, ", latest "),
        h("span", { className: "to" }, v.latest.tag),
        pending ? " · waiting for the browser" : null)));
}

// A release that would install as another extension: confirmed in Extainium.
function attentionRow(v) {
  return h("li", {},
    avatar(v.record, v.ext),
    h("div", { className: "row-text" },
      h("strong", {}, v.ext ? v.ext.name : v.key),
      h("span", { className: "versions-line attention" },
        `${v.record.identityChange.tag} installs as a new extension. Review in Extainium.`)));
}

async function render() {
  const view = await trackedView();
  const updates = view.filter((v) => v.state === "update");
  const attention = view.filter((v) => v.state === "identity-change");
  const state = !view.length ? "empty" : updates.length ? "update" : attention.length ? "attention" : "current";
  document.body.dataset.state = state;
  $("summary").textContent = state === "empty"
    ? "No tracked extensions"
    : state === "update"
      ? `${plural(updates.length, "update", "updates")} available`
      : state === "attention"
        ? `${plural(attention.length, "extension needs", "extensions need")} attention`
        : "All up to date";
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

function showErrors(errors) {
  $("error").hidden = !errors.length;
  $("error").replaceChildren(
    h("strong", {}, errors.length > 1 ? `${errors.length} checks failed` : "Check failed"),
    h("span", {}, errors.join("\n")));
}

$("check").addEventListener("click", async () => {
  $("check").disabled = true;
  $("check").setAttribute("aria-busy", "true");
  $("check").textContent = "Checking…";
  const res = await chrome.runtime.sendMessage({ type: "check" });
  showErrors(res.error ? [res.error] : res.errors);
  $("check").disabled = false;
  $("check").removeAttribute("aria-busy");
  $("check").textContent = "Check now";
  await render();
});

$("open").addEventListener("click", () => chrome.runtime.openOptionsPage());

render();
