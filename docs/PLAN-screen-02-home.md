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

## 6. Explicit non-goals (this pass)

- Row-click "pre-call detail popover" (§2.4: linked record, participants, [Change link]/[Don't capture this one]) — not built; would need its own interaction-state design (T11), not assumed here.
- ⌘K command palette / full search grammar (§8) — out of scope; existing simple substring title filter stays as-is.
- Capture-mode pill variety ("Bot joins"/"Both") — needs the capture-policy pre-check service; every row shows "You capture" honestly.
- Tomorrow-morning preview (§7, after 5PM) and Library's infinite-scroll/date-grouping — Library itself (#27) isn't built yet.
