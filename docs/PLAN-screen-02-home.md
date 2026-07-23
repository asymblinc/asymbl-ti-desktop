# PLAN — Screen 02/02b: Home / Today Dashboard

## 0. Goal

Build the Home/Today dashboard (`docs/screen-specs/02-home-today.md`) pixel-perfect from `desktop/home.jsx`, deferring all *logic* to what actually exists in this codebase — not the design mock's assumed backend. Includes the 02b live-recording variant.

## 1. Current state (verified against live code, not the design's assumptions)

Before this pass, `#homeView` (`src/index.html`) was a single "Notes" list — no greeting, no schedule, no hero, no rail, no live strip. The app-level header (`.header` in `index.html`, outside `#homeView`) already has a real search input (`renderNotesInto`'s substring filter) and a real "New capture" equivalent (`#newNoteBtn` → `createNewMeeting()`, the design's exact "manual start / orphan path" intent) — the design's per-screen header duplicates concepts this app already implements at the app-chrome level, so this build does **not** add a second header inside the dashboard.

Real data available at build time:
- SF `Event` (screen 01's `next-event.ts`) — single next event only.
- Local `meetings.json` (`pastMeetings`) — notes, transcripts, no persisted per-meeting duration.
- `notes-sync.js`'s `pendingRetries` map — real failed-sync state, never exposed anywhere.
- `auth-store.js` — real signed-in state (`window.isSignedIn`, already wired for the header/gate).
- No calendar (Google/Outlook) integration (TODOS.md #13). No Smart-attach (#25). No bot-join/consent flow. No extraction-status webhook back to desktop.

## 2. Target (design + spec source of truth)

`desktop/home.jsx` (Downloads reference) + the full pasted spec, written verbatim to `docs/screen-specs/02-home-today.md` (including §7 time-model/scroll boundaries and §8 search capability, both added in the fuller spec revision).

## 3. Decisions this build settles

1. **Schedule data source:** extend `next-event.ts` (screen 01) with `getTodaySchedule` rather than build a second parallel query path — same fields, same escaping, bounded to end-of-day instead of `LIMIT 1`. Google/Outlook merge stays exactly where TODOS.md #13 already left it (not started).
2. **"Needs attention" queue types:** only build what has real data. `notes-sync.js`'s `pendingRetries` (waiting-to-sync) and a transcript scan for unresolved `Speaker N`/`Unknown Speaker` (speaker-labels) are real. Orphan-to-link, consent-pending, and failed-extraction are genuinely absent from this codebase — rendered as "not built" here rather than faked, same standard as screen 01's tray `attention` state (TODOS.md #11).
3. **Per-meeting duration:** `finalizeDesktopRecordingSession` already computed `durationS` for telemetry only. Added a `fileOperationManager.scheduleOperation` write (same transactional pattern as every other `meetings.json` mutation, T14) to persist it onto the meeting record — this is what makes "Recent captures" durations and the "hours recorded" stat real instead of fabricated.
4. **"This week" stats:** captures + hours recorded are real (computed from local data). Synced-to-SF and signals-extracted show `—`, not a fake number — nothing in this app tracks either yet.
5. **Connection status:** real SF-token check (`window.isSignedIn`) + real mic-permission check (new `getMicPermissionStatus` IPC, Electron `systemPreferences.getMediaAccessStatus`, macOS/Windows only per Electron's own docs — other platforms default to `'granted'`, the honest default where no preflight concept exists). Calendar is **never** "connected" — this correctly renders the design's own degraded state (§4.2), not a bug, since the open question in the spec itself ("recommend skippable") already anticipated this.
6. **02b live strip data plumbing:** `preload.js` already declared `onRecordingStateChange` for a `'recording-state-change'` IPC channel that `main.js` never actually sent (a dead channel, found while wiring this). Reused it rather than inventing a second channel — `main.js`'s `recording-started`/`recording-ended` SDK listeners now actually call `mainWindow.webContents.send('recording-state-change', ...)` with `{noteId, state, recordingId, startedAt, title}`.
7. **"Open capture" (02b):** routes to the existing note-editor view (`showEditorView`) — there is no separate Live Capture window in this codebase (that's screen 05/06, task #24, not built), so the note editor genuinely is where a live capture is "opened" today.
8. **"Library →" link:** the Library screen (#27) doesn't exist yet. The link scrolls to the existing full Notes grid (kept, unchanged, below the new dashboard) rather than pointing at a screen that isn't built.
9. **Layout conflict avoided:** `renderMeetings()` wipes and rebuilds `.main-content .content-container` on every reload. The new dashboard markup lives as a sibling block *outside* that container (not nested inside it), so the existing Notes-rebuild logic and the new dashboard never fight over the same DOM subtree.

## 4. Architecture — data flow

- **Schedule:** `main.js` polls `controlPlaneClient.fetchTodaySchedule()` every 5 min (mirrors the existing `refreshNextEvent` cadence) → pushes via `today-schedule-updated` IPC → renderer holds `homeTodaySchedule`, re-renders hero + schedule rows.
- **Recording state:** `main.js`'s SDK listeners → `recording-state-change` IPC (now actually sent) → renderer holds `homeLiveRecording`, drives the 02b strip, the schedule's LIVE pill, and the hero's collapse.
- **Recent/stats/attention:** all derived synchronously from `pastMeetings` (already loaded via `loadMeetingsDataFromFile`) plus one async fetch of `getPendingSyncMeetingIds()` per refresh (`refreshHomeDashboard()`), called after every meetings-data reload and on returning to Home from the editor.
- **XSS:** SF `Event.Subject`/`Location`/`Who.Name` and local note titles are free-text, externally/user-influenced strings. Every `innerHTML` write built from them goes through `DOMPurify.sanitize()` (already imported in `renderer.js` for the live-transcript panel — same pattern, not a new dependency).

## 5. Verification

Visual pass via `browser-harness` against the webpack dev server, both the idle dashboard and the 02b live-recording variant, with injected mock state (schedule rows, recent captures, needs-attention items, recording on/off) — same technique used for screen 01's popover.

## 6a0. Direct claude_design MCP verification (2026-07-23)

Earlier pixel-fidelity passes worked from local mirrored files (`/Downloads/TI Recall (1)/`) and live screenshots, not the `claude_design` MCP itself. Connected directly to project `019de4a3-82fc-70a7-a039-c5cdb112e5cf` and read the two authoritative sources in the project:

- `tokens.css` (the canvas's own token file) - confirmed identical to the local mirror; found the amber/blue "ink" text colors this build used (`#8a5e00`/`#0264ac`, inherited from screen 01's popover.css) were slightly off from the canonical `#a36d00`/`#0273c4` - fixed in both `index.css` (screen 02) and `popover.css` (screen 01, same tokens).
- `CLAUDE-CODE-HANDOFF.md` §12 - the file's own precedence comment already in `index.css` (line 16-22) says this doc's colors override the canvas's ("older warm/cream, to be replaced"). §12.1's token block pins `--asy-grad-indigo: linear-gradient(0deg,#191D47,#2C1169)` - **0deg**, not tokens.css's 160deg. First attempted a "fix" toward 160deg (tokens.css value) before reading this doc; reverted immediately once the authoritative override was confirmed - `--brand-grad-indigo` stays at 0deg, matching what was already correct in the code before this pass.
- Confirmed via `list_files` that the project's `desktop/home.jsx` and `screen-specs/02-home-today.md` are byte-identical in structure/size to the local Downloads mirror this build was actually developed against - the local reference files were accurate, not stale.

## 6a-0.5. Full component / color / button / animation audit (2026-07-23)

Comprehensive pass against `desktop/home.jsx`, `tokens.css`, and `CLAUDE-CODE-HANDOFF.md` §12 via the `claude_design` MCP - not a spot-check. Two more real color drifts found beyond the amber/blue fix (§6a-0):

### Color audit (every `--brand-*` token + every literal hex in the new CSS)

| Token / value | This build | Canonical source | Result |
|---|---|---|---|
| `--border-color` | was `#e0e0e0` (pre-brand-system legacy) | `tokens.css --paper-edge: #dfe3ee` | **Fixed** - global token, ~25 usages across `index.css`/`popover.css` (every hairline/divider/card border in the whole app, not just screen 02) |
| `.home-rail` background | was `#f7f8fb` (approximated) | `home.jsx`: `background: 'var(--paper-2)'` = `#f4f6fb` | **Fixed** |
| `.home-avatar` text (`#024a82`) | as built | `tokens.css --accent-ink: #024a82` | Exact match |
| chip/pill blue ink (`#0273c4`) | fixed in §6a-0 | `tokens.css --blue: #0273c4` | Exact match |
| chip/pill amber ink (`#a36d00`) | fixed in §6a-0 | `tokens.css --amber: #a36d00` | Exact match |
| green ink (`#068a4f`), rec-bg (`#fde7e7`), tint-blue/yellow/green/purple/pink, `--brand-purple`/`-pink`/`-green`/`-yellow`/`-orange`/`-record-red`, all three 90deg gradients | as built | `CLAUDE-CODE-HANDOFF.md` §12.1 (authoritative over the canvas per its own precedence rule) | Exact match, no drift found |
| `--brand-grad-indigo` direction | `0deg` (unchanged) | `CLAUDE-CODE-HANDOFF.md` §12.1 pins `0deg`; `tokens.css`'s `160deg` is the superseded canvas value | Confirmed correct as-is (see §6a-0 - a "fix" toward 160deg was caught and reverted) |
| hero overlay rgbas (kicker `0.65`, mode-pill bg `0.14`, sub `0.7`) | as built | `home.jsx` literal values | Exact match |
| `.meeting-card:hover` bg (`#f9fafc`) | as built | not specified (static mockup has no hover state) | Reasonable implementation judgment, not a drift |
| Cleanup: `--light-purple`/`--light-green` root tokens | removed from `index.css` | - | Dead - only consumer was the `.meeting-icon.calendar`/`.document` rules already deleted this pass; a separate copy still lives in `src/pages/note-editor/styles.css`'s own `:root`, untouched |

### Component checklist (`home.jsx` → this build)

| Design component | Built as | Status |
|---|---|---|
| Header (wordmark, search+⌘K, New capture) | Reused app-level `.header` (restyled light, not duplicated - see §1) | Done |
| 02b live-recording strip (pulse, mono timer, title, sub, 5-bar waveform, Open capture, Stop & save) | `#homeLiveStrip` | Done, real IPC-driven |
| Greeting + date | `#homeGreeting`/`#homeDate` | Done, real (schedule-length-driven copy) |
| Up-next hero (kicker, mode pill, avatar, title/sub, Open Pre-Brief) | `#homeHero` | Done; mode pill fixed to "You capture" (no capture-policy service yet); Pre-Brief honest no-op |
| Today's schedule rows (time/LIVE, avatar, title/sub, duration+platform, mode pill) | `#homeScheduleList` | Done, real SF Event data |
| Recent captures (avatar, title, sub, sync chip) | Notes list (`createMeetingCard`, retitled - see §6a "redundant Notes list") | Done, real local data |
| Right rail: Needs attention | `#homeAttentionList` | Done for 2/5 queue types (real data); other 3 have no backing service anywhere in this app (TODOS.md #11) |
| Right rail: This week (4 stats) | `#homeStatsGrid` | Done; 2/4 real, 2/4 honestly `—` (not tracked anywhere) |
| Right rail: Connection status | `#homeConnectionCard` | Done, real SF-token + mic-permission checks |

### Button/action checklist (every clickable element → real handler or documented placeholder)

| Element | Wired to | Real or placeholder |
|---|---|---|
| Header "New capture" | `createNewMeeting()` | Real |
| Header "Record {platform}" | existing join-detected flow | Real (pre-existing); now only shown once a meeting is detected |
| Header search | `renderNotesInto` substring filter | Real (pre-existing) |
| Hero "Open Pre-Brief" | `console.log` no-op | Documented placeholder (#22/#23 not built - matches the tray's identical `openPreBrief` decision) |
| Empty-schedule "New capture" | `createNewMeeting()` | Real |
| Empty-schedule "Connect calendar" | `console.log` no-op | Documented placeholder (TODOS.md #13) |
| Attention "waiting to sync" row | new `retryNoteSync` IPC | Real |
| Attention "speakers need labels" row | `showEditorView` (opens the note) | Real navigation; no inline relabel UI exists yet (only C5's post-call relabel is speced, not built - not a screen-02 regression, just an honest boundary) |
| Recent-capture row click | `showEditorView` | Real (pre-existing) |
| "Library →" link | scrolls to the notes list | Real scroll; no separate Library screen exists yet (#27) |
| 02b "Open capture" | `showEditorView` on the live note | Real |
| 02b "Stop & save" | `stopManualRecording` IPC | Real |
| Note delete button | `deleteMeeting` | Real (pre-existing, untouched) |

### Animation/motion checklist

- `.recall-pulse` and `.recall-wave-bar` keyframes in `index.css` are byte-identical (timing, easing, scale/opacity values) to `tokens.css`'s own `@keyframes recall-pulse`/`recall-wave` definitions - confirmed by direct comparison, not assumed.
- No GIFs anywhere in `desktop/home.jsx` or this build - confirmed by reading the source file directly; the original goal's "gifs" mention doesn't apply to this specific screen.

## 6a. Post-build pixel-fidelity pass (2026-07-23, live-screenshot review)

The first pass rendered correctly but was flagged against the design as "not pixel perfect" via direct screenshots of the running app (both the real signed-in app and the Claude Design canvas reference). Fixed in this pass:

- **Header** was still the pre-existing navy `#022D60` app-chrome bar - the design's Home header is white. Restyled `.header` and its children (wordmark now includes "by asymbl.", search became a rounded pill with a ⌘K badge, "New capture" is now the one solid primary CTA, "Record Meeting" only appears once a meeting is actually detected instead of always showing disabled) to match, while keeping the same element IDs/handlers so Editor view's back-button swap is unaffected.
- **"Recent captures" rows** were still using the old boxy white-card-with-colored-icon-box style (`createMeetingCard`, unchanged from the pre-dashboard Notes grid) instead of the design's clean avatar+title+meta+chip row. Rewrote `createMeetingCard`'s markup/CSS to match (reusing the already-defined `.home-avatar`/chip styles), added a real "58m · Today 11:00 AM"-style meta line (`homeRecentMeta`), and removed the now-dead `.meeting-icon`/`.profile-pic` CSS this replaced.
- **Needs-attention rows** had a plain "●" character standing in for an icon and no click action. Replaced with real inline SVG icons (upload/users) and wired real actions: "waiting to sync" now calls a new `retryNoteSync` IPC (retries `notes-sync.js`'s sync immediately instead of only opportunistically on the next unrelated success), "speakers need labels" opens the note for review.
- **Empty-schedule card** only had one action; spec §4.1 wants two ("New capture" + "Connect calendar" when calendar isn't connected, which is always true here). Added the second button (honest no-op - no calendar integration exists, TODOS.md #13) and de-duplicated its copy against the greeting's own "nothing scheduled" line.
- **Schedule-source label** ("Salesforce interviews") was missing the small calendar glyph the design shows next to it - added.
- **Date/time formatting** used the system locale (`toLocaleDateString`/`toLocaleTimeString` with no explicit format), which under this app's `--lang=en-GB` launch flag renders "Thursday, 23 July" and 24-hour times ("14:30") instead of the design's explicit "Tuesday, July 22" / "2:30 PM" - both now format explicitly, independent of system locale.
- **Redundant Notes list**: feedback ("notes is recent captures") - the dashboard had a 3-item "Recent captures" preview stacked directly above the full, separate Notes grid, both rendering the same underlying data. Removed the preview; the existing Notes list (restyled per above, retitled "Recent captures") is now the one list.
- **Dock icon**: a live screenshot showed the app's Dock icon as a hard-edged square next to every other app's rounded squircle icon. Root cause: `src/assets/asymbl-icon.png` (also the in-app header logo, where a flat square is correct) is a flat square with fully-opaque corners, and both the dev-mode `app.dock.setIcon()` call and the packaged `asymbl.icns` were built directly from it. Added `scripts/gen-macos-icon.py` (one-off, Pillow-based - anti-aliased rounded-rect masking by hand in Node would be disproportionate effort) to produce `asymbl-icon-macos.png` with the standard Big Sur squircle shape + padding, regenerated `asymbl.icns` from it, and pointed `main.js`'s dev-mode dock icon at the new asset.
- **"Why isn't Today's schedule pulling real SF events?"** (live question while testing): traced to `desktop-dev*.log` showing `Session refresh failed: reuse_detected` - a persisted refresh token from an earlier dev-session restart was rejected by the auth server's rotation/reuse-detection defense (plausible root cause: this session's own repeated hard `pkill`-restarts during testing interrupted a token-rotation disk write). This is the security feature working correctly, not a wiring bug in `getTodaySchedule`/`next-event.ts` - `control-plane-client.js`'s `refreshSession()` already calls `authStore.clearTokens()` on the resulting 401, so the app correctly falls back to requiring a fresh sign-in rather than silently misbehaving. No code change needed; noted here since it looked like a data-pull bug from the UI alone.

## 6b. Security & performance assessment (2026-07-23)

The original goal named both explicitly ("secure and performative are part of this always"). Security review already happened inline throughout the build; this section is the explicit write-up for both, so neither is just implied.

### Security

- **XSS:** every `innerHTML` write in `renderHomeSchedule`/`renderHomeAttention` built from externally-influenced data (SF `Event.Subject`/`Location`/`Who.Name`, local note titles) goes through `DOMPurify.sanitize()` - the same mitigation `renderLiveTranscript` already used elsewhere in this file, not a new pattern. Writes built from fully-static or internally-computed strings (`renderHomeStats`, `renderHomeConnection`) skip it correctly - nothing user-controlled flows into them.
- **SOQL injection:** `getTodaySchedule`'s `sfUserId` interpolation goes through the same `escapeSoqlString` already used (and injection-tested) for `getNextEvent` - the date bounds (`now.toISOString()`/`endOfDay.toISOString()`) are server-generated, not attacker-reachable.
- **New IPC surface** (`retryNoteSync`, `getPendingSyncMeetingIds`, `getMicPermissionStatus`): all operate on local data only (a `meetingId` string used in an in-process `.find()`, no filesystem path construction, no shell execution) or call parameterless native Electron APIs - no injection surface, no new privilege boundary crossed (contextIsolation/no nodeIntegration unaffected).
- **New control-plane route** (`/api/ti/desktop/today-schedule`): gated by the same `requireAuth` JWT check every other route uses; the SF `OwnerId` filter is bound to `claims.sf_uid` from the verified JWT, not a client-supplied parameter - a user cannot query another user's schedule.
- **Real production bug found and fixed, not just reviewed:** `/auth/refresh` was crashing on every call (ADR-029) - a genuine availability/security-adjacent issue (a session that can never refresh is a session that silently dies), root-caused via real Cloud Run logs and fixed with a proper per-user SF session, not a workaround.
- **Real multi-tenancy gap found and documented (not fixed - owner decision):** TODOS.md #18 - the shared Recall.ai API key means recorded interview media isn't isolated per customer today, despite ADR-022's silo-model intent.

### Performance

- **Polling cadence** (all in `main.js`): `runSessionRefresh` 10 min, `refreshNextEvent`/`refreshTodaySchedule` 5 min each - three lightweight HTTPS calls at low frequency, not a tight loop; matches the pre-existing screen 01 cadence, not a new pattern.
- **Tick intervals**: `pillTickInterval` (tray) and `homeTickInterval` (Home live strip) both 1s, both gated to only run while a recording is actually active (`setRecordingActive`/`onRecordingStateChange`), and each only updates one `textContent` per tick - negligible cost, cleared on stop.
- **DOM rebuild cost**: `renderHomeDashboard()`'s five render functions and `renderMeetings()` each do a full `innerHTML` rebuild of their own small section (schedule: ≤20 rows: attention: 0-2 rows; stats: 4 cards; notes list: local session count, typically tens) - cheap, and only triggered by real events (a data reload, a 5-min poll tick, a recording state change), never on a timer loop of its own.
- **Real fix, not just review:** the schedule-fetch startup race (`refreshNextEvent`/`refreshTodaySchedule` losing the race against the async session refresh on cold start) was a real correctness-under-load bug - fixed by calling them from the refresh's own success branch, not by shortening the poll interval (which would have just papered over the race with more frequent polling).
- **`getMicPermissionStatus` called on every `renderHomeConnection()`**: a native OS call that rarely needs to change at runtime, re-queried on every dashboard refresh. Real, minor, not fixed here (the actual cost is near-instant, no I/O) - noted as a legitimate micro-optimization opportunity (cache + periodic refresh) rather than gold-plated away given the negligible measured impact.

## 6. Explicit non-goals (this pass)

- Row-click "pre-call detail popover" (§2.4: linked record, participants, [Change link]/[Don't capture this one]) — not built; would need its own interaction-state design (T11), not assumed here.
- ⌘K command palette / full search grammar (§8) — out of scope; existing simple substring title filter stays as-is.
- Capture-mode pill variety ("Bot joins"/"Both") — needs the capture-policy pre-check service; every row shows "You capture" honestly.
- Tomorrow-morning preview (§7, after 5PM) and Library's infinite-scroll/date-grouping — Library itself (#27) isn't built yet.
