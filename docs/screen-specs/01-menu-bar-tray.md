# Screen Spec — Menu Bar, Tray & Popover (Desktop 01)

**Screen:** `01 · Menu bar idle (Pre-Brief popover)` · component `DesktopMenuBar`.
**Build refs:** `asymbl-ti-desktop/src/tray.js` (shipped: recording-only tray), `docs/PLAN-desktop-redesign.md #20` in the delivery repo (the full redesign this spec defines) · Spec B F4/F5/F11 · Handoff §12, ADR-B-008.
**Doc series:** 02 of N in `screen-specs/`.

---

## 1. Purpose

The menu bar is Recall's **ambient presence** — the product when it isn't the product. It must answer, in a glance and without opening anything: *am I being recorded?* and *what's next?* Everything else (library, settings, briefs) is one click deeper.

**Inspiration anchors** (study these, copy the discipline not the pixels):
- **Granola** — menu-bar-first notetaker; pill shows meeting countdown; popover = next meeting + one action. The bar under macOS 26's constraints.
- **Loom** — the canonical "am I recording?" treatment: red state unmistakable at 16px, click-to-stop always one gesture away.
- **CleanShot X / Raycast** — popover density and keyboard-shortcut rows done right (our Options list mirrors Raycast's row anatomy: icon · label · ⌘hint).
- **macOS Control Center** — native materials: translucency, 0.5px hairlines, drop-shadowed arrow, vibrancy. The popover should feel like the OS drew it.

## 2. States (the tray is a state machine, not an icon)

| State | Icon (template image) | Pill text | Popover header chip |
|---|---|---|---|
| `signed-out` | bracket mark, 40% opacity | — (icon only) | "Sign in" button replaces chip |
| `idle-ready` | bracket mark | `Recall · ready` | green **Ready** |
| `pre-meeting` (T-15 min) | bracket + countdown | `Maya · in 16m` | blue **Up next** |
| `meeting-detected` | bracket + blue dot | `Meeting detected` | blue **Join?** — capture-policy decision shown |
| `recording` | **red dot replaces bracket dot**, pulses | `● 12:41` (mono, elapsed) | red **REC** + Stop button |
| `paused` | hollow red dot | `⏸ paused` | amber **Paused — not capturing** |
| `uploading` | bracket + progress ring | `Syncing…` | blue progress row |
| `attention` | bracket + amber badge | `1 needs review` | amber row → post-call/orphan queue |
| `locked` | bracket, 40% + lock badge | `Recall · locked` | LockedDashboard CTA |

Rules: **red belongs to recording only** (§12). The pill NEVER hides while recording — that's the bug tray.js already fixed; this spec extends it: the tray is *always* present when signed in (Granola pattern), recording only changes its state. Elapsed time in the pill is the strongest trust signal we have — never replace it with a generic "recording" label.

## 3. Anatomy — pixel-perfect targets

**Tray icon:** 22×22pt template image (16×16 glyph within), monochrome — macOS tints it for light/dark automatically. This replaces the shipped full-color resize (tray.js's own `[UNVERIFIED - follow-up]` flags exactly this). Recording state swaps in a **non-template** red-dot variant (color is the point). @1x/@2x/@3x PNGs, or NSImage-from-PDF.

**Pill (macOS 26 style, when text is shown):** height 22px · radius 999 · padding 3px 9px 3px 7px · bg `--ink` at 92% + `backdrop-filter: blur(20px)` · text 11px Inter Medium, `-0.005em` · white ring `0 0 0 2px rgba(255,255,255,0.65)` for legibility on any wallpaper · mark at 12px.

**Popover:** 320px wide · radius 12 · `--shadow-window` + 0.5px `--paper-edge` border · 7px arrow aligned to icon center. Sections top→bottom:
1. **Header** 12/14/10px padding: Wordmark(12) · state chip right.
2. **Next on calendar** card: date tile 36×36 (`--accent-3` bg, `--accent-ink`), title 13px SemiBold, meta rows 11px with 11px icons, 5px gap. Actions row: primary `Open Pre-Brief` (ink bg, sparkle icon) + ghost `Skip`. In `recording` state this card is replaced by the **live session card**: elapsed mono timer, waveform, linked-record line, `Stop & save` (red) + `Open window`.
3. **Options** rows 7px 10px padding: icon 13px `--ink-4` · label 12px `--ink-2` · ⌘hint 10px mono `--ink-5`. Hover: `--paper-2` fill, 6px radius. Rows: Start unscheduled call ⌘N · Open library ⌘L · Settings ⌘,.
4. **Footer** `--paper-2` bg: Avatar 20 · name/org 11px · version right.

**Interactions:** left-click = popover toggle (recording: click = focus main window, matching shipped tray.js; popover on second click) · right-click = quick menu (Stop, Pause, Open window, Quit) · ⌥-click = start/stop capture directly. Popover dismisses on outside click/Esc; never steals focus from the active call (ADR-B-008 discipline).

## 4. How it works with the rest

- Pill countdown + "Next on calendar" come from the same feed as Home's schedule (SF interviews via control plane); popover's `Open Pre-Brief` opens the separate Pre-Brief BrowserWindow (ADR-B-008), never the main window.
- `meeting-detected` state = SDK detection → capture-policy call → the decision (You capture / Bot joins / Both / None+reason) is displayed *before* the user commits — consent gate lives on the join flow, not the popover.
- Closing the main window during recording leaves this as the only UI (live-capture spec N10); Stop from here → Post-call review.
- `attention` state aggregates the same queues as Home's "Needs attention" rail — one source of truth, two renderings.

## 5. Scenarios

**Positive:** P1 glance-check while recording (red dot + elapsed visible, zero clicks) · P2 pre-meeting flow: pill countdown → click → Pre-Brief → meeting starts → detected → one-click capture start · P3 unscheduled call via ⌘N · P4 quick library jump.

**Negative:** N1 wallpaper contrast (white ring + template image guarantee legibility; test on pure white + pure black wallpapers) · N2 menu-bar overflow on small MacBooks (macOS hides items — icon-only mode must survive; never rely on pill text being visible) · N3 recording but popover unreachable (crashed renderer): tray is owned by the main process — Stop must work even if all windows are dead · N4 clock skew makes countdown negative — clamp to "now" · N5 multiple displays: popover opens on the display with the menu bar clicked · N6 Windows: system tray (bottom-right), no pill text — states carried by icon variants + tooltip; popover becomes a fixed-position flyout · N7 signed-out click → sign-in window, never a dead popover.

## 6. Gap vs shipped code

Shipped (`tray.js`): tray exists only while recording, full-color icon, click = focus window, no popover, no states. This spec = redesign task #20: always-present tray, template image + red recording variant, 9-state machine, popover per §3. Migration note: keep `setRecordingActive` as the state-machine input; don't break its call sites.
