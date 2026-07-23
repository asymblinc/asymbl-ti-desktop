# Implementation — 01b/01c Meeting Notification Panel

Task #37 (parent), #37a-i (breakdown). Design source: `desktop/meeting-notification.jsx` + `screen-specs/01b-meeting-notification.md` in the claude_design MCP project (`019de4a3-82fc-70a7-a039-c5cdb112e5cf`). Local mirror: `/Users/sdevinarayanan/Downloads/TI Recall (1)`.

## 0. What this replaces

Today (before this task): `main.js`'s `RecallAiSdk.addEventListener('meeting-detected', ...)` shows a generic Electron `Notification` (native OS notification center UI) with a "Record" action button. Clicking it (or the notification body) calls `joinDetectedMeeting()`.

This task replaces that native notification with a custom frameless panel matching the design's pixel-perfect pill/dropdown treatment, **without changing the underlying policy-check/consent/recording-start logic at all** — `joinDetectedMeeting()` is reused verbatim.

## 1. Components (design → real tokens)

| Design var | Real token (this repo) |
|---|---|
| `--ink` | `--brand-ink-navy` (#191d47) |
| `--ink-2`/`--ink-3` | `--brand-slate` (#5b6070) |
| `--ink-4`/`--ink-5`/`--ink-6` | `--brand-gray` (#9aa0ae) |
| `--paper` | `--brand-white` (#ffffff) |
| `--paper-edge` | `rgba(25,29,71,0.08)` (hairline, matches existing popover.css convention) |
| `--paper-2` | `rgba(25,29,71,0.06)` (dividers) |
| `--accent` | `--brand-blue` (#038ff8) |
| `--accent-3` / `--accent-ink` | `--brand-tint-blue` / `--brand-blue` (signal-chip pill) |
| `--shadow-window` | `--brand-shadow-window` (exact existing token, no translation needed) |

No new CSS variables invented — this repo's established convention (from screen 02) is direct per-rule translation into `--brand-*`, not new aliases.

**Elements:** accent bar (4px, left) · `Avatar` (reuse `popover-renderer.js`'s avatar-initials pattern, coral tone) · title (1 line, ellipsis) · meta line (time · platform · live-status word) · split button (`Start capture` + chevron) · hover-expand Pre-Brief-teaser block (3 signal chips) · 4-row dropdown (icon + label + subtext + kbd hint) · consent footer line.

**Animation:** slide-in from right, 240ms ease-out + fade (CSS transition on `transform`/`opacity`, triggered on `show`). Hover-expand: window `setBounds` height grow/shrink (real OS resize, not CSS-only — this is a native window, not a fixed-size webview), 300ms collapse delay on `mouseleave`.

**No GIFs** — confirmed via the same check done for screen 02 (no image assets in the design bundle for this screen either).

## 2. Connected functionality — what's real, what's wired, what's stubbed

| Action | Backend path | Status |
|---|---|---|
| **Start capture** | `capture-policy-client.js` → `GET /api/ti/capture-policy` (control-plane Cloud Run) → `capture-policy-handler.ts` → `decideCapture()`/`applyConsentGate()` → audit row in Firestore **`ti_capture_decisions`** (`audit.ts`) → back in desktop, `createDesktopSdkUpload()` → Recall.ai SDK session start. **Fully real, reused verbatim from `joinDetectedMeeting()` (`main.js:2177`).** |
| **Send the bot instead** | Checked: `recall-dispatcher`'s `FORCE_REJOIN` path (`dispatcher.ts:50`) is Pub/Sub-message-driven only — **no HTTP route exists for the desktop to trigger it directly.** Honest disabled state (tooltip: "Not available yet"), not faked. |
| **Open Pre-Brief first** | Pre-Brief screen doesn't exist yet (task #23, pending). Honest disabled state. |
| **Remind me in 2 minutes** | Local only — hide panel, `setTimeout` re-show, no backend call. |
| **Don't capture this call** | No per-meeting suppression flag or decline-audit endpoint currently exists in `main.js`'s detection state. Added minimally: an in-memory `Set` of suppressed meeting URLs (session-lifetime only, not persisted — matches the spec's "re-arms once" scope, doesn't need disk/DB persistence for that). No audit row (would need a new control-plane endpoint; out of scope for this pass, logged in TODOS.md). |

**Session/auth:** requires `authStore.getAccessToken()` (same 15-min JWT as the rest of the app) — `capturePolicyClient.checkCapturePolicy` already handles the not-signed-in case by returning `{status: 'error'}`, which `joinDetectedMeeting()` already treats as fail-open (unmanaged desktop-only recording), not a hard block. No new auth path.

**Storage:** no new local storage. The panel window itself holds no state between shows (created once, hidden/shown, per spec §3 "Lifecycle").

**Cloud Run:** no new service. Uses the existing `control-plane` service's already-deployed `/api/ti/capture-policy` route.

## 3. Electron window setup (researched via Perplexity, 2026-07-23)

```js
new BrowserWindow({
  frame: false,
  transparent: true,
  show: false,
  fullscreenable: false,
  type: 'panel',            // macOS on-top behavior
  resizable: false,
  focusable: false,          // never steals focus - hover/click still work, only keyboard activation is blocked
  skipTaskbar: true,
  webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true, preload: ... }
});
win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true }); // visible over fullscreen Zoom
win.setAlwaysOnTop(true, 'screen-saver');
win.showInactive(); // never win.show() - would steal focus
```

Position: `screen.getDisplayNearestPoint(screen.getCursorScreenPoint())` — the display nearest the user's current cursor position, re-evaluated at each `show()`, not tracked live while visible (matches spec: "never chases the cursor live," N5).

**DND detection:** confirmed via Perplexity — no official Electron/Node API exists for macOS Focus/DND as of 2026; the only options are AppleScript or a native module. Implemented as a best-effort `osascript` check (via `child_process`, no compiled native addon) that fails open (assumes DND is off) on any error — documented as brittle, not assumed reliable.

## 4. Deferred (logged to TODOS.md, not silently dropped)

- T-60s schedule-trigger (today's build wires the SDK `meeting-detected` trigger only, per what already existed to replace; the schedule-based trigger needs its own polling integration against `getTodaySchedule`)
- Full N1-N7 edge-case scenario testing from the spec (multi-meeting queueing, wrong-display re-show, double-fire idempotency) — the core single-meeting happy path is built and verified; these are real but lower-probability paths
- "Send the bot instead" / "Open Pre-Brief first" real wiring — blocked on backend/screen work that doesn't exist yet (see table above)
- Decline-audit endpoint for "Don't capture this call" (currently local-only suppression, no server-side audit row)
