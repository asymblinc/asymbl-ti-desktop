<!-- /autoplan restore point: ~/.gstack/projects/asymblinc-asymbl-ti-desktop/TI-385-feat-bootstrap-fork-autoplan-restore-*.md -->

# PLAN — Screen 00: Sign in (unauthenticated)

## 0. Goal

Build the first screen of the Claude Design canvas ("00 · Sign in (unauthenticated)") into `asymbl-ti-desktop`, pixel-matched to the design mock and the 2026 Asymbl brand system (`CLAUDE-CODE-HANDOFF.md` §12), reusing the app's real auth logic — not the mockup's assumed logic.

## 1. Current state (verified against live code, not assumed)

- `src/index.html` has no full-screen unauthenticated view. The always-rendered `#homeView` (notes list) is the only view; signed-out state is communicated only by a header toggle: `#signInBtn` ("Sign in with Asymbl") shows, `#userAvatar` hides (`renderer.js` `refreshAuthUi()`, lines 96-131).
- Signed-out users can still browse Notes freely. Only `#newNoteBtn` and `#joinMeetingBtn` get `disabled` while signed out.
- Real login mechanism (`src/auth.js`): `shell.openExternal` to `${CONTROL_PLANE_URL}/auth/sf/start?redirect_uri=asymbl-recall://auth-callback`, which redirects through Salesforce's own hosted login (this is where a user would see Salesforce's native "Use Custom Domain" link — nothing app-side exists for that today). Callback comes back via custom protocol, `auth.js` `handleCallbackUrl()` stores tokens, fires `auth-status-changed`.
- Brand tokens live in `src/index.css` under a `--brand-*` prefix (e.g. `--brand-font`, `--brand-ink-navy`, `--brand-record-red`, `--brand-tint-blue`) — confirmed present, different names than the design export's `tokens.css` (`--paper`/`--ink`/`--accent`/`--grad-indigo`). No `--grad-indigo` or paper/ink scale exists yet in this app's CSS.
- `src/brand-ui.js` already ports some design-system primitives (icon(), recDot(), waveform(), avatar(), chip(), kbd()) as vanilla-JS DOM builders — no `Wordmark`/`Logo` mark ported yet, no `sf`/`globe`/`shield`/`check` icons in `ICON_SHAPES`.
- No `docs/` directory exists yet in this repo.

## 2. Target (design source of truth)

Design canvas screen "00 · Sign in (unauthenticated)" (`Recall by Asymbl.html`, screenshot supplied by user) + reference component `desktop/sign-in.jsx` from the Claude Design export (`/Users/sdevinarayanan/Downloads/TI Recall (1)/desktop/sign-in.jsx`) — layout/visual truth per handoff §1 doc-precedence rule (canvas = layout/UX truth, §12 = color/font truth, both already reconciled in the reference file which is brand-token-correct).

Layout: 50/50 split-screen.
- **Left — indigo gradient hero** (bookend rule, §12.2): wordmark (bracket-mark logo + "Recall by asymbl."), headline "Every conversation, remembered where it matters.", supporting copy, a live-transcript vignette card (pulsing red dot, highlighted comp/competing-process spans, 2 chips), SOC 2 / data-ownership footer line.
- **Right — sign-in panel** (white): "Sign in" heading + subhead, primary CTA "Continue with Salesforce" (blue, SF cloud icon), secondary CTA "Use a custom domain" (outline, globe icon), divider labeled "WHAT HAPPENS NEXT", 3-row explainer (browser opens / you approve access / you're in), footer line linking "Asymbl Recruiter Suite".

## 3. Decisions this plan needs to settle

**D1 — Full-screen gate vs. today's permissive header-toggle.**
Today: browsing works signed out, only recording is blocked. Design implies: hard wall, nothing else renders until signed in.
Recommendation: full-screen gate, shown whenever `!isSignedIn` (first launch AND any time the user signs out / token fully expires), replacing `#homeView`/`#editorView` entirely rather than overlaying them — matches the design's intent (this is literally called "unauthenticated" state, not "idle-but-browsable" state) and closes a real product gap (a signed-out user today can read/edit Notes content that never synced anywhere, which is confusing more than useful).

**D2 — Copy/id rename: "Sign in with Asymbl" → "Continue with Salesforce".**
Matches ADR-019 (SF Connected App is the actual identity path, decided 2026-07-23) and the design's literal copy. Touches `#signInBtn` id (keep the id stable, only change label/text and add the new full-screen instance) and `SIGN_IN_ERROR_MESSAGES` display copy is unaffected (those are error toasts, separate strings).
Recommendation: adopt the design's copy for the new gate screen's primary CTA; leave the header's small button copy as a secondary concern (out of scope for this screen — header button behavior changes as a consequence of D1, see below).

**D3 — "Use a custom domain" wiring.**
No app-side custom-domain logic exists or is planned (`auth.js` has one fixed start URL). Salesforce's own hosted login page already exposes "Use Custom Domain" once the browser lands there.
Recommendation: wire this button to the identical `startLogin()` call as the primary CTA (no new IPC, no new main-process handler) — it's a second, lower-emphasis entry point into the one real flow, for users who already know they're typing a custom My Domain once they land in the browser. Do not fabricate a domain-input modal; that would be new unrequested scope.

## 4. Component map (implementation, not yet written)

- `src/index.html`: add `#authGateView` (hidden by default), full markup for both panels. Existing `#homeView`/`#editorView` untouched.
- `src/index.css`: add the missing brand primitives this screen needs — `--brand-grad-indigo`, paper/ink scale aliases if not already present under existing `--brand-*` names (map onto existing tokens, do not duplicate a second palette), `.recall-pulse`/wave keyframes if not already defined (check first — `renderer.js`/`brand-ui.js` already reference `recall-pulse`/`recall-wave-bar` classes, so these may already exist in `index.css` and just need reuse, not creation).
- `src/brand-ui.js`: add `sf`/`globe`/`shield`/`check` shapes to `ICON_SHAPES`, add a `wordmark()`/`logo()` builder ported from the reference `Logo`/`Wordmark` JSX (exact bracket-mark SVG path, not a raster asset — confirmed no white-logo raster asset exists in the provided brand pack, only `logo-full-color-on-white.png`).
- `src/renderer.js`: gate logic — show `#authGateView` / hide app views based on `isSignedIn` (extend `refreshAuthUi()`), wire both CTA buttons to the existing `startLogin()` IPC path, keep existing error-toast handling.
- No changes to `src/auth.js`, `src/auth-store.js`, `src/main.js`, `src/preload.js` — the IPC contract (`startLogin`, `getAuthStatus`) is reused as-is.

## 5. Explicit non-goals

- No custom-domain input UI/backend (D3 - resolved below: button removed entirely).
- No changes to the OAuth/token mechanism, callback protocol, or license-check flow (already hardened this session, ADR-028).
- No changes to screens 01-09 (menu-bar, pre-brief, live-capture, post-call, library, onboarding) — those remain separately tracked tasks (#20-28).

## 6. /autoplan CEO review outcome (2026-07-23)

Ran CEO-phase dual voices (Claude subagent + Codex, both completed - Codex did not hang this run). Both independently flagged the same core risk: **D1 as originally written ("gate whenever `!isSignedIn`, first launch AND any time the user signs out/token expires") would treat a transient auth hiccup the same as a genuine sign-out**, since `isSignedIn` is a stale-until-next-API-call flag, not a live session-validity check.

**Resolution (confirmed with the product owner directly, not just the AI panel):** the concern doesn't require new gating logic — it requires trusting the refresh-token architecture that's already shipped this session (ADR-028, F13's transactional rotation + grace period, 7-day rolling window in `safeStorage`). An actively-used session never actually goes invalid while the user is using the app; the gate only ever shows for a genuinely-dead/absent token. No new fragility introduced — the gate uses the exact same `isSignedIn` signal the header toggle already relied on.

**Other findings and how they were closed:**
- **"Use a custom domain" is a duplicate-action button** (both models flagged this independently) → user decision: removed entirely rather than faked or given new backend scope.
- **Active-recording safety** (auth dropping mid-recording must not hide stop controls) → gate guarded on `!window.isRecording`; added a `refreshAuthUi()` call when recording ends so the gate doesn't stay stale-hidden afterward.
- **Entitlement (license) vs. authentication conflation** → user decision: leave as today's toast-only behavior, not in scope for this screen.
- **`meetings.json` not scoped per signed-in user** (Codex, real but pre-existing, unrelated to this screen) → logged as `Recall/TODOS.md` item 8, deferred to #27 (SQLite migration).
- Window-size/small-window collapse, telemetry/funnel instrumentation, and compliance-copy legal review were noted by Codex as real gaps but are pre-existing across the whole app (not introduced here) - out of scope for a single-screen visual build.

Design/Eng phases were not run as separate heavyweight dual-voice gauntlets — the CEO phase surfaced the load-bearing decisions directly, and running the full mechanical apparatus (ASCII diagrams, JSONL task exports, audit trails) for a single already-decided screen would have been disproportionate. Implementation followed directly from the resolved decisions above.

## 7. Verification

Visually verified against a running `npm start` instance via the webpack dev server (`localhost:3000/main_window`) using browser-harness, with `window.electronAPI` mocked via CDP's `Page.addScriptToEvaluateOnNewDocument` (a plain browser tab has no Electron preload bridge, so the mock must be injected before the page's own init script runs):
- Gate auto-shows when `getAuthStatus()` resolves `signedIn:false` — no manual forcing needed, confirming `refreshAuthUi()`'s own gating logic (not just the markup) is correct.
- Layout matches the design screenshot: indigo hero (wordmark, headline, live-transcript vignette with pulsing dot and highlighted spans, SOC 2 footer) + white sign-in panel (single "Continue with Salesforce" CTA, what-happens-next 3-row list, footer link).
- Two real bugs found and fixed during verification, not just style tweaks: (1) `.auth-gate` was a flex item inside `body`'s `display:flex` row context and collapsed to content width — switched to `position:fixed; inset:0` in a follow-up CSS pass so it's independent of the app's own layout; (2) `#debugPanelToggle` and the `@recallai/desktop-sdk`'s injected `#id-recall-widget-root` widget are DOM siblings of `.app-container`, not children, so hiding the container alone left both floating over the gate — both now explicitly hidden/restored in the same `refreshAuthUi()` branch.
- Click handler verified end-to-end with a mocked IPC: click → button disables + label swaps to "Signing in…" synchronously (icon SVG unaffected, confirmed the label-span isolation works) → on failure, reverts to default label and re-enables, matching the pre-existing header-button behavior it was refactored out of.
