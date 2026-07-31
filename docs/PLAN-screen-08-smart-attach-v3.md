<!-- /autoplan restore point: /Users/sdevinarayanan/.gstack/projects/asymblinc-asymbl-ti-desktop/TI-385-feat-bootstrap-fork-autoplan-restore-20260730-154951.md -->
# PLAN — Screen 08 Smart-attach restructure (v3)

**Status:** Draft — input to `/autoplan`.
**Branch:** `TI-385/feat-bootstrap-fork`
**Origin:** adversarial `/impeccable critique` of Screen 08 (2026-07-30), which scored the
screen 20/40 on Nielsen heuristics and failed 6 of 8 cognitive-load checks.

## 0. Goal

Cut the link-and-upload journey from **4–6 clicks to 2**, and resolve the rail-vs-flyout
split that currently has two competing surfaces for one job.

Non-goal: redesigning the summary/notes/transcript panes. This plan is scoped to the
Salesforce linking flow only.

## 1. Evidence this is worth doing

All measured, not asserted:

- The flyout is `position:absolute; top:64px; right:20px; width:380px` over a 320px rail.
  It covers **100% of the rail plus 80px of the main content pane**, clipping the TL;DR
  mid-sentence, at both 1920px and 1000px viewports.
- This is the **default state**, not an edge case — `link_status` defaults to `unlinked`
  for most captures, and `post-call.js:175` auto-opens the flyout on that condition.
- While the flyout is open, the rail underneath renders a full-width button offering to
  *"Open link flyout"*.
- `.pc-flyout-row` sets `cursor:pointer` and a hover background, advertising a 354×46
  click surface, but the only handler is `cb.onchange` on a **13×13** checkbox. There is
  no row click handler.
- Realistic click count for link+upload is **4–6** (entry, focus search, fix pre-check,
  Done, Confirm & upload).

## 2. The five candidate changes

### C1 — Delete the "Done" button
`confirmUploadMeeting` already performs a strict superset of `linkMeetingRecords`'
persistence work (it ships `linkedRecords` to control-plane and writes back
`linked_records` + `link_status: 'linked'`). The only reason both exist is that one reads
renderer state and the other reads disk.

Pass `selectedLinks` from the renderer into `confirmUploadMeeting` and Done becomes
deletable — removing a click **and** the P0 failure mode where skipping Done produces
`alert('Select a Salesforce record first')` while the rail visibly shows the record
attached.

### C2 — Delete "Decide later"
Costs a click, sets a flag nothing reads, and names an "attention queue" that isn't built
(only 1 of 5 queue types has a real data source). It *is* the default state of an unfiled
meeting. Dismissing the surface already means "later", for free.

### C3 — Stop auto-opening the flyout
It covers the summary the user came to read, often before the summary has rendered. The
"Not linked" chip already survived removal of the 45% dim and is sufficient as the nudge.

### C4 — Move search into the rail; delete the flyout
One surface that owns search + attached-records list + escape hatches + commit. Removes
the occlusion, the auto-open interruption, and the covered-button absurdity.

### C5 — Single-select on row click, not checkbox multi-select
Kills two real defects:
- **Search implies consent** — `runSearch` calls `updateLocalSelection()` unconditionally
  when results exist, so *typing* mutates `linked_records`, sets `link_status = 'linked'`,
  hides the chip, and re-renders the rail with the top hit attached.
- **Unchecking doesn't undo** — `updateLocalSelection` guards the rail re-render behind
  `if (selectedLinks.length)` and keeps `'linked'` on the empty branch, so unchecking the
  last box leaves the rail showing a record that is no longer selected.

Replace with: click a row → attach it, close the search, rail updates. Explicit
**"+ Add another record"** for the genuine multi-attach case (Contact + Job Applicant).

## 3. Hard constraint

**Must preserve the Grok #8 security fix.** Nothing may write link state server-side until
an explicit user commit. C5 actually strengthens this (nothing attaches without a click);
C1 must not weaken it (the commit is still the explicit action).

## 4. Already fixed, do not redo

- `link_status` now persists via a dedicated `setMeetingLinkStatus` IPC handler
  (previously `saveMeetingsData` dropped it, making Keep internal / Decide later
  session-local no-ops). Verified across a full app restart.
- False privacy copy ("Private notes never leave this device") corrected — notes DO sync
  to control-plane on every save; `private: true` only keeps them out of Salesforce.

## 5. Open questions for review

1. Does deleting the flyout lose anything the rail can't carry at 320–340px?
2. Is "+ Add another record" discoverable enough for the multi-attach case, or does
   collapsing multi-select regress the Contact+JobApplicant journey?
3. Should "Create a new record from this call…" (currently an honest not-built alert)
   stay in the rail, or be removed until it exists?
4. C1 changes the IPC contract for `confirmUploadMeeting`. What breaks if a stale
   renderer calls it the old way?

---

## GSTACK REVIEW REPORT

**Run:** `/autoplan` 2026-07-30. **Voices:** subagent-only — 2 independent Claude
voices (CEO + Design). Codex stalled past the 10-minute allowance with no verdicts;
tagged `[codex-unavailable]`.

### Consensus

| Change | CEO voice | Design voice | Consensus |
|---|---|---|---|
| C1 delete "Done" | Ship, modified | Ship, modified | **CONFIRMED** (both: needs a persistence fix first) |
| C2 delete "Decide later" | Modify, don't ship alone | Ship, with requirement | **CONFIRMED** (both: must be bundled) |
| C3 stop auto-open | Ship | Ship (restate as a rule) | **CONFIRMED** |
| C4 delete flyout | Modify — sequence after auto-suggest | Ship deletion, modify rail | **DISAGREE** on sequencing |
| C5 single-select | Modify — keep multi-attach | Modify — keep multi-attach | **CONFIRMED — both reject as written** |

### USER CHALLENGE — C5

Both voices independently reject single-select. Their shared reasoning:
- The two defects C5 claims to fix are caused by **auto-selection**
  (`post-call.js:598` pre-checks `results[0]`) and a **missing empty branch**
  (`post-call.js:613` guards the re-render behind `if (selectedLinks.length)`).
  Neither is caused by multi-select. Fixing them needs ~3 lines, not a model change.
- Single-select's failure mode is **silent CRM corruption**: attach Contact, search
  collapses, recruiter believes they're done, the Job Applicant never gets the activity.
- `"+ Add another record"` reproduces `.pc-find-another`'s dashed/`--ink-4`/transparent
  treatment — the weakest button style in the file — on the journey the plan itself
  flags as at risk.
- Multi-attach is the documented domain: `sf-confirm-upload.ts:302-350` writes one
  ContentNote **per target**. Fathom and Gong both write to multiple objects per call.

**Both recommend:** row-click **toggles** attach (killing the 13×13 checkbox inside a
354×46 row that already advertises `cursor:pointer`), nothing pre-selected, search
stays open, no "+ Add another record".

### Critical findings NOT in the plan

1. **F5 — live data-loss, highest value on this screen.** `main.js:1570` short-circuits
   `confirmUploadMeeting` whenever `meeting.sfUpload` exists, returning
   `{success:true, alreadyUploaded:true}`, and `post-call.js:859` renders `Uploaded ✓`.
   Attach Contact → upload → attach Job Applicant → upload writes **nothing** and shows
   a success tick. Under C1 this becomes unrecoverable. The server is already idempotent
   per-target (`sf-confirm-upload.ts:305-311`), so the desktop guard is at the wrong layer.
2. **F1 — "Smart-attach" never attaches.** `interview-resolver.ts:57-79`: the
   `meeting_url` and `calendar_event_id` branches are unimplemented comments ending in
   `return null`, and the desktop only ever sends `meeting_url`
   (`capture-policy-client.js:22-25`). Auto-link returns null for 100% of desktop
   captures. The plan treats this as a fact of the world rather than the bug.
3. **F2 — fixing F1 naively disables recording.** `toResolved` hardcodes
   `botCaptureMode: 'None'` (`interview-resolver.ts:86-96`) → `decideCapture` returns
   `NONE` → `main.js:2111` shows "Recording not started".
4. **`interviewId` is never cleared** (`post-call.js:610-611`) — uncheck everything and
   it survives, so the renderer guard passes while disk is empty.
5. **`#pcRailBody` tab collision** — `renderProvenanceRail` does `body.innerHTML=''` on
   the same element and `setTab` re-renders on every tab switch. Moving search into the
   rail means switching to Notes destroys the query and results.
6. **No-results state does not exist** — the render loop and `updateLocalSelection` are
   both gated on `res.results?.length`, so zero hits leaves an empty container.
7. **`kept_internal` rail is broken today** — `isUnlinked()` returns true for it, so the
   rail renders "Link this call… Open link flyout".
8. **F7 — zero instrumentation.** `telemetry.js` exports `captureEvent`; there are no
   call sites in `post-call.js` or `renderer.js`. The funnel this plan optimizes cannot
   be measured before or after.

### Evidence correction

§1's "80px of main content" is wrong. The unlinked rail is **340px**
(`pc-body-wide-rail`, which is exactly the auto-open condition), so a 380px flyout at
`right:20px` overlaps the main pane by **60px**. Also "100% of the rail" is vertical
overstatement — the flyout is `top:64px` and never covered `.pc-rail-footer`, so the
primary commit button was never occluded. The genuinely covered button is
`renderRail`'s ghost "Open link flyout".

### Recommended order (replaces §2's implied order)

F5 → C3 → (C5-as-modified + defect fixes) → C1 → C2-bundled → C4 last, gated on F1.
