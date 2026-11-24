---
name: Extainium
colors:
  accent: "light #0b57d0-like oklch(0.5 0.19 259) / dark oklch(0.8 0.1 255)"
  neutrals: "cool blue-grey, hue 250-258, chroma 0.003-0.02"
  status: "ok green 150, warn amber 65-80, err red 25-27; update = accent"
typography:
  family: "system-ui (Roboto on Android); no web font"
  scale: "13 / 14 / 16 / 18 / 22 px (--fs-xs..--fs-xl); weights 400 / 600 / 700 (h1 only)"
radius: "8 small (icon badge, kind tag) / 12 controls / 16 cards and sheet / full for chips"
---

# Extainium UI

Self-picked direction (brief: "If a look decision is genuinely undecided, pick one and say so").
Tokens live in `src/style.css` :root; the popup shares them.

## Color
One accent: the blue the badge already uses (#0b57d0, set in lib/manager.js), so the page and the toolbar badge match. Not violet. Light/dark follow prefers-color-scheme through light-dark().
Theme setting (Files & settings > Theme: System / Light / Dark): data-theme on <html> sets color-scheme before the first paint; with System the options page uses its own scheme and records it, and the popup uses that recorded scheme (Titanium's popup reports light while its tabs are dark). Status chips are tinted surfaces with a dot and a word: Up to date (green), Update available (accent), Not installed (neutral), Ambiguous asset / No asset / Version unknown (amber), Error (red, when the last check failed).

## Type
16px base, 14px meta, 18px card titles, 22px app name. Tabular figures for versions, dates, counts. Inputs 16px (no zoom on focus).

## Layout
Single column, max 720px, fluid padding clamp(12px, 4vw, 24px). Sticky header: name, update count, Check all, and two tabs: Extensions (add field, last check line, cards) and Files & settings (Install from file, GitHub token + rate info, Backup with the key warning). 44px minimum controls.

## Build decisions
- Tree: header(tabs) > panelList(addForm, checkInfo, list of cards, empty) | panelTools(groups); dialog#pickerSection (bottom sheet <720px, centered ≥720px); header status strip (#message / #messageAlert).
- Card: avatar 48 (github.com/<owner>.png) with the installed extension's icon (management icons) as a 24px corner badge; title (extension name or repo), owner/repo link, status chip; Installed / Latest tiles (release date, notes link); inline candidates for ambiguous; inline errors; one primary action (Install/Update filled, Reinstall tonal, Choose asset when no pattern); "More" disclosure with Choose asset, Check, pattern, pre-releases, specific release, facts, Remove.
- States: empty (dashed box with next step), checking (spinner in Check all + header progress line), busy card (top progress line + step text), card error / check error (red tinted box on the card). Messages sit in the flow, never over a control: an inline status line under the control that raised them, card errors on the card, and a status strip inside the sticky header (pushes content) for Check all and Remove results; each stays until the next action in that place or Dismiss.
- Motion: press scale 0.97 / 120 ms; sheet 240 ms ease-out; all reduced under prefers-reduced-motion.
- Open for the build: none.

## Popup and icon

- Popup: brand row, a status circle with the headline (update count / All up to date / No tracked extensions), a last-check line, one card listing the repos with updates (48px avatar, installed → latest), an inline error box, then Check now and Open Extainium.
- Icon: an accent-blue block with one connector knob and a white up arrow. Source `src/icons/icon.svg`; the PNGs are made with `rsvg-convert -w N -h N src/icons/icon.svg -o src/icons/icon-N.png` for N = 16, 32, 48, 128.
