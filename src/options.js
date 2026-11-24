import {
  PENDING_GRACE_MS, addRepo, checkAll, checkRepo, chooseAsset, confirmIdentityChange, fileKeysView,
  importBackup, installFile, installRelease, refreshBadge, removeRepo, saveBackup, setPrereleases, setTemplate,
  trackInstalledFile, trackedView,
} from "./lib/manager.js";
import { getRepo, getSettings, setSettings } from "./lib/store.js";
import { isPackageAsset, matchAssets } from "./lib/releases.js";
import { friendly } from "./friendly.js";
import { setTheme, startTheme } from "./theme.js";

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

// Messages never float over the page. Each one shows in the flow, next to what raised it:
// - an inline status line under the control (Add, Install file, Track, token, Backup, Theme);
// - the card's own error line for a card action;
// - the status strip in the sticky header for results that belong to no control
//   (Check all, a removed repo). It pushes the page down rather than covering it.
// Messages stay until the next action in the same place (or Dismiss in the strip): nothing
// covers a control any more, so nothing has to go away on a timer, and a strip that
// collapsed on a timer would move the page under the user's finger.
// #message (status) and #messageAlert (alert) are persistent live regions; inline lines
// and card errors are announced through #announce / #announceAlert.
let stripOrigin = null; // focused when the strip message appeared; Dismiss returns focus there
function showMessage(text, isError = false, detail = "") {
  const on = !!text;
  stripOrigin = on ? document.activeElement : null;
  $("status").classList.toggle("show", on);
  $("status").classList.toggle("is-error", on && isError);
  $("messageClose").hidden = !on;
  $("message").replaceChildren(...(on && !isError ? [text] : []));
  $("messageAlert").replaceChildren(...(on && isError ? [text, detail ? h("span", { className: "detail" }, detail) : ""] : []));
}
$("messageClose").addEventListener("click", () => {
  const back = stripOrigin;
  showMessage("");
  if (back && back.isConnected && back !== document.body) back.focus({ preventScroll: true });
});

// Inline status line: slot is the id of a .inline-status element under the control.
function say(slot, text, isError = false, detail = "") {
  const el = $(slot);
  el.classList.toggle("error", !!text && isError);
  el.replaceChildren(...(text ? [text, isError && detail && detail !== text ? h("span", { className: "detail" }, detail) : ""] : []));
  if (text) announce(text, isError);
}

// The sticky header's height (it grows with the strip) keeps focus scrolling clear of it.
new ResizeObserver(([e]) =>
  document.documentElement.style.setProperty("--appbar-h", `${Math.ceil(e.target.getBoundingClientRect().height)}px`)
).observe(document.querySelector(".appbar"));

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
    const i = tabs.indexOf(t);
    const to = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: tabs.length - 1 }[e.key];
    if (to === undefined) return;
    e.preventDefault();
    selectTab(tabs[(to + tabs.length) % tabs.length], true);
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

// Screen-reader announcements for card progress and card errors: cards are
// rebuilt on each render, so their own lines are not live regions.
// Each region empties itself after a while, so browse mode does not find stale text later.
const announceTimers = {};
function announce(text, isError = false) {
  const id = isError ? "announceAlert" : "announce";
  clearTimeout(announceTimers[id]);
  $(id).textContent = text;
  if (text) announceTimers[id] = setTimeout(() => ($(id).textContent = ""), 10000);
}

// A running action marks its button aria-disabled instead of disabled, so the
// button keeps focus; the capture listener swallows clicks on it meanwhile.
const busy = (b) => b && b.getAttribute("aria-disabled") === "true";
const setBusy = (b, on) => (on ? b.setAttribute("aria-disabled", "true") : b.removeAttribute("aria-disabled"));
document.addEventListener("click", (e) => {
  const b = e.target.closest && e.target.closest("button");
  if (busy(b)) {
    e.preventDefault();
    e.stopImmediatePropagation();
  }
}, true);

// The card control that started the running action; render() puts focus back on
// it when the old element is gone (cards are rebuilt on each render).
let focusMemo = null;
function ctlOf(el) {
  const card = el && el.closest && el.closest("[data-key]");
  return card && el.dataset.ctl ? { key: card.dataset.key, ctl: el.dataset.ctl } : null;
}

// Runs a UI action: marks the button busy, reports its result where it belongs, re-renders.
// where: the id of an inline status line, { card: key } for a card's own error line, or
// omitted for the header strip. A card action's result text goes to the strip (its card
// may be gone, e.g. after Remove).
async function act(button, fn, where) {
  if (button) setBusy(button, true);
  focusMemo = ctlOf(button || document.activeElement);
  const inline = typeof where === "string" ? where : null;
  const cardKey = where && where.card;
  if (inline) say(inline, "");
  else if (cardKey) clearCardError(cardKey);
  else showMessage("");
  $("pickerError").replaceChildren();
  try {
    const msg = await fn();
    if (msg && inline) say(inline, msg);
    else if (msg) showMessage(msg);
  } catch (e) {
    console.error(e);
    const f = friendly(e);
    // The open sheet is modal: anything outside it is inert. Show the error in the sheet.
    if ($("pickerSection").open) $("pickerError").replaceChildren(f.text, h("span", { className: "detail" }, f.detail));
    else if (inline) say(inline, f.text, true, f.detail);
    else if (cardKey) {
      cardStatus.set(cardKey, { error: f });
      announce(f.text, true);
    } else showMessage(f.text, true, f.detail);
  } finally {
    if (button) setBusy(button, false);
    await render();
    focusMemo = null;
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
  "identity-change": "New extension ID",
};
// Set by the storage migration when a 0.1 regex pattern had no template form.
const isConversionError = (msg) => /could not be converted to a file name template/.test(msg || "");
const extOf = (name) => (name.match(/\.(crx|zip)$/i) || [])[1];

// Per-card progress and errors: key -> { busy, text, error: { text, detail } }.
const cardStatus = new Map();

// Runs an action of one tracked repo; its progress and errors show on the card.
// retry: the label of the button that retries it, named in download errors.
async function cardAct(key, fn, retry) {
  focusMemo = ctlOf(document.activeElement);
  const set = (s) => {
    cardStatus.set(key, s);
    if (s.text) announce(s.text);
    render();
  };
  set({ busy: true, text: "Working…" });
  try {
    const text = await fn((step) => set({ busy: true, text: step }));
    if (text) set({ text });
    else cardStatus.delete(key);
  } catch (e) {
    console.error(e);
    const error = friendly(e, { retry });
    announce(error.text, true);
    set({ error });
  }
  await render();
  focusMemo = null;
}

function clearCardError(key) {
  if (cardStatus.has(key) && !cardStatus.get(key).busy) cardStatus.delete(key);
}

// Choices typed or picked on a card, kept across renders: key -> value.
const templateDraft = new Map();
const releaseChoice = new Map();
const uninstallChoice = new Map();
// Remove with uninstall and a signing key needs a second tap: key -> timer.
const removeArmed = new Map();

// ---- asset picker ----

let picker = null; // { key }

function pickerRelease(record) {
  const releases = (record.releases || [])
    .filter((r) => record.includePrereleases || !r.prerelease)
    .sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt));
  return releases.find((r) => r.assets.some((a) => isPackageAsset(a.name))) || releases.find((r) => r.assets.length) || null;
}

// The picker is a modal bottom sheet; focus returns to the control that opened it.
// opener: the element focused when the sheet opened; openerMemo finds the same control
// on its rebuilt card when the original element is gone.
let pickerOpener = null;
let openerMemo = null;
function queuePicker(key, opener = document.activeElement) {
  pickerOpener = opener;
  openerMemo = ctlOf(opener);
  picker = { key };
}
function openPicker(key) {
  queuePicker(key);
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
  $("pickerRelease").textContent = `Release ${release.tag} · ${formatDate(release.publishedAt)}. Later releases use the same file name template.`;
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
  if (!sheet.open) {
    $("pickerError").replaceChildren();
    sheet.showModal();
  }
}

$("pickerAll").addEventListener("change", renderPicker);
$("pickerCancel").addEventListener("click", () => {
  picker = null;
  renderPicker();
});
$("pickerSection").addEventListener("close", () => {
  picker = null;
  $("pickerSection").hidden = true;
  // A chosen asset can remove the opener (Choose asset is primary only without a template):
  // then the card's install button, else its More.
  const card = openerMemo && $("list").querySelector(`[data-key="${CSS.escape(openerMemo.key)}"]`);
  const again = card && (card.querySelector(`[data-ctl="${CSS.escape(openerMemo.ctl)}"]`) || card.querySelector('[data-ctl="install"], [data-ctl="more"]'));
  const target = pickerOpener && pickerOpener.isConnected ? pickerOpener : again;
  if (target) target.focus();
  pickerOpener = null;
  openerMemo = null;
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

// The identity-change notice: the release installs under another extension ID.
function identityNotice(key, change, title) {
  return h("div", { className: "notice" },
    h("p", {}, h("strong", {}, `${change.tag || change.asset} installs as a separate extension.`),
      " Its settings and data will not carry over from the installed one."),
    h("dl", { className: "facts" },
      h("dt", {}, "Current ID"), h("dd", {}, change.from),
      h("dt", {}, "New ID"), h("dd", {}, change.to),
      h("dt", {}, "Asset"), h("dd", {}, change.asset)),
    h("p", { className: "hint" }, "To keep the current extension, turn off pre-releases or choose another asset under More."),
    h("div", { className: "card-actions" },
      h("button", { "data-ctl": "identity", "aria-label": `Use the new ID for ${title}`, onclick: () => cardAct(key, async () => { await confirmIdentityChange(key); }) }, "Use the new ID")));
}

// Install handed to the browser and not confirmed yet. After the grace period
// the prompt was most likely dismissed; the entry stays until the lib forgets it.
const isWaiting = (pending) => Date.now() - pending.at < PENDING_GRACE_MS;
function pendingLine(pending) {
  if (isWaiting(pending)) {
    return h("p", { className: "card-status" }, h("span", { className: "spinner", "aria-hidden": "true" }),
      `Waiting for the browser to confirm ${pending.version}…`);
  }
  return h("p", { className: "card-status" },
    `The browser has not confirmed ${pending.version}. If you dismissed the prompt, install again.`);
}

// An error with its raw message as a small secondary line.
const errorLine = (className, { text, detail }) =>
  h("p", { className: `error ${className}` }, text, detail && detail !== text ? h("span", { className: "detail" }, detail) : null);

function card(v) {
  const { key, record, latest, ext, state, pendingInstall } = v;
  const status = cardStatus.get(key) || {};
  const title = ext ? ext.name : record.repo;
  const name = `${record.owner}/${record.repo}`;
  const titleId = `title-${key}`;
  const installLabel = state === "update" ? "Update" : state === "not-installed" ? "Install" : "Reinstall";
  const identity = state === "identity-change";
  const canInstall = latest && latest.asset && !identity;
  // A migration that could not convert the pattern asks for the asset again: a
  // to-do on the "No asset" card, not a failed check. Once a template is set it is stale.
  const converted = isConversionError(record.error);
  const checkError = converted ? null : record.error;
  const failed = !!checkError;

  const installed = ext
    ? h("dd", {}, ext.version, ext.enabled ? null : h("span", { className: "sub" }, "disabled"))
    : h("dd", {}, record.extensionId ? "Not installed" : "Not linked yet");
  const latestDd = latest
    ? h("dd", {}, latest.tag,
        h("span", { className: "sub" },
          formatDate(latest.release.publishedAt), latest.release.prerelease ? " · pre-release" : "", " · ",
          h("a", { className: "notes", href: latest.release.htmlUrl, target: "_blank", rel: "noopener", "data-ctl": "notes", "aria-label": `notes for ${title} ${latest.tag}` }, "notes")))
    : h("dd", {}, "—", h("span", { className: "sub" },
        !record.releases ? "No release data yet" : record.template ? "No release matches the template" : "No asset chosen"));

  const templateInput = h("input", {
    type: "text", id: `template-${key}`, name: "template", "data-ctl": "template", defaultValue: record.template || "",
    placeholder: "name-{version}.zip", spellcheck: false, autocapitalize: "off", autocomplete: "off", "aria-describedby": `template-hint-${key}`,
    oninput: (e) => templateDraft.set(key, e.target.value),
  });
  // Typed text survives renders, also when the lib rejects the template.
  if (templateDraft.has(key)) templateInput.value = templateDraft.get(key);

  const details = h("details", {
    open: openDetails.has(key),
    ontoggle: (e) => (e.target.open ? openDetails.add(key) : openDetails.delete(key)),
  },
    h("summary", { "data-ctl": "more", "aria-label": `More for ${title}` }, h("span", {}, "More"), svg(CHEVRON)),
    h("div", { className: "more" },
      h("div", { className: "card-actions" },
        h("button", { "data-ctl": "choose", "aria-label": `Choose asset for ${title}`, onclick: () => openPicker(key) }, "Choose asset"),
        h("button", { "data-ctl": "check", "aria-label": `Check ${title}`, onclick: (e) => act(e.currentTarget, () => checkRepo(key).then(refreshBadge).catch((err) => {
          // checkRepo stores the error on the record, so the card's check-error line shows it.
          announce(friendly(err, { retry: "Check" }).text, true);
        }), { card: key }) }, "Check")),
      h("form", {
        onsubmit: (e) => {
          e.preventDefault();
          // Errors (e.g. an invalid template) show on this card.
          const template = e.target.elements.template.value.trim();
          cardAct(key, async () => {
            await setTemplate(key, template);
            templateDraft.delete(key);
          });
        },
      },
        h("label", { className: "group-label", htmlFor: `template-${key}` }, "Asset file name template"),
        h("div", { className: "field" },
          templateInput,
          h("button", { "data-ctl": "save", "aria-label": `Save template for ${title}` }, "Save")),
        h("p", { className: "hint field-hint", id: `template-hint-${key}` }, "Use {version} for the version and * for any text.")),
      h("label", { className: "switch" },
        h("input", { type: "checkbox", "data-ctl": "pre", checked: record.includePrereleases, onchange: (e) => act(null, () => setPrereleases(key, e.target.checked), { card: key }) }),
        h("span", {}, "Include pre-releases")),
      identity ? null : olderReleases(key, record, title),
      h("dl", { className: "facts" },
        h("dt", {}, "Extension ID"), h("dd", {}, record.extensionId || "unknown"),
        h("dt", {}, "Signing"), h("dd", {}, v.hasKey ? "own key (zip assets)" : "author's key (crx assets)"),
        latest && latest.asset ? [h("dt", {}, "Asset"), h("dd", {}, latest.asset.name)] : null,
        h("dt", {}, "Checked"), h("dd", {}, record.checkedAt ? new Date(record.checkedAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "never")),
      removeControls(key, record, v.hasKey, name, title)));

  return h("article", { className: `card state-${state}${status.busy ? " busy" : ""}`, "data-key": key, "aria-busy": String(!!status.busy), "aria-labelledby": titleId },
    h("div", { className: "card-head" },
      avatar(record, ext),
      h("div", { className: "title" },
        h("h3", { id: titleId }, title),
        h("a", { href: `https://github.com/${name}`, target: "_blank", rel: "noopener", "data-ctl": "repo" }, name),
        h("span", { className: `state ${state}${failed ? " failed" : ""}` }, failed ? "Error" : STATE_LABEL[state]))),
    h("dl", { className: "versions" },
      h("div", { className: "installed" }, h("dt", {}, "Installed"), installed),
      h("div", { className: "latest" }, h("dt", {}, "Latest"), latestDd)),
    state === "ambiguous"
      ? h("div", { className: "candidates" }, h("p", { className: "meta" }, "Several assets match. Pick the one to install:"),
          latest.candidates.map((a) => h("button", { className: "asset", "data-ctl": `asset-${a.name}`, onclick: (e) => act(e.currentTarget, () => chooseAsset(key, a.name, latest.tag), { card: key }) },
            h("span", { className: "name" }, extOf(a.name) ? h("span", { className: "kind" }, extOf(a.name)) : null, a.name),
            h("span", { className: "muted" }, formatSize(a.size)))))
      : null,
    converted && !record.template ? h("p", { className: "notice" }, record.error) : null,
    identity ? identityNotice(key, record.identityChange, title) : null,
    checkError ? errorLine("check-error", friendly(checkError, { retry: "Check" })) : null,
    status.text ? h("p", { className: "card-status" }, status.busy ? h("span", { className: "spinner", "aria-hidden": "true" }) : null, status.text) : null,
    !status.busy && !status.text && pendingInstall ? pendingLine(pendingInstall) : null,
    status.error ? errorLine("card-error", status.error) : null,
    !record.template || canInstall
      ? h("div", { className: "card-actions" },
          !record.template ? h("button", { className: "primary", "data-ctl": "choose-main", "aria-label": `Choose asset for ${title}`, onclick: () => openPicker(key) }, "Choose asset") : null,
          canInstall
            ? h("button", {
                className: state === "update" || state === "not-installed" ? "primary" : "",
                "data-ctl": "install", "aria-label": `${installLabel} ${title}`,
                // The card then shows the pending install until the browser confirms it.
                onclick: () => cardAct(key, (progress) => installRelease(key, undefined, progress).then(() => null), installLabel),
              }, installLabel)
            : null)
      : null,
    details);
}

function olderReleases(key, record, title) {
  if (!record.template || !record.releases) return null;
  const options = record.releases
    .filter((r) => matchAssets(r, record.template).length === 1)
    .map((r) => h("option", { value: r.tag }, `${r.tag}${r.prerelease ? " (pre)" : ""} · ${formatDate(r.publishedAt)}`));
  if (!options.length) return null;
  const select = h("select", { id: `release-${key}`, "data-ctl": "release", onchange: () => releaseChoice.set(key, select.value) }, options);
  // The choice survives renders while that release is still listed.
  if (options.some((o) => o.value === releaseChoice.get(key))) select.value = releaseChoice.get(key);
  return h("div", {},
    h("label", { className: "group-label", htmlFor: `release-${key}` }, "Install a specific release"),
    h("div", { className: "field" }, select,
      h("button", {
        "data-ctl": "release-install", "aria-label": `Install selected release of ${title}`,
        onclick: () => cardAct(key, (progress) => installRelease(key, select.value, progress).then(() => null), "Install"),
      }, "Install")));
}

// What Remove does, for the current state of the uninstall switch.
function removeText(uninstall, hasKey) {
  if (uninstall) {
    return hasKey
      ? "Remove uninstalls the extension. Its signing key is deleted once no install waiting at the browser prompt uses it, within about 2 minutes. Installing it again later gives it a new ID and none of its data."
      : "Remove uninstalls the extension and stops tracking the repo.";
  }
  return hasKey
    ? "Remove stops tracking. The extension stays installed, and its signing key is kept: adding the repo again installs updates under the same ID, and exports still include the key."
    : "Remove stops tracking. The extension stays installed.";
}

const ARM_MS = 6000;
function disarm(key) {
  clearTimeout(removeArmed.get(key));
  removeArmed.delete(key);
}

function removeControls(key, record, hasKey, name, title) {
  const id = `remove-hint-${key}`;
  const canUninstall = !!record.extensionId;
  const checked = canUninstall && !!uninstallChoice.get(key);
  const hint = h("p", { className: "hint", id }, removeText(checked, hasKey));
  const label = () => (removeArmed.has(key) ? "Tap again to delete the key" : uninstall.checked ? "Remove and uninstall" : "Remove");
  const sync = () => {
    button.textContent = label();
    button.setAttribute("aria-label", `${label()}, ${title}`);
    hint.textContent = removeText(uninstall.checked, hasKey);
  };
  const uninstall = h("input", {
    type: "checkbox", "data-ctl": "uninstall", checked, "aria-describedby": id,
    onchange: () => {
      uninstallChoice.set(key, uninstall.checked);
      disarm(key);
      sync();
    },
  });
  const button = h("button", {
    className: "danger", "data-ctl": "remove", "aria-describedby": id,
    onclick: (e) => {
      if (uninstall.checked && hasKey && !removeArmed.has(key)) {
        // Deleting the key cannot be undone: a second tap confirms. A confirm()
        // would use up the user gesture chrome.management.uninstall needs.
        removeArmed.set(key, setTimeout(() => {
          removeArmed.delete(key);
          if (button.isConnected) sync();
        }, ARM_MS));
        sync();
        announce("Tap again to delete the key.");
        return;
      }
      disarm(key);
      announce(""); // drop "Tap again to delete the key." once the second tap is in
      act(e.currentTarget, async () => {
        // With uninstall, the browser's own dialog confirms.
        if (!uninstall.checked && !confirm(`Remove ${name}?\n\n${removeText(false, hasKey)}`)) return;
        await removeRepo(key, uninstall.checked);
        uninstallChoice.delete(key);
        return `Removed ${name}.`;
      }, { card: key });
    },
  });
  sync();
  return h("div", { className: "remove" },
    h("div", { className: "remove-row" },
      canUninstall ? h("label", { className: "switch" }, uninstall, h("span", {}, "Also uninstall the extension")) : h("span"),
      button),
    hint);
}

let rendering = Promise.resolve();
function render() {
  rendering = rendering.then(renderNow, renderNow);
  return rendering;
}

// Re-renders when the first pending install passes the grace period, so its
// line switches from "Waiting…" to "not confirmed" without another event.
let graceTimer = 0;
let rateTimer = 0;

function scheduleGrace(view) {
  clearTimeout(graceTimer);
  const due = view
    .filter((v) => v.pendingInstall && isWaiting(v.pendingInstall))
    .map((v) => v.pendingInstall.at + PENDING_GRACE_MS - Date.now());
  if (due.length) graceTimer = setTimeout(render, Math.max(0, Math.min(...due)) + 50);
}

// "Sign a .zip with the key of": a new key, a tracked repo's key, or the key of an
// extension installed from a file without a repo. The choice survives re-renders
// while it is still listed.
function renderKeyChoice(view, fileKeys) {
  const select = $("fileKey");
  const chosen = select.value;
  const repoKeys = view.filter((v) => v.hasKey).map((v) => h("option", { value: v.key }, `${v.record.owner}/${v.record.repo}`));
  const files = fileKeys.map((f) => h("option", { value: f.value },
    f.name ? `${f.name} ${f.version} · ${f.extensionId}` : `Not installed · ${f.extensionId}`));
  select.replaceChildren(
    h("option", { value: "" }, "a new key"),
    // Grouped only next to file keys; alone, the repo options are listed directly.
    ...(files.length && repoKeys.length ? [h("optgroup", { label: "Tracked repos" }, repoKeys)] : repoKeys),
    ...(files.length ? [h("optgroup", { label: "Installed from a file" }, files)] : [])
  );
  select.value = [...select.options].some((o) => o.value === chosen) ? chosen : "";
}

async function renderNow() {
  const view = await trackedView();
  // Cards are rebuilt; focus goes back to the same control of the same card.
  const active = document.activeElement;
  const memo = ctlOf(active) || (!active || active === document.body ? focusMemo : null);
  $("list").replaceChildren(...view.map(card));
  // Busy cards keep their buttons focusable; the click guard ignores them.
  for (const b of $("list").querySelectorAll(".card.busy button")) setBusy(b, true);
  if (memo && !(active && active.isConnected)) {
    const el = $("list").querySelector(`[data-key="${CSS.escape(memo.key)}"] [data-ctl="${CSS.escape(memo.ctl)}"]`);
    if (el) el.focus({ preventScroll: true });
  }
  scheduleGrace(view);
  $("empty").hidden = view.length > 0;
  const updates = view.filter((v) => v.state === "update").length;
  $("updateCount").hidden = !updates;
  $("updateCount").textContent = plural(updates, "update", "updates");
  renderKeyChoice(view, await fileKeysView());
  const { lastCheck, rateLimit } = await chrome.storage.local.get(["lastCheck", "rateLimit"]);
  $("checkInfo").textContent = lastCheck
    ? `Last checked ${new Date(lastCheck.at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}${lastCheck.errors.length ? ` · ${plural(lastCheck.errors.length, "error", "errors")}` : ""}`
    : "Not checked yet. Checks run every 6 hours.";
  // After the reset time the stored count is stale: say so, and re-render at the reset.
  clearTimeout(rateTimer);
  const resetAt = rateLimit && new Date(rateLimit.reset).toLocaleTimeString(undefined, { timeStyle: "short" });
  $("rateInfo").textContent = !rateLimit
    ? ""
    : rateLimit.reset > Date.now()
      ? `GitHub API: ${rateLimit.remaining}/${rateLimit.limit} requests left, resets ${resetAt}.`
      : `GitHub API: the limit reset at ${resetAt}; ${rateLimit.limit} requests per hour are available again.`;
  if (rateLimit && rateLimit.reset > Date.now()) rateTimer = setTimeout(render, Math.min(rateLimit.reset - Date.now() + 1000, 2 ** 31 - 1));
  await renderPicker();
}

// ---- top-level actions ----

$("checkAll").addEventListener("click", (e) =>
  act(e.currentTarget, async () => {
    document.body.classList.add("checking");
    $("checkAll").textContent = "Checking…";
    try {
      const { updates, errors } = await checkAll();
      if (errors.length) {
        showMessage(`Check finished: ${plural(errors.length, "error", "errors")}. See the cards marked Error.`, true);
        return;
      }
      return `Check finished: ${plural(updates, "update", "updates")}.`;
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
    queuePicker(key, $("addInput"));
  }, "addStatus");
});

let fileResult = null;
$("fileInstall").addEventListener("click", (e) =>
  act(e.currentTarget, async () => {
    const file = $("fileInput").files[0];
    if (!file) {
      say("fileStatus", "Choose a .crx or .zip file first.", true);
      return;
    }
    const signWith = $("fileKey").value || null;
    const res = await installFile(new Uint8Array(await file.arrayBuffer()), file.name, signWith);
    // A zip installed without a repo keeps its key in the file-key store; tracking takes it
    // from there, so the page does not hold on to the private key.
    fileResult = res.repoKey ? res : { ...res, keyPkcs8: null };
    $("fileTrack").hidden = !!res.repoKey; // a CRX is never attached to the selected repo
    $("fileResult").textContent = `${res.name} ${res.installed.version} → ID ${res.extensionId}.`;
    return "Confirm the browser prompt to add the extension.";
  }, "fileStatus")
);

$("fileTrackForm").addEventListener("submit", (e) => {
  e.preventDefault();
  act(e.submitter, async () => {
    const key = await trackInstalledFile($("fileTrackInput").value, fileResult);
    $("fileTrack").hidden = true;
    $("fileTrackInput").value = "";
    queuePicker(key, $("fileInstall"));
    // The Track form is gone now: the result shows under Install file.
    say("fileStatus", `Tracking ${key}. Choose the release asset to follow.`);
  }, "trackStatus");
});

getSettings().then((s) => ($("token").value = s.githubToken));

startTheme({ observe: true }).then((theme) => ($("theme").value = theme));
$("theme").addEventListener("change", (e) => act(null, () => setTheme(e.target.value), "themeStatus"));
$("tokenForm").addEventListener("submit", (e) => {
  e.preventDefault();
  act(e.submitter, async () => {
    await setSettings({ githubToken: $("token").value.trim() });
    return "Token saved.";
  }, "tokenStatus");
});

$("export").addEventListener("click", (e) =>
  act(e.currentTarget, async () => {
    const day = new Date().toISOString().slice(0, 10);
    // Resolves once the file is written, or with the reason it was not (the browser may
    // first ask where to save). A failure to start the download throws.
    const { saved, error } = await saveBackup(`extainium-backup-${day}.json`);
    if (!saved) {
      say("backupStatus", "The backup was not saved. Tap Export to try again.", true, error);
      return;
    }
    return "Backup saved to Downloads. It contains signing keys.";
  }, "backupStatus")
);
$("import").addEventListener("click", () => $("importInput").click());
$("importInput").addEventListener("change", (e) =>
  act(null, async () => {
    const file = e.target.files[0];
    e.target.value = "";
    if (!file) return;
    $("importResult").replaceChildren();
    const res = await importBackup(await file.text());
    await showImportResult(res); // shown under the Import button
  }, "backupStatus")
);

// Conflicts, warnings and check errors of the last import stay under Backup
// until the next import.
async function showImportResult({ count, errors, conflicts, warnings }) {
  // Conflicts carry the lowercase storage key; show owner/repo as written.
  const names = new Map((await trackedView()).map((v) => [v.key, `${v.record.owner}/${v.record.repo}`]));
  const box = (title, items, className = "notice") =>
    h("div", { className }, h("strong", {}, title), h("ul", {}, items.map((t) => h("li", {}, t))));
  const errorItem = (e) => {
    const f = friendly(e);
    return [f.text, h("span", { className: "detail" }, f.detail)];
  };
  const parts = [
    conflicts.length
      ? box(`Kept the current signing key for ${plural(conflicts.length, "repo", "repos")}`,
          conflicts.map((c) => `${names.get(c.key) || c.key}: kept ID ${c.keptId}. The backup had another key (ID ${c.backupId}), which was not imported.`))
      : null,
    warnings.length ? box(plural(warnings.length, "warning", "warnings"), warnings) : null,
    errors.length
      ? box(`${plural(errors.length, "repo", "repos")} could not be checked`, errors.map(errorItem), "error error-list")
      : null,
  ].filter(Boolean);
  $("importResult").replaceChildren(
    h("p", { className: "result-title" }, `Imported ${plural(count, "repo", "repos")}`, parts.length ? null : h("span", { className: "muted" }, " · no key conflicts")),
    ...parts);
}

// Re-render on background changes, but not while the user types in the list.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  const typing = document.activeElement && document.activeElement.matches("#list input[type=text]");
  if (!typing) render();
});
chrome.management.onInstalled.addListener(() => render());
chrome.management.onUninstalled.addListener(() => render());

render();
