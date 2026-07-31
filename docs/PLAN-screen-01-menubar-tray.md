<!-- /autoplan restore point: ~/.gstack/projects/asymblinc-asymbl-ti-desktop/TI-385-feat-bootstrap-fork-autoplan-restore-*.md -->

# PLAN — Screen 01: Menu Bar, Tray & Popover

## 0. Goal

Build the redesigned menu-bar tray (`docs/screen-specs/01-menu-bar-tray.md`, full 9-state spec) into `asymbl-ti-desktop`, pixel-matched to the design canvas + brand system, reusing real app state wherever it exists and being explicit about what doesn't.

## 1. Current state (verified against live code, not the spec's assumptions)

`src/tray.js` today: tray icon exists **only while recording** (`setRecordingActive(true/false)`), full-color icon (not a template image - `tray.js`'s own comment already flags this as `[UNVERIFIED - follow-up]`), click = focus main window, no popover, no states.

Per-state data audit (what's real vs. what needs new backend/product work):

| Spec state | Backing data today | Verdict |
|---|---|---|
| `signed-out` | Real - `isSignedIn` (screen 00's gate work, same signal) | **Buildable now** |
| `idle-ready` | Real - just needs tray always-present instead of recording-only | **Buildable now** |
| `pre-meeting` (T-15) | **None.** No interview/calendar schedule feed exists anywhere in this app or control-plane (`rg` for `interview.*schedule\|next.*interview\|upcoming` across `gcp/control-plane/src` returns nothing) | **Not buildable** - real backend gap |
| `meeting-detected` | Real - `RecallAiSdk.addEventListener('meeting-detected', ...)` in `main.js:545`, already drives the home-view Record button | **Buildable now** |
| `recording` | Real - `activeRecordings.recordings[id].startTime` / `recordingStartedAt` (`main.js:270,486,1419`) gives real elapsed time | **Buildable now** |
| `paused` | **None.** No pause/resume exists anywhere in the capture pipeline - `renderer.js:2194`'s `data.state === 'paused'` check has no emitter; `RecallAiSdk` calls used today are `startRecording`/`stopRecording` only, no pause API called anywhere | **Not buildable** - would need to confirm the SDK even supports pause before scoping this |
| `uploading` | Real but unused - `RecallAiSdk.addEventListener('upload-progress', ...)` (`main.js:751`) receives real `%` today, currently just logged | **Buildable now** (wire existing event to tray, not build new) |
| `attention` | **None.** No "needs review"/orphan-queue concept exists in this desktop app at all (that's C1/C4 admin-side per the backend handoff, not desktop-side) | **Not buildable** - no queue to read from |
| `locked` | Real - license lockout already built this session (F9 security fix, `SIGN_IN_ERROR_MESSAGES` locked_reason handling) | **Buildable now** |

**Correction to the tracked task list:** #21 ("NEW BACKEND - Google Calendar integration for 'next meeting' data") assumed Google Calendar OAuth. This spec instead says the feed should be "the same feed as Home's schedule (SF interviews via control plane)" - i.e. Salesforce `Interview__c` records, consistent with ADR-002 ("SF drives dispatch, no calendar OAuth" - the whole architecture was built to avoid a calendar OAuth surface). Neither exists yet either way, but they're different backends with different owners/effort. Flagging for a real decision, not silently picking one.

## 2. Target (design + spec source of truth)

`docsscreen-specs/01-menu-bar-tray.md` (full spec, pasted by the user) + reference `desktop/menu-bar.jsx` (Claude Design export) + screenshot (design canvas "01 · Menu bar idle"). Brand tokens per `CLAUDE-CODE-HANDOFF.md` §12 and this repo's existing `--brand-*` variables (same reconciliation as screen 00).

Anatomy target (§3 of the spec): 22×22pt monochrome template tray icon (non-template red-dot swap for recording) · 22px pill (ink bg, white legibility ring, blur) shown when text is warranted · 320px popover (header+chip, content card, options rows, footer).

## 3. Decisions this plan needs to settle

**D1 - Which states ship in this pass.**
Recommendation: ship the 6 states with real backing data now (signed-out, idle-ready, meeting-detected, recording, uploading, locked). Defer `pre-meeting`/"Next on calendar" (real backend gap, needs its own scope decision per the SF-vs-calendar question above), `paused` (needs SDK capability confirmation first), and `attention` (no queue exists) to TODOS.md, each with its own real dependency noted - not silently dropped from the spec.

**D2 - "Next on calendar" data source, now that it's flagged as a real discrepancy.**
Recommendation: SF `Interview__c` via control plane, not Google Calendar OAuth - matches ADR-002's explicit "no calendar OAuth" decision and reuses the JWT/session the app already has, instead of standing up a second OAuth surface. This doesn't unblock building it now (still needs a new control-plane endpoint + desktop polling/push), but settles which direction #21 should point before anyone builds it.

**D3 - Template icon asset generation.**
The spec requires real 22pt monochrome template PNGs (@1x/@2x/@3x) plus a separate non-template red-dot recording variant. No design tool access to export exact assets in this pass.
Recommendation: hand-build minimal, correct template images now (simple bracket-mark glyph, monochrome, proper macOS template-image alpha convention) rather than block the whole screen on a formal asset-export step - swap for real exported assets later if brand wants pixel-identical icon art. This is a "ship the real mechanism now, refine the asset later" call, not a fake/placeholder capability.

**D4 - Windows tray divergence (N6) and multi-display positioning (N5).**
Given dev/testing is macOS-only right now, recommendation: build the macOS behavior correctly and complete; note Windows/Linux tray + multi-display popover positioning as explicitly deferred (TODOS), not silently assumed to work, rather than half-build cross-platform code no one can verify.

## 3.5. Decisions after the CEO review (2026-07-23, owner input)

- **Build order**: continued with #20 despite the earlier approved order putting #24 first — owner call, explicit deviation, not a process slip.
- **Calendar feed**: built for real this pass (not an empty state) — SF `Event` (not `Interview__c`, not Google Calendar), since the design's "Open Pre-Brief" button implies the already-contracted `event_id`-based Pre-Brief API. Owner explicitly declined pulling in the separate `intelligenceAGUI` repo (the contract's nominal owner) — the feed lives entirely in `gcp/control-plane` instead (`next-event.ts`).
- **Pre-Brief generation itself** (LLM summary content) stays out of scope — that's #22/#23. "Open Pre-Brief" opens/focuses the main window rather than a fake deep link, until a real Pre-Brief window exists.
- **Custom-domain-equivalent scope creep avoided**: no new OAuth surface, no cross-repo work — matches the same discipline as screen 00's D3.
- **Google/Outlook Calendar**: logged as TODOS.md item 13 (dedup strategy, source chips) per owner request — not built this pass.

## 3.6. Popover architecture (resolved, not left implicit per Finding 3)

The popover is a real `BrowserWindow` (`popover_window`, second webpack entry point), not a native Tray context menu — a native macOS menu cannot render the design's custom cards/gradients/buttons. This means the popover's renderer can crash independently of the tray. Mitigation: a native, main-process-owned right-click context menu always offers "Stop & Save" while recording, satisfying spec N3 ("Stop must work even if all windows are dead") without depending on the popover's renderer being alive. **Built via `tray.popUpContextMenu(menu)` on an explicit `right-click` listener, never `tray.setContextMenu()`** — see §3.8, that distinction was the exact cause of a real bug found by manually running the app.

## 3.8. Post-ship hardening round (2026-07-23) — cross-platform correctness + a real bug found by using the app

Owner asked for the tray/popover to be genuine cross-platform (Windows + macOS both, not deferred) and to cross-check the implementation against research and independent model review before calling it done. Sequence:

1. **Research** (Perplexity): confirmed frameless `alwaysOnTop` `BrowserWindow` is still the standard 2026 Electron tray-popover pattern (no native alternative exists); surfaced that the shipped `ensurePopoverWindow()` was missing `alwaysOnTop: true` entirely — a real, load-bearing gap (without it, the popover is an ordinary window other app windows can cover). Fixed immediately.
2. **Prior art** (OpenWhispr, real cross-platform Electron app, `src/helpers/tray.js`): confirmed the `nativeImage` + `setTemplateImage(true)` (macOS-only) pattern already in use here is correct, and confirmed Windows needs its **own, separately-colored icon asset** — macOS's auto-tinted black template glyph is invisible on a dark Windows taskbar. OpenWhispr ships a distinct `.ico`/`.png` for non-macOS for exactly this reason.
3. **Independent adversarial review** (grok CLI, file:line-grounded): codex and gemini CLI reviews both failed to produce usable output in this environment (consistent with this session's prior experience — noted, not silently retried). Grok's review found genuine, confirmed bugs:
   - `dispatchAction` in `popover-renderer.js` had no cases for `openWindow`/`joinDetected` — two buttons in the UI were dead on **every** platform, not just Windows.
   - `registerPopoverActionHandlers` would throw "second handler" if `initTray` were ever called twice (defensive gap, not currently reachable but cheap to close).
   - Popover Y-position was never clamped, and the anchor calculation assumed a bottom-only taskbar with no zero-bounds guard (Windows overflow tray icons report `{0,0,0,0}` bounds).
   - The popover's arrow always pointed the "below-icon" direction regardless of actual placement.
4. **Real-app bug, found only by running the app and clicking it** (not caught by any research pass or automated review): left-click was showing **both** the custom popover **and** the native context menu simultaneously. Root cause — `tray.setContextMenu(menu)` on macOS makes the OS show that menu on **any** click, left or right, independent of a separate `'click'` listener. Fix: build the `Menu` object but never call `setContextMenu()`; pop it up manually via `tray.popUpContextMenu(menu)` inside an explicit `'right-click'` listener. This is the kind of bug that visual/structural verification (screenshots, mocked IPC) cannot catch — it only showed up when the owner actually clicked the real tray icon in the real running app.

**What shipped from this round:** Windows-specific colored+haloed icon (`tray-icon-win.png`/`@2x`, `scripts/gen-tray-icons.js`), platform-aware popover anchor placement (above/below, clamped, zero-bounds-safe) with a CSS arrow flip, platform-aware keyboard hint text (`Ctrl+` vs `⌘`), the two dead-button fixes, IPC handler idempotency, an `alwaysOnTop` level (`'pop-up-menu'`) plus a blur-race grace period, and the left-click/right-click menu fix above.

**Still not verified**: no physical Windows machine was available to test on — the Windows code path is now real and reasoned through (not a stub), but only macOS has been exercised end-to-end by actually running the app. Logged as the residual gap in TODOS.md #12 rather than claimed as fully verified.

## 3.7. Verification

Visually verified via the webpack dev server (`localhost:3000/popover_window`) with `popoverAPI` mocked through CDP's `Page.addScriptToEvaluateOnNewDocument` (same technique as screen 00 — the popover's own preload only exists inside real Electron). Confirmed against the design screenshot: `idle-ready` (real event card: date tile, title, time+countdown, location, Open Pre-Brief/Skip), `recording` (red REC chip, live mono elapsed timer, Stop & save/Open window), `signed-out` (single sign-in CTA, options rows hidden per spec N7). Real `npm start` launch confirmed no crashes from `Tray`/`nativeImage` construction. `tsc --noEmit` clean and full `vitest run` (9 files, 47 tests) green on control-plane; desktop repo's existing test suite (3 tests) still passes.

**Known limitation, not silently glossed over**: end-to-end click-through of the real IPC actions (`signIn`, `stopRecording`, etc.) inside actual Electron was not exercised — `window.electronAPI`/`window.popoverAPI` only exist via preload in a real Electron renderer, so this was verified structurally (code paths, syntax, one non-Electron IPC round-trip mock) rather than by clicking the buttons inside the running app window.

## 4. Explicit non-goals

- `pre-meeting`/"Next on calendar" card, `paused` state, `attention` state (D1).
- Pause/resume capture capability itself (separate from the tray UI for it).
- Windows/Linux tray implementation is no longer deferred (§3.8, per owner request) — real platform-aware icon/positioning/keyboard-hint code shipped, but untested on physical Windows hardware (no machine available). Multi-display popover positioning likewise implemented (display-nearest-to-tray logic) but unverified beyond this single-display dev machine.
- Right-click quick menu and ⌥-click shortcut (spec §3 "Interactions") - real scope, deferred alongside the states that need them least (Stop/Pause quick actions depend on states not shipping this pass); left-click popover toggle + existing recording click-to-focus behavior ship now.
