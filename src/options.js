import {
  PENDING_GRACE_MS, addRepo, checkAll, checkRepo, chooseAsset, confirmIdentityChange, dismissInstallBlocked, environment, fileKeysView, forgetFileKey,
  handOffState, importBackup, installFile, installRelease, installedOverview, isPromptWaiting, linkInstalledToGithub, refreshBadge,
  removeRepo, saveBackup, setGithubToken, setPrereleases, setTemplate, trackInstalled, trackInstalledFile, trackedView,
  whenQueued,
} from "./lib/manager.js";
import { getRepo, getSettings } from "./lib/store.js";
import { isPackageAsset, matchAssets } from "./lib/releases.js";
import { friendly } from "./friendly.js";
import { addOrigins, askOrigins, cardId, checkLine, hostOf, isConversionError, offersInstall, plural } from "./ui-logic.js";
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
const tabs = [$("tabList"), $("tabInstalled"), $("tabTools")];
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

// Operations run one at a time across Extainium (this page, another page, the
// background check). An action whose operation has to wait says so where its
// result will show, until it runs.
const WAITING = "Waiting for another action…";

// Runs a UI action: marks the button busy, reports its result where it belongs, re-renders.
// where: the id of an inline status line, { card: key } for a card's own error line, or
// omitted for the header strip. A card action's result text goes to the strip (its card
// may be gone, e.g. after Remove). fn(wait) starts its operation synchronously, or, after
// an await, through whenQueued(wait, () => operation(...)), so a wait is shown.
async function act(button, fn, where) {
  if (button) setBusy(button, true);
  focusMemo = ctlOf(button || document.activeElement);
  const inline = typeof where === "string" ? where : null;
  const cardKey = where && where.card;
  if (inline) say(inline, "");
  else if (cardKey) clearCardError(cardKey);
  else showMessage("");
  $("pickerError").replaceChildren();
  if (inline === "fileStatus") watchFileInstall(null);
  const wait = () => {
    if (inline) say(inline, WAITING);
    else if (cardKey) {
      cardStatus.set(cardKey, { busy: true, text: WAITING });
      render();
    } else showMessage(WAITING);
    return () => {
      if (inline) say(inline, "");
      else if (cardKey) {
        cardStatus.delete(cardKey);
        render();
      } else showMessage("");
    };
  };
  try {
    const msg = await whenQueued(wait, () => fn(wait));
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
const formatSize = (n) => (n >= 1048576 ? (n / 1048576).toFixed(1) + " MB" : Math.ceil(n / 1024) + " KB");

const STATE_LABEL = {
  "no-asset": "No asset",
  ambiguous: "Ambiguous asset",
  "not-installed": "Not installed",
  update: "Update available",
  current: "Up to date",
  unknown: "Version unknown",
  "not-offered": "Not offered",
  "identity-change": "New extension ID",
  waiting: "Waiting for Chromium",
};
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
  const wait = () => {
    set({ busy: true, text: WAITING });
    return () => set({ busy: true, text: "Working…" });
  };
  try {
    const text = await whenQueued(wait, () => fn((step) => set({ busy: true, text: step })));
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

// chrome.permissions.request needs the user gesture: call this synchronously in the click
// handler, before any await, and await the promise it returns inside the action.
// origins: the lib's needsOrigins for the record or the installed extension ([] when granted).
// required: a decline rejects (see askOrigins in ui-logic.js).
const requestOrigins = (origins, required) => askOrigins((req) => chrome.permissions.request(req), origins, { required });

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

const extIcon = (ext) => (ext && ext.icons && ext.icons.length ? [...ext.icons].sort((a, b) => b.size - a.size)[0].url : null);

// GitHub cards show the owner's picture with the extension icon as a corner badge; store and
// self-hosted cards have no owner picture, so the extension's own icon is the main image.
function avatar(v) {
  const { record, ext } = v;
  if ((v.source || "github") !== "github") {
    const icon = extIcon(ext);
    const initial = h("span", { className: "fallback", hidden: !!icon, "aria-hidden": "true" }, (v.title || "?").slice(0, 1));
    const img = icon ? h("img", { className: "owner", alt: "", width: 48, height: 48, src: icon, onerror: () => { img.hidden = true; initial.hidden = false; } }) : null;
    return h("div", { className: "avatar" }, img, initial);
  }
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

// A hand-off whose copy vanished without an install event (the lib's "waiting"):
// Chromium may apply it later, or the prompt was cancelled or the install failed.
const waitingText = (name, version) =>
  `If you clicked Add, Chromium applies ${version} when ${name} restarts, at the latest after a browser restart. If you cancelled, install again.`;

// Install handed to the browser and not confirmed yet. Its copy vanished
// (pending.waiting): tentative, says so. Otherwise, after the grace period from
// its prompt (the lib's clock, isPromptWaiting) the prompt was most likely
// dismissed; the entry stays until the lib forgets it.
function pendingLine(pending, title) {
  if (pending.waiting) return h("p", { className: "card-status" }, waitingText(title, pending.version));
  if (isPromptWaiting(pending)) {
    return h("p", { className: "card-status" }, h("span", { className: "spinner", "aria-hidden": "true" }),
      `Waiting for the browser to confirm ${pending.version}…`);
  }
  return h("p", { className: "card-status" },
    `The browser has not confirmed ${pending.version}. If you dismissed the prompt, install again.`);
}

// An error with its raw message as a small secondary line.
const errorLine = (className, { text, detail }) =>
  h("p", { className: `error ${className}` }, text, detail && detail !== text ? h("span", { className: "detail" }, detail) : null);

const STORE_LINK = { cws: "Store page", updateUrl: "Update feed" };
const checkedAt = (record) => (record.checkedAt ? new Date(record.checkedAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "never");

function card(v) {
  const { key, record, latest, ext, state, pendingInstall } = v;
  const status = cardStatus.get(key) || {};
  // github: a release asset with a template; cws, updateUrl: one CRX per version, no asset controls.
  const github = (v.source || "github") === "github";
  const title = ext ? ext.name : github ? record.repo : v.title;
  const name = github ? `${record.owner}/${record.repo}` : title;
  const needs = v.needsOrigins || [];
  const titleId = `title-${key}`;
  const installLabel = state === "update" ? "Update" : state === "not-installed" ? "Install" : state === "waiting" ? "Install again" : "Reinstall";
  const identity = state === "identity-change";
  // The lib's canInstall: a downloadable build (a self-hosted "noupdate" has none).
  const canInstall = offersInstall(v);
  // A migration that could not convert the pattern asks for the asset again: a
  // to-do on the "No asset" card, not a failed check. Once a template is set it is stale.
  const converted = isConversionError(record.error);
  const checkError = converted ? null : record.error;
  const failed = !!checkError;

  const installed = ext
    ? h("dd", {}, ext.version, ext.enabled ? null : h("span", { className: "sub" }, "disabled"))
    : h("dd", {}, record.extensionId ? "Not installed" : "Not linked yet");
  const latestDd = !github
    ? latest
      ? h("dd", {}, latest.version, latest.size ? h("span", { className: "sub" }, formatSize(latest.size)) : null)
      : h("dd", {}, "—", h("span", { className: "sub" },
          state === "not-offered"
            ? record.unavailable && record.unavailable.malware ? "Not offered: the store flags it as malware" : "Not offered to this browser"
            : record.checkedAt ? "No version found" : "Not checked yet"))
    : latest
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

  // Check (and Allow access) first ask for the hosts the record still needs, in the click
  // itself; declined, the check still runs and its error says what is needed now.
  const check = (e) => {
    const asked = requestOrigins(needs, false);
    act(e.currentTarget, async () => {
      await asked;
      await checkRepo(key).then(refreshBadge).catch((err) => {
        // checkRepo stores the error on the record, so the card's check-error line shows it.
        announce(friendly(err, { retry: "Check" }).text, true);
      });
    }, { card: key });
  };
  const checkButton = h("button", { "data-ctl": "check", "aria-label": `Check ${title}`, onclick: check }, "Check");
  const summary = h("summary", { "data-ctl": "more", "aria-label": `More for ${title}` }, h("span", {}, "More"), svg(CHEVRON));
  const detailsProps = {
    open: openDetails.has(key),
    ontoggle: (e) => (e.target.open ? openDetails.add(key) : openDetails.delete(key)),
  };

  const details = !github
    ? h("details", detailsProps, summary,
        h("div", { className: "more" },
          h("div", { className: "card-actions" }, checkButton),
          h("dl", { className: "facts" },
            h("dt", {}, "Source"), h("dd", {}, v.sourceLabel),
            h("dt", {}, "Extension ID"), h("dd", {}, record.extensionId || record.id || "unknown"),
            v.source === "updateUrl" ? [h("dt", {}, "Update URL"), h("dd", {}, v.sourceUrl)] : null,
            h("dt", {}, "Checked"), h("dd", {}, checkedAt(record))),
          removeControls(key, record, false, name, title)))
    : h("details", detailsProps, summary,
    h("div", { className: "more" },
      h("div", { className: "card-actions" },
        h("button", { "data-ctl": "choose", "aria-label": `Choose asset for ${title}`, onclick: () => openPicker(key) }, "Choose asset"),
        checkButton),
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
        h("dt", {}, "Checked"), h("dd", {}, checkedAt(record))),
      removeControls(key, record, v.hasKey, name, title)));

  // id: the Installed tab's "Tracked" link targets the card.
  return h("article", { className: `card state-${state}${status.busy ? " busy" : ""}`, id: cardId(key), tabIndex: -1, "data-key": key, "aria-busy": String(!!status.busy), "aria-labelledby": titleId },
    h("div", { className: "card-head" },
      avatar(v),
      h("div", { className: "title" },
        h("h3", { id: titleId }, title),
        h("p", { className: "source-line" },
          h("span", { className: "source" }, v.sourceLabel || "GitHub"),
          h("a", { href: github ? `https://github.com/${name}` : v.sourceUrl, target: "_blank", rel: "noopener", "data-ctl": "repo",
            "aria-label": github ? null : `${STORE_LINK[v.source]} of ${title}` }, github ? name : STORE_LINK[v.source])),
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
    needs.length
      ? h("div", { className: "notice" },
          h("p", {}, `Extainium needs access to ${needs.map(hostOf).join(", ")} to check ${title} for updates.`),
          h("div", { className: "card-actions" },
            h("button", { "data-ctl": "grant", "aria-label": `Allow access for ${title}`, onclick: check }, "Allow access")))
      : null,
    checkError ? errorLine("check-error", friendly(checkError, { retry: "Check" })) : null,
    status.text ? h("p", { className: "card-status" }, status.busy ? h("span", { className: "spinner", "aria-hidden": "true" }) : null, status.text) : null,
    !status.busy && !status.text && pendingInstall ? pendingLine(pendingInstall, title) : null,
    status.error ? errorLine("card-error", status.error) : null,
    (github && !record.template) || canInstall
      ? h("div", { className: "card-actions" },
          github && !record.template ? h("button", { className: "primary", "data-ctl": "choose-main", "aria-label": `Choose asset for ${title}`, onclick: () => openPicker(key) }, "Choose asset") : null,
          canInstall
            ? h("button", {
                className: state === "update" || state === "not-installed" ? "primary" : "",
                "data-ctl": "install", "aria-label": `${installLabel} ${title}`,
                // The card then shows the pending install until the browser confirms it.
                onclick: () => {
                  const asked = requestOrigins(needs, false);
                  cardAct(key, async (progress) => {
                    await asked;
                    await installRelease(key, undefined, progress);
                    return null;
                  }, installLabel);
                },
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
      : "Remove uninstalls the extension and stops tracking it.";
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
  const canUninstall = !!(record.extensionId || record.id);
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

// ---- Installed tab ----
// Every installed extension, grouped by kind, each row with one action: Track (store or own
// update server), Link a GitHub repo (no update source), a link to its card (tracked), or
// none (provided by the browser).

let env = { platform: "android", installNeedsFlag: false }; // replaced by environment() at start
const installedStatus = new Map(); // extension id -> { busy, text, error }
const linkOpen = new Set(); // ids whose "Link a GitHub repo" form is open
const linkDraft = new Map(); // id -> typed text, kept across renders

const GROUPS = [
  ["cws", "Chrome Web Store"],
  ["selfUpdating", "Updated from their own server"],
  ["unmanaged", "No update source"],
  ["tracked", "Tracked by Extainium"],
  ["browser", "Provided by the browser"],
];
// Group hints only where they add a fact the rows do not show.
function groupHint(kind) {
  const selfUpdates = env.platform !== "desktop";
  if (kind === "cws" || kind === "selfUpdating") {
    return selfUpdates
      ? "The browser updates these itself. Track one to see its updates in Extainium too."
      : "This browser does not update these. Track one to get its updates.";
  }
  if (kind === "unmanaged") return "Link the GitHub repo that publishes one to get its updates.";
  if (kind === "browser") return "Installed by the browser or by policy. Extainium cannot update them.";
  return null;
}
const BROWSER_SOURCE = { admin: "Installed by policy", sideload: "Installed by another program" };

function installedSource(x, tracked) {
  if (x.kind === "tracked") return (tracked && tracked.sourceLabel) || "Tracked";
  if (x.kind === "cws") return "Chrome Web Store";
  if (x.kind === "selfUpdating") return x.updateHost || "Own update server";
  if (x.kind === "unmanaged") return "No update source";
  return BROWSER_SOURCE[x.installType] || "Part of the browser";
}

function showCard(key) {
  selectTab($("tabList"));
  const el = document.getElementById(cardId(key));
  if (el) {
    el.scrollIntoView({ block: "start" });
    el.focus({ preventScroll: true });
  }
}

// Runs an action of one installed row; its result shows under the row (the row moves to
// "Tracked by Extainium" after Track, and keeps its status there).
async function rowAct(id, button, fn) {
  setBusy(button, true);
  installedStatus.set(id, { busy: true, text: "Working…" });
  await renderInstalledNow();
  const wait = () => {
    installedStatus.set(id, { busy: true, text: WAITING });
    renderInstalledNow();
    return () => installedStatus.set(id, { busy: true, text: "Working…" });
  };
  try {
    const text = await whenQueued(wait, fn);
    installedStatus.set(id, { text });
    announce(text);
  } catch (e) {
    console.error(e);
    const error = friendly(e);
    installedStatus.set(id, { error });
    announce(error.text, true);
  }
  setBusy(button, false);
  await render();
}

function installedRow(x, trackedByKey) {
  const tracked = x.trackedKey ? trackedByKey.get(x.trackedKey) : null;
  const status = installedStatus.get(x.id) || {};
  const icon = x.icon;
  const initial = h("span", { className: "fallback", hidden: !!icon, "aria-hidden": "true" }, (x.name || "?").slice(0, 1));
  const img = icon ? h("img", { className: "icon", alt: "", width: 32, height: 32, src: icon, onerror: () => { img.hidden = true; initial.hidden = false; } }) : null;
  const nameId = `ext-name-${x.id}`;

  let action = null;
  if (x.kind === "tracked" && x.trackedKey) {
    action = h("a", {
      className: "row-link", href: `#${cardId(x.trackedKey)}`, "data-ctl": "open", "aria-label": `Tracked: show the card of ${x.name}`,
      onclick: (e) => { e.preventDefault(); showCard(x.trackedKey); },
    }, "Tracked", svg("M9 6l6 6-6 6"));
  } else if (x.canTrack === "cws" || x.canTrack === "updateUrl") {
    action = h("button", {
      "data-ctl": "track", "aria-label": `Track ${x.name}`,
      onclick: (e) => {
        // The permission prompt needs this click: ask before anything awaits.
        const asked = requestOrigins(x.needsOrigins, true);
        rowAct(x.id, e.currentTarget, async () => {
          await asked;
          await trackInstalled(x.id);
          return `Tracking ${x.name}. Its updates show on the Extensions tab.`;
        });
      },
    }, "Track");
  } else if (x.canTrack === "github") {
    const open = linkOpen.has(x.id);
    action = h("button", {
      "data-ctl": "link-toggle", "aria-expanded": String(open), "aria-controls": `link-${x.id}`,
      "aria-label": `Link a GitHub repo to ${x.name}`,
      onclick: () => {
        open ? linkOpen.delete(x.id) : linkOpen.add(x.id);
        installedStatus.delete(x.id);
        renderInstalledNow().then(() => {
          const el = document.querySelector(`[data-id="${CSS.escape(x.id)}"] ${open ? '[data-ctl="link-toggle"]' : 'input'}`);
          if (el) el.focus();
        });
      },
    }, open ? "Cancel" : "Link repo");
  }

  const linkForm = x.canTrack === "github" && linkOpen.has(x.id)
    ? h("form", {
        className: "link-form", id: `link-${x.id}`,
        onsubmit: (e) => {
          e.preventDefault();
          const input = e.target.elements.repo;
          const text = input.value.trim();
          rowAct(x.id, e.submitter, async () => {
            const key = await linkInstalledToGithub(x.id, text);
            linkOpen.delete(x.id);
            linkDraft.delete(x.id);
            // As after Add: choose the release asset to follow. Focus returns to the row.
            queuePicker(key, document.querySelector(`[data-id="${CSS.escape(x.id)}"]`));
            return `Linked ${x.name} to ${text}. Choose the release asset to follow.`;
          });
        },
      },
        h("label", { className: "label", htmlFor: `link-input-${x.id}` }, "GitHub repository"),
        h("div", { className: "field" },
          h("input", {
            type: "text", id: `link-input-${x.id}`, name: "repo", "data-ctl": "link-input", placeholder: "owner/repo or URL", required: true,
            autocapitalize: "off", autocomplete: "off", spellcheck: false, enterkeyhint: "go",
            value: linkDraft.get(x.id) || "", oninput: (e) => linkDraft.set(x.id, e.target.value),
          }),
          h("button", { className: "primary", "data-ctl": "link" }, "Link")))
    : null;

  return h("li", { className: `ext-row${status.busy ? " busy" : ""}`, "data-id": x.id, "aria-labelledby": nameId },
    h("div", { className: "ext-main" },
      h("div", { className: "ext-icon" }, img, initial),
      h("div", { className: "row-text" },
        h("strong", { id: nameId }, x.name),
        h("span", { className: "meta" },
          h("span", { className: "version" }, x.version), " · ", installedSource(x, tracked),
          x.enabled ? null : " · disabled")),
      action),
    linkForm,
    status.text ? h("p", { className: "card-status" }, status.busy ? h("span", { className: "spinner", "aria-hidden": "true" }) : null, status.text) : null,
    status.error ? errorLine("card-error", status.error) : null);
}

let installedRendering = Promise.resolve();
function renderInstalledNow() {
  installedRendering = installedRendering.then(renderInstalledInner, renderInstalledInner);
  return installedRendering;
}
async function renderInstalledInner() {
  const [list, view] = await Promise.all([installedOverview(), trackedView()]);
  const trackedByKey = new Map(view.map((v) => [v.key, v]));
  // Rows are rebuilt: focus goes back to the same control of the same row, or to its
  // replacement (Track -> Tracked, Link -> Link repo).
  const active = document.activeElement;
  const row = active && active.closest && active.closest("#installedList [data-id]");
  const memo = row ? { id: row.dataset.id, ctl: active.dataset.ctl } : installedFocus;
  const groups = GROUPS.map(([kind, label]) => {
    const rows = list.filter((x) => x.kind === kind).sort((a, b) => a.name.localeCompare(b.name));
    if (!rows.length) return null;
    const hint = groupHint(kind);
    const headingId = `group-${kind}`;
    return h("section", { className: "ext-group", "aria-labelledby": headingId },
      h("h2", { id: headingId }, label, h("span", { className: "group-count" }, String(rows.length))),
      hint ? h("p", { className: "hint" }, hint) : null,
      h("ul", { className: "ext-rows" }, rows.map((x) => installedRow(x, trackedByKey))));
  }).filter(Boolean);
  $("installedList").replaceChildren(...groups);
  $("installedInfo").textContent = list.length ? plural(list.length, "extension installed", "extensions installed") : "No other extensions are installed.";
  for (const b of $("installedList").querySelectorAll(".ext-row.busy button")) setBusy(b, true);
  if (memo && !(active && active.isConnected)) {
    const r = $("installedList").querySelector(`[data-id="${CSS.escape(memo.id)}"]`);
    const el = r && (r.querySelector(`[data-ctl="${CSS.escape(memo.ctl || "")}"]`) || r.querySelector('[data-ctl="open"], [data-ctl="track"], [data-ctl="link-toggle"]'));
    if (el) el.focus({ preventScroll: true });
  }
}
let installedFocus = null;
$("installedList").addEventListener("focusin", (e) => {
  const r = e.target.closest("[data-id]");
  installedFocus = r ? { id: r.dataset.id, ctl: e.target.dataset.ctl } : null;
});

// ---- desktop flag banner ----
// Shown while installs need the browser flag and the lib recorded a refused install
// (view.installBlocked). Dismiss makes the lib forget it; the next refusal shows it again.
function renderBanner(view) {
  $("flagBanner").hidden = !(env.installNeedsFlag && view.installBlocked);
}
$("flagCopy").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText($("flagPath").textContent);
    say("flagStatus", "Copied. Paste it into the address bar.");
  } catch (e) {
    say("flagStatus", "Copying was refused. Select the address above and copy it.", true, e.message);
  }
});
$("flagDismiss").addEventListener("click", async (e) => {
  const button = e.currentTarget;
  if (button.getAttribute("aria-disabled") === "true") return;
  setBusy(button, true);
  try {
    await dismissInstallBlocked();
    $("flagBanner").hidden = true;
    $("tabList").focus();
  } catch (err) {
    console.error(err);
    const f = friendly(err);
    say("flagStatus", f.text, true, f.detail);
  }
  setBusy(button, false);
});

let rendering = Promise.resolve();
function render() {
  rendering = rendering.then(renderNow, renderNow);
  return rendering;
}

// Re-renders when the first pending install passes the grace period, so its
// line switches from "Waiting…" to "not confirmed" without another event.
let graceTimer = 0;
let rateTimer = 0;

// (A download still in progress has no prompt time yet; its completion is a storage change.)
function scheduleGrace(view) {
  clearTimeout(graceTimer);
  const due = view
    .filter((v) => v.pendingInstall && v.pendingInstall.promptAt !== null && isPromptWaiting(v.pendingInstall))
    .map((v) => v.pendingInstall.promptAt + PENDING_GRACE_MS - Date.now());
  if (due.length) graceTimer = setTimeout(render, Math.max(0, Math.min(...due)) + 50);
}

// "Sign a .zip with the key of": a new key, a tracked repo's key, or the key of an
// extension installed from a file without a repo. The choice survives re-renders
// while it is still listed.
function renderKeyChoice(view, fileKeys) {
  const select = $("fileKey");
  const chosen = select.value;
  const repoKeys = view.filter((v) => v.hasKey && v.record.owner).map((v) => h("option", { value: v.key }, `${v.record.owner}/${v.record.repo}`));
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
  renderBanner(view);
  // Busy cards keep their buttons focusable; the click guard ignores them.
  for (const b of $("list").querySelectorAll(".card.busy button")) setBusy(b, true);
  if (memo && !(active && active.isConnected)) {
    const el = $("list").querySelector(`[data-key="${CSS.escape(memo.key)}"] [data-ctl="${CSS.escape(memo.ctl)}"]`);
    if (el) el.focus({ preventScroll: true });
  }
  scheduleGrace(view);
  await followFileInstall();
  $("empty").hidden = view.length > 0;
  const updates = view.filter((v) => v.state === "update").length;
  $("updateCount").hidden = !updates;
  $("updateCount").textContent = plural(updates, "update", "updates");
  const fileKeys = await fileKeysView();
  renderKeyChoice(view, fileKeys);
  renderFileKeys(fileKeys);
  const { lastCheck, rateLimit } = await chrome.storage.local.get(["lastCheck", "rateLimit"]);
  $("checkInfo").textContent = checkLine(lastCheck, view, (at) => new Date(at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }));
  // After the reset time the stored count is stale: say so, and re-render at the reset.
  clearTimeout(rateTimer);
  const resetAt = rateLimit && new Date(rateLimit.reset).toLocaleTimeString(undefined, { timeStyle: "short" });
  $("rateInfo").textContent = !rateLimit
    ? ""
    : rateLimit.reset > Date.now()
      ? `GitHub API: ${rateLimit.remaining}/${rateLimit.limit} requests left, resets ${resetAt}.`
      : `GitHub API: the limit reset at ${resetAt}; ${rateLimit.limit} requests per hour are available again.`;
  if (rateLimit && rateLimit.reset > Date.now()) rateTimer = setTimeout(render, Math.min(rateLimit.reset - Date.now() + 1000, 2 ** 31 - 1));
  await renderInstalledNow();
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
  const input = $("addInput").value;
  // A store item is checked right away, so the CWS hosts are asked for in this submit
  // gesture, before anything awaits. Input that does not parse fails inside addRepo.
  const asked = requestOrigins(addOrigins(input), true);
  act(e.submitter, async () => {
    await asked; // declined: nothing is added
    const key = await addRepo(input);
    $("addInput").value = "";
    // A GitHub repo next asks for its release asset; store records (cws:<id>) have none.
    if (!/^(?:cws|url):/.test(key)) queuePicker(key, $("addInput"));
  }, "addStatus");
});

// The install from a file handed to the browser: { id, version, name, token, timer,
// shown }, or null. Its status line follows it as the cards do until the browser
// confirms it (management.onInstalled, or the lib's state on a render) or the lib
// ends it: not confirmed once the grace period after the prompt passed, waiting
// for Chromium while the lib says its copy vanished (followFileInstall, on each
// render and after the grace period).
let fileWatch = null;
function watchFileInstall(next) {
  if (fileWatch) clearTimeout(fileWatch.timer);
  fileWatch = next;
}
async function followFileInstall() {
  const watch = fileWatch;
  if (!watch) return;
  const state = await handOffState(watch.token);
  if (fileWatch !== watch) return;
  if (state === "confirmed") {
    say("fileStatus", `${watch.name} ${watch.version} added.`);
    watchFileInstall(null);
  } else if (state === null) {
    // Ended: confirmed and cleaned up (the browser runs that version), or replaced, uninstalled or expired.
    const ext = await chrome.management.get(watch.id).catch(() => null);
    if (fileWatch !== watch) return;
    if (ext && ext.version === watch.version) say("fileStatus", `${watch.name} ${watch.version} added.`);
    watchFileInstall(null);
  } else if (state === "waiting" && watch.shown !== "waiting") {
    watch.shown = "waiting";
    say("fileStatus", waitingText(watch.name, watch.version));
  } else if (state === "pending" && watch.shown !== "pending" && !isPromptWaiting({ promptAt: watch.promptAt })) {
    watch.shown = "pending";
    say("fileStatus", `The browser has not confirmed ${watch.name} ${watch.version}. If you dismissed the prompt, install again.`);
  }
}
function fileInstallAdded(info) {
  if (!fileWatch || info.id !== fileWatch.id || info.version !== fileWatch.version) return;
  say("fileStatus", `${fileWatch.name} ${fileWatch.version} added.`);
  watchFileInstall(null);
}

let fileResult = null;
$("fileInstall").addEventListener("click", (e) =>
  act(e.currentTarget, async (wait) => {
    const file = $("fileInput").files[0];
    if (!file) {
      say("fileStatus", "Choose a .crx or .zip file first.", true);
      return;
    }
    const signWith = $("fileKey").value || null;
    const bytes = new Uint8Array(await file.arrayBuffer());
    const res = await whenQueued(wait, () => installFile(bytes, file.name, signWith));
    // A zip installed without a repo keeps its key in the file-key store; tracking takes it
    // from there, so the page does not hold on to the private key.
    fileResult = res.repoKey ? res : { ...res, keyPkcs8: null };
    $("fileTrack").hidden = !!res.repoKey; // a CRX is never attached to the selected repo
    $("fileResult").textContent = `${res.name} ${res.installed.version} → ID ${res.extensionId}.`;
    const name = res.name || file.name;
    if (res.confirmed) return `${name} ${res.installed.version} added.`;
    watchFileInstall({
      id: res.extensionId, version: res.installed.version, name, token: res.token, promptAt: res.promptAt, shown: null,
      timer: setTimeout(followFileInstall, Math.max(0, res.promptAt + PENDING_GRACE_MS - Date.now()) + 50),
    });
    return "Confirm the browser prompt to add the extension.";
  }, "fileStatus")
);

// Kept file keys with Forget. Deleting a key cannot be undone: a second tap confirms.
const forgetArmed = new Map(); // extension ID -> timer
function renderFileKeys(fileKeys) {
  const refocus = document.activeElement && document.activeElement.dataset && document.activeElement.dataset.forget;
  for (const id of forgetArmed.keys()) if (!fileKeys.some((f) => f.extensionId === id)) disarmForget(id);
  $("fileKeys").hidden = !fileKeys.length;
  $("fileKeyList").replaceChildren(...fileKeys.map((f) => {
    const title = f.name ? `${f.name} ${f.version}` : "Not installed";
    const label = () => (forgetArmed.has(f.extensionId) ? "Tap again to delete the key" : "Forget");
    const button = h("button", {
      className: "btn danger", "data-forget": f.extensionId, "aria-label": `${label()}, ${title}, ${f.extensionId}`,
      onclick: (e) => {
        if (!forgetArmed.has(f.extensionId)) {
          forgetArmed.set(f.extensionId, setTimeout(() => {
            disarmForget(f.extensionId);
            render();
          }, ARM_MS));
          button.textContent = label();
          button.setAttribute("aria-label", `${label()}, ${title}, ${f.extensionId}`);
          announce("Tap again to delete the key.");
          return;
        }
        disarmForget(f.extensionId);
        announce("");
        act(e.currentTarget, async () => {
          await forgetFileKey(f.extensionId);
          return `Forgot the key of ${f.name || f.extensionId}.`;
        }, "keysStatus");
      },
    }, label());
    return h("li", {}, h("span", { className: "key-name" }, title, h("span", { className: "meta" }, f.extensionId)), button);
  }));
  if (refocus) {
    const again = $("fileKeyList").querySelector(`[data-forget="${CSS.escape(refocus)}"]`);
    if (again && document.activeElement !== again) again.focus({ preventScroll: true });
  }
}
function disarmForget(id) {
  clearTimeout(forgetArmed.get(id));
  forgetArmed.delete(id);
}

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
    await setGithubToken($("token").value.trim());
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
  act(null, async (wait) => {
    const file = e.target.files[0];
    e.target.value = "";
    if (!file) return;
    $("importResult").replaceChildren();
    const text = await file.text();
    const res = await whenQueued(wait, () => importBackup(text));
    await showImportResult(res); // shown under the Import button
  }, "backupStatus")
);

// Conflicts, warnings and check errors of the last import stay under Backup
// until the next import.
// lib import warnings "<key>: extension <id> is already tracked as <other>; <key> was not imported"
// and "<key>: extension <id> already has another file key; the backup's key of <key> was not
// imported" in words; other warnings stay as the lib wrote them.
function importWarning(w) {
  const m = /^(\S+): extension \S+ is already tracked as (\S+); \S+ was not imported/.exec(w);
  if (m) return `${m[1]} was skipped: this extension is already tracked as ${m[2]}.`;
  const k = /^(\S+): extension (\S+) already has another file key; the backup's key of \S+ was not imported/.exec(w);
  return k ? `${k[1]}: the backup's signing key was not restored, because extension ${k[2]} already has another key here.` : w;
}

async function showImportResult({ count, errors, conflicts, warnings }) {
  // Conflicts carry the lowercase storage key; show owner/repo as written.
  const names = new Map((await trackedView()).map((v) => [v.key, v.record.owner ? `${v.record.owner}/${v.record.repo}` : v.title]));
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
    warnings.length ? box(plural(warnings.length, "warning", "warnings"), warnings.map(importWarning)) : null,
    errors.length
      ? box(`${plural(errors.length, "repo", "repos")} could not be checked`, errors.map(errorItem), "error error-list")
      : null,
  ].filter(Boolean);
  $("importResult").replaceChildren(
    h("p", { className: "result-title" }, `Restored ${plural(count, "repo", "repos")}`, parts.length ? null : h("span", { className: "muted" }, " · no key conflicts")),
    ...parts);
}

// Re-render on background changes, but not while the user types in the list.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  const typing = document.activeElement && document.activeElement.matches("#list input[type=text], #installedList input[type=text]");
  if (!typing) render();
});
chrome.management.onInstalled.addListener((info) => {
  fileInstallAdded(info);
  render();
});
chrome.management.onUninstalled.addListener(() => render());

Promise.resolve(environment()).then((e) => {
  env = e;
  document.body.dataset.platform = e.platform;
  render();
});
