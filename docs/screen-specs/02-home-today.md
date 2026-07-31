# Screen Spec — Home / Today (Desktop 02)

**Screen:** `02 · Home / Today dashboard` (+ new variant `02b · Home · while recording`) · component `Home` in `desktop/home.jsx`.
**Build refs:** control-plane `bootstrap` + sessions endpoints (shipped in `gcp/control-plane`), SF interviews feed, local SQLite library · Spec B F5/F6/F8 · Handoff C5, §12.
**Doc series:** 03 of N in `screen-specs/`.

---

## 1. Purpose & stance

Home answers three questions in priority order: **(1) what's about to happen, (2) what needs me, (3) what just happened.** It is a *briefing*, not a dashboard — no vanity charts, nothing the user can't act on. Every element is either a next action or a queue.

## 2. Anatomy — component by component

### 2.1 Header (persistent across Home/Library — same component)
| Element | Intent | Data | Notes |
|---|---|---|---|
| Wordmark | orientation | static | click = Home (this screen is the logo's home) |
| Search field ⌘K | recall anything said in any call | local SQLite index (titles, participants) + control-plane transcript search when online | placeholder names the objects: "transcripts, candidates, accounts" — teaches scope |
| **New capture** (ink button) | manual start — the escape hatch when detection/calendar fail | starts an unscheduled session (orphan path) | must never be more than one click from anywhere |

### 2.2 Greeting + date
Time-aware greeting, count of today's calls. Data: schedule feed length. If zero calls: copy flips to invitation, not blankness — see §4.1.

### 2.3 "Up next" hero (indigo gradient — the screen's single hero, §12)
| Element | Intent | Data |
|---|---|---|
| Countdown kicker "in 12 min" | urgency without a clock check | meeting start − now, ticks live |
| Capture-mode pill (You capture / Bot joins / Both) | zero-surprise about *how* this call gets captured | capture-policy pre-check for the meeting URL |
| Identity (avatar, title, sub) | confirm the *who/what* linkage before the call | linked record (Interview__c → candidate/job; Opp → account; none → title only) |
| **Open Pre-Brief** CTA | the highest-value pre-call action | Pre-Brief service (F14); hidden when unlicensed (F12-B) or when the meeting has no linked record (nothing to brief) — button becomes "Add context" |
Hero appears only when the next meeting is < 2h away; otherwise the schedule list leads and the greeting carries the day count.

### 2.4 Today's schedule
Rows: time (mono; **blue when current**) · avatar · title/sub · duration+platform · capture-mode pill. Right-side label "Salesforce interviews" is dynamic — it names the *sources actually connected* ("Salesforce + Google Calendar").
**Data merge order:** (1) SF interviews (Interview__c with meeting URLs — authoritative for recruiting), (2) calendar events (Google/MS — everything else: HM syncs, sales calls, internal), de-duped by meeting URL; SF wins conflicts and supplies the richer sub-line. Calendar events with no SF match render with a neutral calendar glyph instead of a record avatar and mode pill defaults to "You capture · unlinked".
Row click → pre-call detail popover: linked record, participants, mode, consent jurisdiction note, [Change link] [Don't capture this one].

### 2.5 Recent captures (bridge to Library)
Last 2–3 sessions, sync-state chip (`Synced` green / `Local` amber / `Private` neutral / `Failed` red + retry). Data: local SQLite session store — **renders offline**, always. "Library →" link is the only navigation to history.

### 2.6 Right rail — Needs attention (the work queue)
Same queues as the tray's `attention` state, one source of truth:
| Queue | Trigger | Action on click |
|---|---|---|
| Waiting to sync | local session, no upload | retry / view error |
| Speakers need labels | post-call with unresolved Speaker A/B | opens post-call relabel |
| Orphan to link | capture with no record match | link picker (§6) |
| Consent pending | two-party bot call awaiting candidate grant | shows consent-link status, resend |
| Failed extraction | `Extraction_Status__c=failed` | view + re-run |
Empty queue = the green "all clear" card (§4.4). Never show an empty list frame.

### 2.7 Right rail — This week (4 stats)
captures · hours · synced-to-SF · signals extracted. Intent: habit reinforcement + silent health check (synced ≪ captures = something's wrong). Data: local store + control-plane meters. Not configurable, not a chart.

### 2.8 Connection status card
Green "All systems connected" resolves from: SF token valid · calendar connected · mic permission · (optional) bot workspace reachable. Any failure flips the card into a fix-it row — see §4.2/§4.3.

## 3. NEW — 02b: Home while recording (design updated)

When a session is live, Home does not freeze — it gets a **live strip** pinned under the header (canvas artboard 02b):
- Red pulse + mono elapsed · session title + linked record · mini waveform · `Open capture` (primary) · `Stop & save` (red ghost).
- The "Up next" hero collapses (you're *in* the meeting) — schedule stays, the current row shows a red LIVE pill instead of its time.
- Everything else remains browsable: the whole point is that navigating Home/Library mid-call **never interrupts capture** (session is owned by the main process; windows are views — same rule as live-capture N10).
- Navigation back: `Open capture` returns to the Live Capture screen with scroll + notes cursor restored. Closing the capture window ≠ stop; only `Stop & save` (here, in the capture screen, or in the tray) ends the session — three stops, one state machine.

## 4. Empty / degraded states (every one designed, none blank)

1. **No calls today:** greeting flips ("Nothing scheduled — capture an unscheduled call anytime"); hero is replaced by a quiet two-action card: `New capture` + `Connect calendar` (if not connected). Recent + rail still render.
2. **Calendar not connected:** schedule shows SF interviews only, plus one dismissible inline row (not a modal): "Connect your calendar to see non-Salesforce calls here → Connect". Data source label reads "Salesforce interviews only". If BOTH calendar and SF-feed are empty, the schedule section shows the onboarding illustration + connect actions — mirrors onboarding step 2 (screen 10).
3. **Salesforce disconnected / token dead:** red fix-it card replaces the green status card ("Reconnect Salesforce — captures keep working and will sync when you're back"); capture itself is never blocked, sync queues locally (rail shows growing "Waiting to sync").
4. **All queues empty:** green all-clear card. 5. **First run ever:** Recent section shows a single ghost row ("Your first capture will appear here"). 6. **Offline:** banner "Offline — everything keeps working locally"; search limited to local; stats freeze with a stale-time note.

## 5. Non-recruiting use (sales, HM, internal — thought through)

- **Meeting kinds are config, not code.** A capture's kind (candidate-intake, HM intake, sales discovery, account check-in, internal sync, 1:1…) derives from: linked record type → calendar event heuristics → user override in the pre-call popover. Kind drives chip categories (live-capture §3), extraction template (C1), and library grouping.
- **HM calls:** an HM intake linked to a Job renders sub as `Role · Account/Dept`; its post-call signal (must-haves, panel changes) rolls up to the Job record (C2). HM *relationship* history lives on the Contact — same mechanics, different record.
- **Sales calls:** link target is Opportunity; "Bot joins" works identically (bot dispatch isn't recruiting-specific — the platform event carries a record id, not a candidate).
- **Internal calls:** linkable to nothing — `Private` by default (never syncs to SF; stored local/tenant only). The kind picker's "Internal" option sets this in one gesture. This is the trust feature that makes people leave it running.

## 6. Organization / folder structure (how captures are filed)

**No user-managed folders.** Captures are auto-filed by their *link*, and the Library sidebar renders that filing (All / Recent / Pinned / Local-only + By kind). Rationale: recruiters won't file; the record link IS the folder. What we add instead:
- **Pin** (manual, flat, max ~20) for active searches/deals.
- **By kind** facets (already in Library sidebar) + by-account/by-job smart groups computed from links.
- **Local-only** = the privacy drawer (internal + private captures).
- Linking is many-to-one and editable forever: re-link moves the capture's filing everywhere at once (Home queue, Library, SF) — no copies.

## 7. Time model, scrolling & load boundaries (big-picture check)

**Home is a fixed time window, not a feed.** It shows exactly: today's schedule (+ tomorrow-morning preview after 5 PM local, collapsed under a "Tomorrow" divider) and the last 2–3 captures. **No infinite scroll on Home, ever** — unbounded content belongs to Library. This is the architectural line between the two screens:

| | Home | Library |
|---|---|---|
| Time model | fixed window (today ± preview) | all history |
| Scroll | page scrolls only if today overflows; no pagination | **infinite scroll**, date-grouped (Today / This week / July / June…), cursor-paged from SQLite 50 rows at a time |
| "Load more" | never | automatic on scroll; jump-to-date via sidebar month list when history > 6 months |
| Empty past | n/a | ghost row (§4.5) |

Rationale: Home must be *finishable* — the user reaches the bottom and knows they've seen everything that matters today. A feed that never ends kills that. The "Library →" link and search are the two doors to history.

## 8. Search — capability definition

**Model: one search, scoped results — not folder-based.** Search never asks "where do you want to look"; it looks everywhere the user can see and *groups* results by object type. Folders don't exist (§6), so search is the primary retrieval path and must carry that weight.

**Invocation:** ⌘K anywhere (Home, Library, post-call, even during capture) → command-palette overlay (Raycast pattern), also the header field. Same component everywhere.

**Index architecture (two tiers):**
1. **Local tier (SQLite FTS5, always available):** session titles, participants, linked-record names, meeting kinds, user notes, and transcript text of locally-stored sessions. Instant (<50ms), works offline, zero server cost. This is the index the header placeholder promises.
2. **Tenant tier (control-plane search over tenant Supabase, online only):** full transcript text across ALL the user's synced captures + extracted signals ("comp over 200k", "mentioned Terraform"). Results stream in under the local results with a subtle "from your workspace" divider. Respects record-level visibility: the API filters by what the SF user can see — desktop never queries Supabase directly.

**Result groups (in rank order):** Captures · People (candidates/HMs/contacts) · Accounts & Jobs · Moments (transcript hits, with ±15s context snippet + jump-to-timestamp deep link into the recording) · Actions ("Start capture", "Connect calendar" — palette verbs).

**Query grammar (progressive, no syntax required):** plain words → ranked FTS; recognized filters as chips as you type — `kind:` (intake, sales…), `with:` (participant), `on:`/`before:`/`after:` (dates, natural language ok), `in:` (job/account/opp), `is:` (local, private, unsynced, unlabeled), `said:` (transcript-only). Filters compose: `said:"sign-on bonus" with:maya after:june`.

**Ranking:** recency-weighted BM25; boosts: linked-record matches > title > participant > transcript; pinned captures +; exact-phrase transcript hits surface as Moments regardless of age.

**Privacy rules:** private/local-only captures appear ONLY in local-tier results on this device, marked with the lock glyph; they never round-trip through the tenant tier. Search-as-you-type queries are never logged with content (PII rule — log query length + result counts only).

**Degraded:** offline → local tier only + "offline — workspace results unavailable" footer; tenant tier timeout (>800ms) → render local, stream late results when they arrive; zero hits → offer scoped retries ("search transcripts only", "include archived") + `New capture` action, never a bare "no results".

## 9. Data sources — summary table

| Surface | Source | Offline behavior |
|---|---|---|
| Schedule | SF interviews (control plane) + calendar provider, merged | last cached feed, stale badge |
| Up-next hero + mode pill | capture-policy pre-check | hidden (mode resolves at detection) |
| Pre-Brief | F14 service, 30-min cache | cached brief or hidden |
| Recent + Library | local SQLite (source of truth for sessions) | full |
| Attention queues | local store + control-plane status | local queues only |
| Stats | local + OpenMeter | local only, stale note |

## 10. Scenarios

**P1** morning glance → hero → Pre-Brief → call → 02b strip → stop → post-call. **P2** back-to-back calls: stop first → post-call opens; next hero already counting down; "review later" defers to attention queue. **P3** HM sync from calendar (no SF record): row shows unlinked → pre-call popover → link to Job → captures as HM intake. **P4** private internal call: kind=Internal → Local-only, zero SF traffic.
**N1** double-booked slot: both rows render, policy pre-check marks which one the bot covers; desktop captures the one you join. **N2** meeting with no URL (phone screen): row renders with phone glyph; `New capture` starts it manually; links to the Interview record. **N3** hero meeting cancelled in SF: hero swaps to next meeting within one poll cycle (≤60s); if the bot was dispatched, CANCEL event already handled it upstream. **N4** clock near midnight: "today" rolls at local midnight; in-flight session keeps its start date. **N5** 40-call day (agency): schedule virtualizes, hero still only < 2h. **N6** search for a call from 8 months ago by a phrase the candidate said: ⌘K → `said:` moment hit → jump-to-timestamp — this is the retrieval promise folders would have broken. **N7** two candidates with the same name: People results disambiguate by job/account sub-line; never merged.

## 11. Open questions
1. Calendar connect at onboarding (step 2 currently shows it) — required or skippable-forever? Recommend skippable; Home degrades gracefully per §4.2.
2. Should "This week" stats be team-visible (manager view) later? Keep personal for MVP.
3. Pin limit + sort — flat MRU or manual order?
4. Tenant-tier transcript search: MVP or fast-follow? (Local FTS ships with the SQLite store for free; workspace-wide search needs a control-plane endpoint + Supabase FTS index — recommend fast-follow, ship local first.)
5. Should ⌘K Actions include record creation ("Create Interview for this capture") or stay read-only + capture verbs for MVP?

---

## 12. Build notes — what's real in this codebase today vs. spec aspiration

This section exists because the design file above is UI/UX truth, not a backend inventory — the actual build defers to whatever data genuinely exists in `gcp/control-plane` and the desktop app's local store (see project CLAUDE.md: "logic superseded by our code, UI pixel-perfect from design"). Tracked in `docs/PLAN-screen-02-home.md` and `TODOS.md`.

**Built for this pass:**
- Today's schedule + Up-next hero: real SF `Event` data via a new `getTodaySchedule` (extends `next-event.ts`, same fields/pattern as screen 01's tray card).
- Recent captures: real local `meetings.json` data (already the source of truth for Notes).
- Needs attention: only **Waiting to sync** (real, from `notes-sync.js`'s pending-retry state) and **Speakers need labels** (real, derived by scanning transcript entries for unresolved `Speaker N`/`Unknown Speaker` labels) are wired to actual data.
- This week stats: **captures** and **hours recorded** are real (computed from local meeting records + a new persisted `duration_s` field). **Synced to SF** and **signals extracted** are not tracked anywhere yet — shown honestly as unavailable, not fabricated.
- Connection status: real SF-token check (`auth-store.js`) + real mic-permission check (Electron `systemPreferences`). The empty-schedule state's calendar-connection control (`#calConnMenu`) now shows real "Salesforce · Connected" status (green dot) instead of a dead "Connect calendar" button, with disabled "Google Calendar"/"Outlook" rows previewing the still-unbuilt multi-source work (TODOS #13) — updated 2026-07-23, superseding the earlier "Calendar is never connected" framing below, which described the pre-fix dead-button state.
- Account dropdown (top-right avatar): shows org name + 18-char org ID + a "Sandbox" badge (when the connected org is a sandbox), above the email row — added 2026-07-23 (see backend ADR-030). Org name/badge are best-effort (most non-admin SF profiles lack "View Setup and Configuration"); falls back to showing just the org ID.
- Fixed 2026-07-23: the account dropdown's email row used to render blank on a fresh launch — `main.js` never fired the already-declared `auth-status-changed` IPC event after a session refresh completed, so the renderer's early auth check (before the access token was minted) was never re-asked once it was.

**Not built (tracked, not silently dropped):**
- Orphan-to-link / Consent-pending / Failed-extraction queues — no Smart-attach (#25), no bot-join/consent flow, and no extraction-status webhook back to desktop exist yet.
- Capture-mode pill always shows "You capture" — "Bot joins"/"Both" require the capture-policy pre-check service, not present in this pass.
- "Library →" has no dedicated screen yet (#27) — for now it surfaces the same local Notes grid already on this page.
- §8's full search grammar/command-palette is out of scope for this pass — the existing simple substring note-title filter stays as-is.
