# Implementation Reference — Screen 08 family (Post-call review)

Companion to `docs/PLAN-screen-08-post-call.md` (the review-process document — premises, dual-voice findings, decisions). This file is the build reference: every component/color/button/animation, its connected functionality, and its backend touchpoint, mapped phase by phase. Verified against the live `claude_design` MCP project (`019de4a3-82fc-70a7-a039-c5cdb112e5cf`) — file sizes byte-identical to the local `/Downloads/TI Recall (1)/` mirror for all 9 desktop screens as of 2026-07-24, so this reference is current, not stale.

## 1. Source files (verified against claude_design MCP)

| File | Screen | Size | Purpose |
|---|---|---|---|
| `desktop/post-call.jsx` | 08 — Summary + Smart-attach | 9576b | Linked-case shell, TL;DR + sections, ranked attach rail, confirm-and-upload |
| `desktop/post-call-notes-link.jsx` | 08b + 08c | 12451b | `PostCallNotes` (notes+provenance), `PostCallUnlinked` (general summary + link flyout) |
| `screen-specs/08b-08c-post-call-notes-link.md` | 08b/08c written spec | — | Scenario tables (P1-4, N1-5), C1 addendum (notes-as-pipeline-input) |
| `tokens.css` | brand tokens | — | All colors/radii/shadows referenced below use these CSS vars, confirmed matching `CLAUDE-CODE-HANDOFF.md` §12.1 |

**Not sourced from this export (out of scope, see PLAN §4):** Transcript tab (08a) — no `.jsx`, no spec, tab exists only as a label in `PostTabs`.

## 2. Component index — every element, its color/behavior, its connected functionality

### Shared shell (all 3 states)
| Component | Visual (tokens.css) | Connected functionality | Backend touchpoint |
|---|---|---|---|
| `Captured` chip | `--green`/`--green-bg` | Static, session finalized | `sessions.ts::finalizeSession` result |
| Duration text | `--ink-4`, 12px | `duration_s` from meeting record | desktop-persisted, task #30c pattern |
| `PostTabs` (Summary/Notes/Transcript) | `--paper`/`--paper-2`, active-state shadow | Tab switch, LOCAL state only | none (client-side) — **fix (Phase 2 design review): needs real `button`/ARIA-tab roles + keyboard arrows, ref currently `<span>`** |
| `Re-summarize` button | ghost button, `--ink-3` | Re-runs summary generation with current note state | **NEW** `POST /api/ti/desktop/notes/{id}/generate-summary` (control-plane) — must disable while in-flight (Phase 2 fix) |
| `Discard` button | ghost button (needs destructive restyle — Phase 2 fix) | Deletes capture | **undefined scope today** — needs explicit definition of what "discard" deletes across local/server/SF (CEO review finding, Codex #24) |
| Confirm-and-upload button | `--ink` bg, `--paper` text | Writes link(s) + summary to SF | **NEW** SF write path (Phase 4) — needs idempotency key (Eng review finding #11) |

### 08 — Summary tab, linked case
| Component | Visual | Connected functionality | Backend touchpoint |
|---|---|---|---|
| Avatar + title + duration/speakers/words | `--ink`, display font 22px | Static session metadata | `sessions.ts` session doc |
| TL;DR card | gradient `--paper-2`→`--paper`, `--accent` sparkle icon | **General/recruiter-aware summary text** | **NEW** general-summary prompt (Phase 1), `extraction-worker` |
| Section cards (Skills/Comp/Motivation/Flags) | tint bg per tone (`--amber-bg`, `--green-bg`, `--accent-3`) | Interview-signal extraction output | existing `extractInterviewSignal` (unchanged, only fires when Interview-linked) |
| Smart-attach rail header | uppercase 11px `--ink-5` | Static label | none |
| Candidate cards | `--paper` w/ `--accent` border if primary, "Best match" pill | Ranked SF record suggestions | **NEW** Smart-attach ranking service (Phase 2) — SOSL across 5 object types, **must use `sf-session-cache.ts`'s `getSfUserSession`/`soqlQueryAsUser`, NOT a shared credential** (Eng review finding #7) |
| Confidence % | mono font, `--ink-4` | Ranking score | **relabel as "estimated match" per Design review — raw % overstates precision (Codex design finding #19)** |
| "Also attach" checkbox | native checkbox, `--accent` tint | Multi-attach selection | **default-uncheck below 80% confidence — currently `defaultChecked` on a 62% match in the reference (Claude design finding #4, real defect)** |
| "Find another record…" | dashed border, `--ink-5` | Opens manual search | shares the flyout's search endpoint (08c) |

### 08b — Notes tab
| Component | Visual | Connected functionality | Backend touchpoint |
|---|---|---|---|
| Notes editor | `--hand` font (Caveat), editable | Per-note text, editable post-call | **NEW** notes finalize payload `{text, transcriptOffset, private}` (Phase 0) |
| Timestamp chip | `--accent`, mono 10px | "Jump to transcript moment" | **dead affordance until 08a ships — must be disabled, not silently non-functional (Claude design finding #8)** |
| PRIVATE badge | lock icon, `--ink-4` | Marks note excluded from LLM + SF payload | **needs an actual toggle control — reference only shows the rendered end-state, no way to create it (Claude design finding #7)** |
| IN SUMMARY badge | sparkle icon, `--accent` | Note fed the summary | Provenance map from general-summary prompt response |
| Provenance rail cards | `--paper` bordered | note→summary-line mapping | **framed as "likely informed this line," not causal fact — LLM can't prove causality (Codex design finding #20)** |

### 08c — Unlinked + link flyout
| Component | Visual | Connected functionality | Backend touchpoint |
|---|---|---|---|
| `Not linked` chip | `--amber`/`--amber-bg` | Session has `link_status: unlinked` | Phase 0 schema |
| General summary (dimmed 45%) | gradient card | Non-recruiting-template summary | Same general-summary prompt (Phase 1), always fires |
| Link flyout search | **currently a decorative span — needs a real `<input>` (Codex design finding #13)** | Live search-as-you-type | **NEW** Smart-attach search endpoint, reused from 08's rail |
| Ranked result rows | `--accent-3` bg for top pick | SOSL/SOQL candidates w/ match reason | Same Smart-attach service |
| "Create a new record…" | plus icon | Type-picker + prefilled-name form | **zero visual/engineering design exists — needs its own slice (CEO + Design review, both flag this)** |
| "Keep internal" | lock icon | `link_status: kept_internal`, permanent | Phase 0 schema — **needs a reverse transition (Eng review finding #9: scalar link_status can't model this cleanly, see §4 below)** |
| "Decide later" | clock icon | `link_status: decide_later`, 7-day reminder | Phase 0 persists status; **queue/reminder infra doesn't exist (TODOS.md #22)** |

## 3. Backend architecture map (current state → this plan's target state)

```
TODAY:                                          TARGET (this plan):
finalizeSession()                               finalizeSession()
  if interview_id: start Temporal                  ALWAYS: client.start() a new Temporal
    process_interview_capture workflow                 general-summary workflow (NOT an
  else: log + no-op                                     un-awaited in-process promise —
                                                         Cloud Run cpu_idle would freeze it,
                                                         confirmed via Google's own docs)
                                                    if interview_id/linked_records has an
                                                       Interview: ALSO start the existing
                                                       process_interview_capture workflow

interview_id: string | null                     linked_records: [{type, id, linkedAt}]
                                                 link_status: linked|unlinked|kept_internal|decide_later
                                                 interview_id: KEPT as read-compat field (additive
                                                   migration) — dual-write semantics + precedence
                                                   rule still need explicit definition (Eng review
                                                   finding #8, not yet resolved)

No durable transcript store                     Durable store, NOT an unbounded array on the
                                                 Firestore session doc (1 MiB limit) — needs
                                                 chunking/object storage (Eng review finding #7,
                                                 not yet resolved — open item for Phase 0 redesign)

No Smart-attach service                         NEW service: SOSL across Job/Job Applicant/
                                                 Contact/Account/Opportunity, using
                                                 sf-session-cache.ts's per-user session
                                                 (getSfUserSession/soqlQueryAsUser) — NEVER
                                                 the shared-credential soqlQuery/license.ts
                                                 fallback path
                                                 Escaping: NEW escapeSoslString() — Salesforce's
                                                 SOSL FIND{} reserved set is
                                                 ? & | ! { } [ ] ( ) ^ ~ * : \ " ' + -
                                                 (confirmed via Salesforce dev docs) — this is
                                                 NOT the same as the existing escapeSoqlString()
```

## 4. Open engineering items this reference does NOT resolve (tracked, not silently dropped)

These surfaced during the Eng review (see `PLAN-screen-08-post-call.md`'s Phase 3 dual-voice findings) and need resolution before Phase 0/1/2 implementation starts, not just before ship:

1. **Transcript storage shape** — chunked/object storage design, not an unbounded Firestore array.
2. **`link_status` as scalar vs. derived-from-records** — a scalar can't cleanly model "remove one of several links" or "partial filing." Needs to be either derived from `linked_records[]`'s contents or modeled per-link.
3. **`interview_id` dual-write precedence** during the additive-migration window.
4. **Async delivery protocol for summary generation** — queued/running/succeeded/failed states, and how the desktop discovers completion (poll `GET .../summary`, per the pre-existing `PLAN-rich-notes.md` §5.1 spec, vs. a push mechanism).
5. **`sessionId` persistence** — today only in `global.activeMeetingIds` (in-memory); a crash/restart loses the ability to finalize. Needs a durable local record.
6. **Notes vs. AI-summary field collision** — today both occupy `meeting.content` locally; these need independent storage before "notes stay editable, summary is separate" is structurally true.
7. **Local `meetings.json` not scoped per signed-in user/org** — real cross-account data-mixing risk once server-side summaries/links exist and a user signs out/in as someone else on the same machine.

## 5. Phase order (unchanged from PLAN-screen-08-post-call.md §3, cross-referenced here for the build sequence)

Phase 0 (data model, resolve items #1-#3, #5-#7 above first) → Phase 1 (always-on summary via Temporal, resolve item #4) → Phase 2 (Smart-attach service, per-user SF session + new SOSL escaping) → Phase 3 (desktop UI, per the component index in §2, including all Design-review fixes) → Phase 4 (SF write path, idempotent per-target).

## 6. Electron/security checklist (per electron-development skill, run against any new window/IPC surface this introduces)

The post-call screens are expected to render inside the existing main window (no new `BrowserWindow`, unlike the meeting-notification panel in task #37). If that changes during implementation, re-run the same checklist task #93 used: `sandbox`/`contextIsolation` on, no `nodeIntegration`, no local TCP port, `webSecurity` explicit. If it stays in the existing window, the relevant checklist items are: no new IPC channels without input validation on the main-process side, and the notes-sync/summary-fetch client code follows the existing `control-plane-client.js` pattern (bearer token from `authStore`, no secrets in renderer-accessible storage).
