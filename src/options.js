import {
  addRepo, checkAll, checkRepo, chooseAsset, exportBackup, importBackup, installFile,
  installRelease, refreshBadge, removeRepo, setPattern, setPrereleases, trackInstalledFile, trackedView,
} from "./lib/manager.js";
import { getRepo, getSettings, setSettings } from "./lib/store.js";
import { isPackageAsset, matchAssets } from "./lib/releases.js";

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

// Global toast. Results stay 6 s (longer while the tab is hidden); errors stay until dismissed.
let messageTimer = 0;
function showMessage(text, isError = false) {
  clearTimeout(messageTimer);
  $("message").hidden = !text;
  $("messageClose").hidden = !text;
  $("message").textContent = text || "";
  $("message").classList.toggle("error", isError);
  if (text && !isError) {
    const hide = () => (document.hidden ? (messageTimer = setTimeout(hide, 2000)) : showMessage(""));
    messageTimer = setTimeout(hide, 6000);
  }
}
$("messageClose").addEventListener("click", () => showMessage(""));

// ---- tabs ----
const tabs = [$("tabList"), $("tabTools")];
function selectTab(tab, focus = false) {
  for (const t of tabs) {
    const on = t === tab;
    t.setAttribute("aria-selected", String(on));
    t.tabIndex = on ? 0 : -1;
    $(t.getAttribute("aria-controls")).hidden = !on;
  }
  if (focus) tab.focus();
}
for (const t of tabs) {
  t.addEventListener("click", () => selectTab(t));
  t.addEventListener("keydown", (e) => {
    const step = { ArrowRight: 1, ArrowLeft: -1 }[e.key];
    if (step) selectTab(tabs[(tabs.indexOf(t) + step + tabs.length) % tabs.length], true);
  });
}

const svg = (d) => {
  const el = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  el.setAttribute("viewBox", "0 0 24 24");
  el.setAttribute("aria-hidden", "true");
  const p = document.createElementNS("http://www.w3.org/2000/svg", "path");
  p.setAttribute("d", d);
  el.append(p);
  return el;
};
const CHEVRON = "M6 9l6 6 6-6";

// Runs a UI action: disables the button, reports errors, re-renders.
async function act(button, fn) {
  if (button) button.disabled = true;
  showMessage("");
  try {
    const msg = await fn();
    if (msg) showMessage(msg);
  } catch (e) {
    console.error(e);
    showMessage(e.message, true);
  } finally {
    if (button) button.disabled = false;
    await render();
  }
}

const dateFormat = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", year: "numeric" });
const formatDate = (iso) => (iso ? dateFormat.format(new Date(iso)) : "");
const pluralRules = new Intl.PluralRules("en");
const plural = (n, one, other) => `${n} ${pluralRules.select(n) === "one" ? one : other}`;
const formatSize = (n) => (n >= 1048576 ? (n / 1048576).toFixed(1) + " MB" : Math.ceil(n / 1024) + " KB");

const STATE_LABEL = {
  "no-asset": "No asset",
  ambiguous: "Ambiguous asset",
  "not-installed": "Not installed",
  update: "Update available",
  current: "Up to date",
  unknown: "Version unknown",
};
const extOf = (name) => (name.match(/\.(crx|zip)$/i) || [])[1];

// Per-card progress and errors: key -> { busy, text, error }.
const cardStatus = new Map();

// Runs an action of one tracked repo; its progress and errors show on the card.
async function cardAct(key, fn) {
  const set = (s) => {
    cardStatus.set(key, s);
    render();
  };
  set({ busy: true, text: "Working…" });
  try {
    const text = await fn((step) => set({ busy: true, text: step }));
    if (text) set({ text });
    else cardStatus.delete(key);
  } catch (e) {
    console.error(e);
    set({ error: e.message });
  }
  await render();
}

// ---- asset picker ----

let picker = null; // { key }

function pickerRelease(record) {
  const releases = (record.releases || [])
    .filter((r) => record.includePrereleases || !r.prerelease)
    .sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt));
  return releases.find((r) => r.assets.some((a) => isPackageAsset(a.name))) || releases.find((r) => r.assets.length) || null;
}

// The picker is a modal bottom sheet; focus returns to the control that opened it.
let pickerOpener = null;
function openPicker(key) {
  pickerOpener = document.activeElement;
  picker = { key };
  return renderPicker();
}
async function renderPicker() {
  const sheet = $("pickerSection");
  sheet.hidden = !picker;
  if (!picker) {
    if (sheet.open) sheet.close();
    return;
  }
  const record = await getRepo(picker.key);
  const release = pickerRelease(record);
  $("pickerTitle").textContent = `Choose asset · ${record.owner}/${record.repo}`;
  if (!release) {
    $("pickerRelease").textContent = "No release with assets found.";
    $("pickerAssets").replaceChildren();
    if (!sheet.open) sheet.showModal();
    return;
  }
  $("pickerRelease").textContent = `Release ${release.tag} · ${formatDate(release.publishedAt)}. Later releases use the same file name pattern.`;
  const assets = [...release.assets].sort((a, b) => isPackageAsset(b.name) - isPackageAsset(a.name));
  const visible = $("pickerAll").checked ? assets : assets.filter((a) => isPackageAsset(a.name));
  $("pickerAll").parentElement.querySelector("span").textContent = `Show all assets (${assets.length})`;
  $("pickerAssets").replaceChildren(
    ...visible.map((a) =>
      h("button", {
        className: "asset",
        onclick: (e) => act(e.currentTarget, async () => {
          await chooseAsset(picker.key, a.name, release.tag);
          picker = null;
        }),
      }, h("span", { className: "name" }, extOf(a.name) ? h("span", { className: "kind" }, extOf(a.name)) : null, a.name),
        h("span", { className: "muted" }, formatSize(a.size)))
    ),
    ...(visible.length ? [] : [h("p", { className: "hint" }, "No .crx or .zip assets in this release.")])
  );
  if (!sheet.open) sheet.showModal();
}

$("pickerAll").addEventListener("change", renderPicker);
$("pickerCancel").addEventListener("click", () => {
  picker = null;
  renderPicker();
});
$("pickerSection").addEventListener("close", () => {
  picker = null;
  $("pickerSection").hidden = true;
  if (pickerOpener && pickerOpener.isConnected) pickerOpener.focus();
  pickerOpener = null;
});
$("pickerSection").addEventListener("click", (e) => {
  if (e.target === e.currentTarget) $("pickerSection").close(); // tap on the backdrop
});

// ---- tracked list ----

const openDetails = new Set();

function avatar(record, ext) {
  const initial = h("span", { className: "fallback", hidden: true, "aria-hidden": "true" }, record.owner.slice(0, 1));
  const img = h("img", {
    className: "owner", alt: "", width: 48, height: 48, loading: "lazy", decoding: "async",
    src: `https://github.com/${encodeURIComponent(record.owner)}.png?size=96`,
    onerror: () => { img.hidden = true; initial.hidden = false; },
  });
  const icon = ext && ext.icons && ext.icons.length
    ? [...ext.icons].sort((a, b) => b.size - a.size)[0].url
    : null;
  return h("div", { className: "avatar" }, img, initial,
    icon ? h("img", { className: "ext", alt: "", width: 24, height: 24, src: icon, onerror: (e) => e.target.remove() }) : null);
}

function card(v) {
  const { key, record, latest, ext, state } = v;
  const status = cardStatus.get(key) || {};
  const title = ext ? ext.name : record.repo;
  const installLabel = state === "update" ? "Update" : state === "not-installed" ? "Install" : "Reinstall";
  const canInstall = latest && latest.asset;
  const failed = !!record.error;

  const installed = ext
    ? h("dd", {}, ext.version, ext.enabled ? null : h("span", { className: "sub" }, "disabled"))
    : h("dd", {}, record.extensionId ? "Not installed" : "Not linked yet");
  const latestDd = latest
    ? h("dd", {}, latest.tag,
        h("span", { className: "sub" },
          formatDate(latest.release.publishedAt), latest.release.prerelease ? " · pre-release" : "", " · ",
          h("a", { href: latest.release.htmlUrl, target: "_blank", rel: "noopener" }, "notes")))
    : h("dd", {}, "—", h("span", { className: "sub" },
        !record.releases ? "No release data yet" : record.pattern ? "No release matches the pattern" : "No asset chosen"));

  const details = h("details", {
    open: openDetails.has(key),
    ontoggle: (e) => (e.target.open ? openDetails.add(key) : openDetails.delete(key)),
  },
    h("summary", {}, h("span", {}, "More"), svg(CHEVRON)),
    h("div", { className: "more" },
      h("div", { className: "card-actions" },
        h("button", { onclick: () => openPicker(key) }, "Choose asset"),
        h("button", { onclick: (e) => act(e.currentTarget, () => checkRepo(key).then(refreshBadge)) }, "Check")),
      h("form", {
        onsubmit: (e) => {
          e.preventDefault();
          // Errors (e.g. an invalid regex) show on this card, next to the field's card.
          const pattern = e.target.elements.pattern.value.trim();
          cardAct(key, async () => { await setPattern(key, pattern); });
        },
      },
        h("label", { className: "group-label", htmlFor: `pattern-${key}` }, "Asset file name pattern (regex)"),
        h("div", { className: "field" },
          h("input", { type: "text", id: `pattern-${key}`, name: "pattern", value: record.pattern || "", placeholder: "^name-.*\\.crx$", spellcheck: false, autocapitalize: "off", autocomplete: "off" }),
          h("button", {}, "Save"))),
      h("label", { className: "switch" },
        h("input", { type: "checkbox", checked: record.includePrereleases, onchange: (e) => act(null, () => setPrereleases(key, e.target.checked)) }),
        h("span", {}, "Include pre-releases")),
      olderReleases(key, record),
      h("dl", { className: "facts" },
        h("dt", {}, "Extension ID"), h("dd", {}, record.extensionId || "unknown"),
        h("dt", {}, "Signing"), h("dd", {}, record.keyPkcs8 ? "own key (zip assets)" : "author's key (crx assets)"),
        latest && latest.asset ? [h("dt", {}, "Asset"), h("dd", {}, latest.asset.name)] : null,
        h("dt", {}, "Checked"), h("dd", {}, record.checkedAt ? new Date(record.checkedAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "never")),
      removeControls(key, record)));

  return h("article", { className: `card state-${state}${status.busy ? " busy" : ""}`, "data-key": key, "aria-busy": String(!!status.busy) },
    h("div", { className: "card-head" },
      avatar(record, ext),
      h("div", { className: "title" },
        h("strong", {}, title),
        h("a", { href: `https://github.com/${record.owner}/${record.repo}`, target: "_blank", rel: "noopener" }, `${record.owner}/${record.repo}`),
        h("span", { className: `state ${state}${failed ? " failed" : ""}` }, failed ? "Error" : STATE_LABEL[state]))),
    h("dl", { className: "versions" },
      h("div", { className: "installed" }, h("dt", {}, "Installed"), installed),
      h("div", { className: "latest" }, h("dt", {}, "Latest"), latestDd)),
    state === "ambiguous"
      ? h("div", { className: "candidates" }, h("p", { className: "meta" }, "Several assets match. Pick the one to install:"),
          latest.candidates.map((a) => h("button", { className: "asset", onclick: (e) => act(e.currentTarget, () => chooseAsset(key, a.name, latest.tag)) },
            h("span", { className: "name" }, extOf(a.name) ? h("span", { className: "kind" }, extOf(a.name)) : null, a.name),
            h("span", { className: "muted" }, formatSize(a.size)))))
      : null,
    record.error ? h("p", { className: "error check-error", role: "alert" }, record.error) : null,
    status.text ? h("p", { className: "card-status", role: "status" }, status.busy ? h("span", { className: "spinner", "aria-hidden": "true" }) : null, status.text) : null,
    status.error ? h("p", { className: "error card-error", role: "alert" }, status.error) : null,
    !record.pattern || canInstall
      ? h("div", { className: "card-actions" },
          !record.pattern ? h("button", { className: "primary", onclick: () => openPicker(key) }, "Choose asset") : null,
          canInstall
            ? h("button", {
                className: state === "update" || state === "not-installed" ? "primary" : "",
                onclick: () => cardAct(key, async (progress) => {
                  const res = await installRelease(key, undefined, progress);
                  return `Confirm the browser prompt to add ${res.name} ${res.version}.`;
                }),
              }, installLabel)
            : null)
      : null,
    details);
}

function olderReleases(key, record) {
  if (!record.pattern || !record.releases) return null;
  const options = record.releases
    .filter((r) => matchAssets(r, record.pattern).length === 1)
    .map((r) => h("option", { value: r.tag }, `${r.tag}${r.prerelease ? " (pre)" : ""} · ${formatDate(r.publishedAt)}`));
  if (!options.length) return null;
  const select = h("select", { id: `release-${key}` }, options);
  return h("div", {},
    h("label", { className: "group-label", htmlFor: `release-${key}` }, "Install a specific release"),
    h("div", { className: "field" }, select,
      h("button", {
        onclick: () => cardAct(key, async (progress) => {
          const res = await installRelease(key, select.value, progress);
          return `Confirm the browser prompt to add ${res.name} ${res.version}.`;
        }),
      }, "Install")));
}

function removeControls(key, record) {
  const uninstall = h("input", { type: "checkbox" });
  return h("div", { className: "remove" },
    record.extensionId ? h("label", { className: "switch" }, uninstall, h("span", {}, "Also uninstall the extension")) : h("span"),
    h("button", {
      className: "danger",
      onclick: (e) => act(e.currentTarget, async () => {
        // With uninstall, the browser's own dialog confirms; a confirm() first
        // would use up the user gesture chrome.management.uninstall needs.
        if (!uninstall.checked && !confirm(`Stop tracking ${key}?`)) return;
        await removeRepo(key, uninstall.checked);
        return `Removed ${key}.`;
      }),
    }, "Remove"));
}

let rendering = Promise.resolve();
function render() {
  rendering = rendering.then(renderNow, renderNow);
  return rendering;
}

async function renderNow() {
  const view = await trackedView();
  $("list").replaceChildren(...view.map(card));
  for (const b of $("list").querySelectorAll(".card.busy button")) b.disabled = true;
  $("empty").hidden = view.length > 0;
  const updates = view.filter((v) => v.state === "update").length;
  $("updateCount").hidden = !updates;
  $("updateCount").textContent = plural(updates, "update", "updates");
  $("fileKey").replaceChildren(
    h("option", { value: "" }, "a new key"),
    ...view.filter((v) => v.record.keyPkcs8).map((v) => h("option", { value: v.key }, v.key))
  );
  const { lastCheck, rateLimit } = await chrome.storage.local.get(["lastCheck", "rateLimit"]);
  $("checkInfo").textContent = lastCheck
    ? `Last checked ${new Date(lastCheck.at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}${lastCheck.errors.length ? ` · ${plural(lastCheck.errors.length, "error", "errors")}` : ""}`
    : "Not checked yet. Checks run every 6 hours.";
  $("rateInfo").textContent = rateLimit
    ? `GitHub API: ${rateLimit.remaining}/${rateLimit.limit} requests left, resets ${new Date(rateLimit.reset).toLocaleTimeString(undefined, { timeStyle: "short" })}.`
    : "";
  await renderPicker();
}

// ---- top-level actions ----

$("checkAll").addEventListener("click", (e) =>
  act(e.currentTarget, async () => {
    document.body.classList.add("checking");
    $("checkAll").textContent = "Checking…";
    try {
      const { updates, errors } = await checkAll();
      return errors.length ? `Check finished with errors:\n${errors.join("\n")}` : `Check finished: ${plural(updates, "update", "updates")}.`;
    } finally {
      document.body.classList.remove("checking");
      $("checkAll").textContent = "Check all";
    }
  })
);

$("addForm").addEventListener("submit", (e) => {
  e.preventDefault();
  act(e.submitter, async () => {
    const key = await addRepo($("addInput").value);
    $("addInput").value = "";
    picker = { key };
  });
});

let fileResult = null;
$("fileInstall").addEventListener("click", (e) =>
  act(e.currentTarget, async () => {
    const file = $("fileInput").files[0];
    if (!file) throw new Error("install from file: choose a .crx or .zip first");
    const signWith = $("fileKey").value || null;
    fileResult = await installFile(new Uint8Array(await file.arrayBuffer()), file.name, signWith);
    $("fileTrack").hidden = !!signWith;
    $("fileResult").textContent = `${fileResult.name} ${fileResult.installed.version} → ID ${fileResult.extensionId}.`;
    return "Confirm the browser prompt to add the extension.";
  })
);

$("fileTrackForm").addEventListener("submit", (e) => {
  e.preventDefault();
  act(e.submitter, async () => {
    const key = await trackInstalledFile($("fileTrackInput").value, fileResult);
    $("fileTrack").hidden = true;
    $("fileTrackInput").value = "";
    picker = { key };
    return `Tracking ${key}. Choose the release asset to follow.`;
  });
});

getSettings().then((s) => ($("token").value = s.githubToken));
$("tokenForm").addEventListener("submit", (e) => {
  e.preventDefault();
  act(e.submitter, async () => {
    await setSettings({ githubToken: $("token").value.trim() });
    return "Token saved.";
  });
});

$("export").addEventListener("click", (e) =>
  act(e.currentTarget, async () => {
    const url = URL.createObjectURL(new Blob([await exportBackup()], { type: "application/json" }));
    const day = new Date().toISOString().slice(0, 10);
    await chrome.downloads.download({ url, filename: `extainium-backup-${day}.json` });
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    return "Backup saved to Downloads. It contains signing keys.";
  })
);
$("import").addEventListener("click", () => $("importInput").click());
$("importInput").addEventListener("change", (e) =>
  act(null, async () => {
    const file = e.target.files[0];
    e.target.value = "";
    if (!file) return;
    const { count, errors } = await importBackup(await file.text());
    return `Imported ${plural(count, "repo", "repos")}.${errors.length ? `\nCheck errors:\n${errors.join("\n")}` : ""}`;
  })
);

// Re-render on background changes, but not while the user types in the list.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  const typing = document.activeElement && document.activeElement.matches("#list input[type=text]");
  if (!typing) render();
});
chrome.management.onInstalled.addListener(() => render());
chrome.management.onUninstalled.addListener(() => render());

render();
