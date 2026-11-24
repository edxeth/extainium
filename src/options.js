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

function showMessage(text, isError = false) {
  $("message").hidden = !text;
  $("message").textContent = text || "";
  $("message").classList.toggle("error", isError);
}

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

const formatDate = (iso) => (iso ? new Date(iso).toLocaleDateString() : "");
const formatSize = (n) => (n >= 1048576 ? (n / 1048576).toFixed(1) + " MB" : Math.ceil(n / 1024) + " KB");

const STATE_LABEL = {
  "no-asset": "No matching asset",
  ambiguous: "Several assets match",
  "not-installed": "Not installed",
  update: "Update available",
  current: "Up to date",
  unknown: "Cannot compare versions",
};

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

async function renderPicker() {
  $("pickerSection").hidden = !picker;
  if (!picker) return;
  const record = await getRepo(picker.key);
  const release = pickerRelease(record);
  $("pickerTitle").textContent = `Choose asset for ${record.owner}/${record.repo}`;
  if (!release) {
    $("pickerRelease").textContent = "No release with assets found.";
    $("pickerAssets").replaceChildren();
    return;
  }
  $("pickerRelease").textContent = `From release ${release.tag} (${formatDate(release.publishedAt)}). Future releases use the same file name pattern.`;
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
      }, h("span", {}, a.name), h("span", { className: "muted" }, formatSize(a.size)))
    ),
    visible.length ? null : h("p", { className: "hint" }, "No .crx or .zip assets in this release.")
  );
}

$("pickerAll").addEventListener("change", renderPicker);
$("pickerCancel").addEventListener("click", () => {
  picker = null;
  renderPicker();
});

// ---- tracked list ----

const openDetails = new Set();

function card(v) {
  const { key, record, latest, ext, state } = v;
  const status = cardStatus.get(key) || {};
  const title = ext ? ext.name : record.repo;
  const installLabel = state === "update" ? "Update" : state === "not-installed" ? "Install" : "Reinstall";
  const canInstall = latest && latest.asset;

  const installedLine = ext
    ? `Installed ${ext.version}${ext.enabled ? "" : " (disabled)"}`
    : record.extensionId ? null : "Not linked to an extension yet";
  const latestLine = latest
    ? h("span", {}, `Latest ${latest.tag}${latest.release.prerelease ? " (pre-release)" : ""} · ${formatDate(latest.release.publishedAt)} · `,
        h("a", { href: latest.release.htmlUrl, target: "_blank" }, "notes"))
    : record.pattern ? "No release matches the pattern" : "No asset chosen";

  const details = h("details", {
    open: openDetails.has(key),
    ontoggle: (e) => (e.target.open ? openDetails.add(key) : openDetails.delete(key)),
  },
    h("summary", {}, "More"),
    h("form", {
      className: "field",
      onsubmit: (e) => {
        e.preventDefault();
        act(e.submitter, () => setPattern(key, e.target.elements.pattern.value.trim()));
      },
    },
      h("input", { type: "text", name: "pattern", value: record.pattern || "", placeholder: "Asset name regex", spellcheck: false, autocapitalize: "off" }),
      h("button", {}, "Save")),
    h("p", { className: "hint" }, "Asset file name pattern (regex)."),
    h("div", { className: "row" },
      h("button", { onclick: () => { picker = { key }; renderPicker(); $("pickerSection").scrollIntoView(); } }, "Choose asset"),
      h("button", { onclick: (e) => act(e.currentTarget, () => checkRepo(key).then(refreshBadge)) }, "Check")),
    h("label", { className: "row" },
      h("span", {}, "Include pre-releases"),
      h("input", { type: "checkbox", checked: record.includePrereleases, onchange: (e) => act(null, () => setPrereleases(key, e.target.checked)) })),
    olderReleases(key, record),
    h("p", { className: "hint" },
      `Extension ID: ${record.extensionId || "unknown"}`, h("br"),
      `Signing: ${record.keyPkcs8 ? "own key (zip assets)" : "author's key (crx assets)"}`, h("br"),
      `Checked: ${record.checkedAt ? new Date(record.checkedAt).toLocaleString() : "never"}`),
    removeControls(key, record));

  return h("article", { className: `card state-${state}${status.busy ? " busy" : ""}`, "data-key": key, "aria-busy": String(!!status.busy) },
    h("div", { className: "row" },
      h("div", { className: "title" },
        h("strong", {}, title),
        h("a", { className: "muted", href: `https://github.com/${record.owner}/${record.repo}`, target: "_blank" }, `${record.owner}/${record.repo}`)),
      h("span", { className: `state ${state}` }, STATE_LABEL[state])),
    h("div", { className: "hint" }, installedLine, installedLine ? h("br") : null, latestLine,
      latest && latest.asset ? [h("br"), `Asset ${latest.asset.name}`] : null),
    state === "ambiguous"
      ? h("div", {}, h("p", { className: "hint" }, "Pick the asset to install:"),
          latest.candidates.map((a) => h("button", { className: "asset", onclick: (e) => act(e.currentTarget, () => chooseAsset(key, a.name, latest.tag)) }, a.name)))
      : null,
    !record.pattern ? h("button", { className: "primary", onclick: () => { picker = { key }; renderPicker(); } }, "Choose asset") : null,
    record.error ? h("p", { className: "error check-error" }, record.error) : null,
    status.text ? h("p", { className: "card-status", role: "status" }, status.text) : null,
    status.error ? h("p", { className: "error card-error", role: "alert" }, status.error) : null,
    h("div", { className: "row" },
      canInstall
        ? h("button", {
            className: state === "update" || state === "not-installed" ? "primary" : "",
            onclick: () => cardAct(key, async (progress) => {
              const res = await installRelease(key, undefined, progress);
              return `Confirm the browser prompt to add ${res.name} ${res.version}.`;
            }),
          }, installLabel)
        : null),
    details);
}

function olderReleases(key, record) {
  if (!record.pattern || !record.releases) return null;
  const options = record.releases
    .filter((r) => matchAssets(r, record.pattern).length === 1)
    .map((r) => h("option", { value: r.tag }, `${r.tag}${r.prerelease ? " (pre)" : ""} · ${formatDate(r.publishedAt)}`));
  if (!options.length) return null;
  const select = h("select", {}, options);
  return h("div", { className: "field" }, select,
    h("button", {
      onclick: () => cardAct(key, async (progress) => {
        const res = await installRelease(key, select.value, progress);
        return `Confirm the browser prompt to add ${res.name} ${res.version}.`;
      }),
    }, "Install this release"));
}

function removeControls(key, record) {
  const uninstall = h("input", { type: "checkbox" });
  return h("div", { className: "row" },
    record.extensionId ? h("label", {}, uninstall, " also uninstall extension") : h("span"),
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
  $("fileKey").replaceChildren(
    h("option", { value: "" }, "a new key"),
    ...view.filter((v) => v.record.keyPkcs8).map((v) => h("option", { value: v.key }, v.key))
  );
  const { lastCheck, rateLimit } = await chrome.storage.local.get(["lastCheck", "rateLimit"]);
  $("checkInfo").textContent = lastCheck
    ? `Last check ${new Date(lastCheck.at).toLocaleString()}: ${lastCheck.updates} update(s)${lastCheck.errors.length ? `, ${lastCheck.errors.length} error(s)` : ""}`
    : "Not checked yet. Checks run every 6 hours.";
  $("rateInfo").textContent = rateLimit
    ? `GitHub API: ${rateLimit.remaining}/${rateLimit.limit} requests left, resets ${new Date(rateLimit.reset).toLocaleTimeString()}.`
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
      return errors.length ? `Check finished with errors:\n${errors.join("\n")}` : `Check finished: ${updates} update(s).`;
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
    return `Imported ${count} repo(s).${errors.length ? `\nCheck errors:\n${errors.join("\n")}` : ""}`;
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
