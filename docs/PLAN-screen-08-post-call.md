# PLAN — Screen 08 family: Post-call review (Summary / Notes / Transcript, Smart-attach, unlinked flyout)

**Status:** draft, pre-review (entering `/autoplan`)
**Repos touched:** `asymbl-ti-desktop` (primary — UI, renderer, main process), `Recall` backend (`gcp/control-plane`, `gcp/extraction-worker` — new endpoints/prompt)
**Design source:** Claude Design project `019de4a3-82fc-70a7-a039-c5cdb112e5cf` ("Recall by Asymbl"), reference export at `/Users/sdevinarayanan/Downloads/TI Recall (1)/` (verified current — see §1)
**Supersedes:** task #26 ("Post-call review screen (screen 07)") — same screen, this export's own spec numbers it 08; folding #26 into this plan, not tracking separately.

---

## 0. Goal

Ship the Post-call review screen family — the moment right after a capture ends, where the recruiter sees the AI summary, can review/edit their own notes, and files (or deliberately doesn't file) the conversation to Salesforce. Three concrete UI states, one shell:

- **08 — Summary tab, linked case (Smart-attach):** AI summary + confidence-ranked SF record suggestions + multi-attach + explicit confirm-and-upload gate.
- **08b — Notes tab:** the user's own notes, editable post-call, with per-note provenance showing exactly which note fed which summary line; PRIVATE notes excluded from everything downstream.
- **08c — Unlinked capture + link flyout:** general summary still generates with zero SF linkage; a flyout offers search-to-link across multiple SF object types, or three explicit escape hatches (create / keep internal / decide later).

**Definition of done:** all three states pixel-match the reference `.jsx`/`tokens.css` (color, spacing, radius, typography, motion), wired to real backend data (no mock arrays), the backend changes that make "summary always generates" and "link to more than just Interview" true are built and tested, and the electron-development skill's security checklist has been run against any new window/IPC surface this introduces.

## 1. Source-of-truth reconciliation (read before building)

- **Brand tokens: LOW risk.** `CLAUDE-CODE-HANDOFF.md` §12 warns the design canvas mockups use "an older warm/cream palette — follow layout, not colors." Checked: `tokens.css` in this export already matches the corrected 2026 brand tokens in that same doc's §12.1 byte-for-byte (`--paper #fff` / `--asy-white #FFFFFF`, `--ink #191d47` / `--asy-ink #191D47`, `--accent #038ff8` / `--asy-blue #038FF8`, etc.) and `post-call.jsx` / `post-call-notes-link.jsx` reference these CSS vars directly. This export is current, not the stale bundle.
- **Screen numbering:** this export's own `screen-specs/08b-08c-post-call-notes-link.md` labels the Summary+Smart-attach screen "08" (`desktop/post-call.jsx`). The project task list has it as "#26, screen 07." Same screen. Renumbering here, not building twice.
- **"08a" is undefined.** The tab bar in `post-call-notes-link.jsx` lists `['Summary', 'Notes', 'Transcript']` — Transcript is presumably 08a, but there is no `.jsx` source and no written spec for it anywhere in this export. Treating it as its own explicitly-scoped-out item below, not inventing a design for it.
- **Backend architecture claims in `CLAUDE-CODE-HANDOFF.md` §5/C1 are partially stale.** That doc describes tenant Supabase writes, Langfuse tracing, and per-tenant-tier model routing (claude-haiku-4.5 / claude-sonnet-4.5 / gemini-2.5-flash-lite). Verified against the actual deployed code: `gcp/extraction-worker/src/extract.ts` hardcodes `claude-sonnet-4-5-20250929` only; there is no tenant Supabase — sessions live in Firestore-backed structures in `gcp/control-plane`. The doc's own source-of-truth order puts `docs/DECISIONS.md` above itself for exactly this reason. §5/6 backend mapping below reflects the **real, current architecture**, not the handoff doc's.

## 2. Current backend architecture vs. what this screen family requires

**What exists today** (`gcp/control-plane/src/sessions.ts`):
- `finalizeSession` starts Temporal signal extraction **only if** `record.interview_id` is set; otherwise logs `finalize_orphan_session` and does nothing.
- No durable server-side transcript store — transcript/notes only live in the desktop's local `meetings.json`.
- `extraction-worker`'s prompt (`prompts.ts`) is interview/recruiting-shaped (skills, comp, motivation, flags) — not a general-purpose summarizer.
- Session linkage today is a single `interview_id` field, not a list, and not typed to other SF objects (Job/Contact/Account/Opportunity).

**What 08/08b/08c require that doesn't exist yet:**
1. Summary must generate **unconditionally on finalize**, regardless of SF linkage (08c: "the summary still generates — but with the general template").
2. Notes must be an **input to summarization**, not just captured alongside — non-private notes get merged into the extraction prompt with timestamp/offset, private notes never leave the device even as extraction input (08b, C1 addendum in the spec doc).
3. Provenance: the summary generation call must return which note fed which output line, for the 08b right rail.
4. Session linkage must generalize to **multiple SF object types with multiple simultaneous links** (Job / Job Applicant / Contact / Account / Opportunity), not a single `interview_id`.
5. A ranked-candidate search service (Smart-attach) that scores SF records by calendar-invite linkage, transcript name mentions, participant email domain, and skills overlap.
6. Three explicit non-link outcomes that need to persist as real states: `kept_internal` (permanent, never re-prompt), `decide_later` (attention-queue, 7-day reminder), vs. today's implicit "nothing happens."
7. `Re-summarize` — an on-demand re-run using current note state, and an automatic re-run when a link is added post-hoc (08c: "once linked, Re-summarize re-runs with the record's kind template").

## 3. Phased implementation order

**Phase 0 — data model (`gcp/control-plane`)**
- Persist transcript + notes server-side keyed by `notesSessionId` (blocks everything else — no durable store today).
- Session schema: `linked_records: [{type, id, linkedAt}]` + `link_status: linked | unlinked | kept_internal | decide_later`, replacing the singular `interview_id` gate.
- Finalize payload: notes array `{text, transcriptOffset, private: bool}`.

**Phase 1 — always-on summary (`control-plane` + `extraction-worker`)**
- New general-purpose prompt (transcript + non-private notes, timestamped), distinct from the interview-signal prompt — reuses the existing `claude-sonnet-4-5-20250929` client, no new AI vendor.
- `generate-summary` / `summary` endpoints (per the pre-existing, never-built `docs/PLAN-rich-notes.md` §5.1 spec in the backend repo), fired unconditionally on finalize, plus on-demand for `Re-summarize`.
- Output includes the note→summary-line provenance map for 08b.

**Phase 2 — Smart-attach matching (`control-plane`, new)**
- SOSL/SOQL ranking service across Job Applicant / Job / Contact / Account / Opportunity, scored on calendar linkage, transcript mentions, participant domain, skills overlap.
- Ownership/sharing check on every candidate before it's surfaced or attachable.
- Multi-attach support (`Also attach` checkboxes in 08; the ranked flyout list in 08c).

**Phase 3 — desktop UI (`asymbl-ti-desktop`, primary pixel-match work)**
- Summary/Notes/Transcript tab shell + top bar (state chip, duration, Re-summarize/Discard) shared across all three states.
- 08: summary body + Smart-attach right rail, confirm-and-upload gate, "stays local until you confirm."
- 08b: notes editor (hand font, timestamp chips, PRIVATE/IN SUMMARY badges) + provenance right rail.
- 08c: dimmed general-summary state, amber "Not linked" chip, link flyout (search + ranked results + three escape hatches).
- Transcript tab (08a) — explicitly OUT OF SCOPE for this plan; no spec exists yet. Flagging as a follow-up item, not building blind.

**Phase 4 — SF write path**
- On confirm: Interview link → full signal extraction; any other object type → summary attached as a Note/ContentNote (no skills-schema extraction on non-interview objects).
- "Create record from call" — net-new, no existing spec; scope as a minimal type-picker + name-prefill form per the 08c spec doc's description.

## 4. Explicitly out of scope for this plan

- The Transcript tab (08a) — no spec exists; separate follow-up.
- The rest of `CLAUDE-CODE-HANDOFF.md`'s system (bot dispatch spine, SF LWC bundle C2, public consent surfaces C3, admin console C4, retention/DSR C6, provider abstraction C7) — that document describes the entire product, not this screen family. Out of blast radius.
- Re-litigating the MuleSoft/asymbl.app domain work or the Gemini-vs-Claude vendor question from earlier this session — unrelated threads.

## Phase 1 — CEO Review (mode: SELECTIVE EXPANSION, via /autoplan)

### Step 0 — Nuclear Scope Challenge

**0A. Premise Challenge (Gate — user-confirmed, not auto-decided).** Asked whether bundling the UI reskin with the backend generalization (linked_records[], always-on summary, Smart-attach) into one plan is right, vs. splitting UI-now/backend-later. **User confirmed: one bundled plan** — the UI has no correct meaning against the old single-`interview_id` shape (08c's multi-link/escape-hatch UI doesn't exist in that model), so splitting would mean building the UI twice.

**0B. Existing Code Leverage.** Already covered in §2 above (current backend architecture vs. what's required) — no duplication, this section maps 1:1 to real code already read (`sessions.ts`, `extract.ts`, `prompts.ts`, `PLAN-rich-notes.md`).

**0C. Dream State Mapping.**
```
CURRENT STATE                          THIS PLAN                              12-MONTH IDEAL
Single interview_id gate.    --->      linked_records[] + link_status;  --->   Every capture auto-classified,
No summary unless linked.              always-on general summary;             correctly filed, or explicitly
No durable transcript store.           durable transcript store;               triaged with zero manual search;
Smart-attach doesn't exist.            Smart-attach ranking service            summary quality tracked against
                                        (Job/Contact/Account/Opp).             an eval set, cost-tiered by
                                                                                capture type.
```
This plan moves toward the ideal on linkage generality and summary availability, but (per dual-voice findings below) moves *away* from it on privacy/consent posture and cost control unless those gaps are closed first.

**0C-bis. Implementation Alternatives.**
```
APPROACH A: As planned (all 5 phases, one plan)
  Effort: XL   Risk: High
  Pros: UI and backend generalize together, no throwaway work
  Cons: Largest blast radius; per Codex finding #28/#30, no learning checkpoint until everything ships

APPROACH B: Thin validation slice first (Codex finding #28)
  Effort: M    Risk: Low
  Summary: Ship deterministic pre-linking (calendar/attendee match only, no ranking service) + on-demand
  summary generation (button-triggered, not automatic) + single confirmed SF write path. Measure real
  usage before building durable storage, ranking, provenance, and reminders.
  Pros: Validates the workflow before committing to the full architecture; much smaller privacy surface
  (no unconditional server-side summarization) and cost surface (on-demand, not every capture)
  Cons: Slower to the full pixel-perfect vision; the polished 08c flyout doesn't exist yet

RECOMMENDATION: Approach A, with Approach B's core insight folded in as a hard requirement, not a
separate approach — gate automatic summarization behind a lightweight opt-in/consent check (existing
capture-policy/consent infrastructure, not new build) rather than removing the gate entirely. This
keeps the single bundled plan the user already confirmed at the Premise Gate, while closing the
privacy hole both review voices flagged as the most serious issue. Completeness: A=6/10 (as originally
scoped, missing consent), A-with-consent-gate=9/10, B=7/10 (safer but reopens the just-decided premise).
```

### Step 0.5 — Dual Voices

**CLAUDE SUBAGENT (CEO — strategic independence), 8 findings** (full independent read of the plan + referenced source, no prior-review context):
1. **CRITICAL** — Plan's Definition of Done requires "pixel-perfect, not a reinterpretation" against `post-call.jsx`, which renders Smart-attach as a 320px side rail — the exact layout backlog task **T9** ("Make Smart-attach primary decision surface on Post-call, not a side rail") exists to overturn. Task #26 (this same screen) already carries T9 as a required fix; this plan never mentions it. As written, the plan will ship the known-wrong layout, then need a second pass.
2. **CRITICAL** — Unconditional summarization removes the only existing privacy gate (`sessions.ts`'s `interview_id` check) with no consent discussion, despite §5 claiming security is in scope for every phase. Every accidental/private capture — the exact case 08c's "Keep internal" hatch exists for — gets its transcript sent to Anthropic before the user can say "this was private."
3. **HIGH** — `decide_later`'s "7-day gentle reminder" attention queue is documented elsewhere in this repo as **not existing** (`docs/screen-specs/02-home-today.md`, `notes-sync.js`) — only one queue type has a real data source today. Phase 0 persists the status; no phase builds the queue/reminder.
4. **HIGH** — No cost/model-tiering control on unconditional LLM calls — every capture (not just linked ones) now becomes a full Sonnet-tier call, with no cheaper-model path or minimum-duration gate, despite the architecture doc's own tenant-tier routing intent.
5. **MEDIUM** — 08's ranked rail and 08c's flyout solve the same problem (which SF record(s) this belongs to) via two different code paths; given T9, the higher-leverage move is one always-prominent attach surface, not two.
6. **MEDIUM** — "Create record from call" is under-scoped as "a minimal form" — 5 object types each have different required fields/validation/permission rules; this is its own slice.
7. **MEDIUM** — No effort sizing anywhere; Phase 2 (Smart-attach) was previously tracked as its own multi-week backend project (task #7/#25, blocking #26) and is being silently folded in.
8. **LOW** — Prior Smart-attach threshold decision (T16, completed) is never cited or incorporated into Phase 2's ranking design.

**CODEX (CEO — strategy challenge), 30 findings** (full list preserved verbatim in review artifacts; key ones not already covered by the Claude subagent):
- #1, #26, #28: the post-call review-workflow premise itself may be wrong — the higher-value product is zero-touch filing with an exception queue, and there's no thin validation slice before committing to the full 5-phase architecture.
- #2, #27: Smart-attach resolves linkage too late (should start pre-call from calendar/attendee context) and implicitly broadens the product from recruiting into general sales meeting intelligence (Account/Opportunity) without acknowledging that pivot.
- #3, #4, #17, #29: reinforces the Claude subagent's privacy finding independently — "stays local until you confirm" is contradicted by Phase 0/1's architecture; consent/retention/DSR are treated as "out of blast radius" while the plan directly expands that blast radius.
- #6: no success metric anywhere (attachment accuracy, summary acceptance rate, correction rate).
- #9, #10, #11: multi-attach risks CRM pollution across 5 object types with no canonical-record concept; the object taxonomy is hardcoded against a schema that will vary per customer; matching signals (name mentions, domain, skills overlap) are weak evidence that can confidently attach the wrong record.
- #13, #14: provenance is framed with unjustified precision (an LLM can't *prove* a note fed a summary line without constrained generation) and has no versioning story once notes/transcripts are edited post-hoc.
- #15, #16: the private-note premise conflicts with the actual editor (single markdown blob today, not block-structured) — needs an editor/sync migration, not just a new finalize field; "never leaves the device" isn't structurally enforced against logs/telemetry/backups.
- #20: excluding the Transcript tab (08a) removes the one surface that lets users verify/correct a wrong summary or provenance claim.
- #22, #23, #24: `decide_later`, `kept_internal`, and `Discard` are all under-specified as durable states — no reversibility, audit history, or precise definition of what "discard" actually deletes across 3+ systems.

**CEO DUAL VOICES — CONSENSUS TABLE:**
```
═══════════════════════════════════════════════════════════════════
  Dimension                            Claude   Codex   Consensus
  ──────────────────────────────────── ─────── ─────── ───────────
  1. Premises valid?                    NO       NO      CONFIRMED (both: unconditional-summary
                                                          premise removes privacy gate w/o consent)
  2. Right problem to solve?             —      NO       DISAGREE (Codex challenges the whole
                                                          review-workflow framing; Claude accepts
                                                          the problem, contests the execution)
  3. Scope calibration correct?         NO       NO       CONFIRMED (both: too much bundled with
                                                          no independent landing points)
  4. Alternatives sufficiently explored? NO      NO       CONFIRMED (neither found a considered
                                                          alternative to full-scope-at-once)
  5. Competitive/market risks covered?    —      NO       DISAGREE (Codex: generic summaries are
                                                          commoditized, no differentiation named;
                                                          Claude did not evaluate this dimension)
  6. 6-month trajectory sound?          NO       NO       CONFIRMED (both: provenance/consent/cost
                                                          debt will surface within 6 months)
═══════════════════════════════════════════════════════════════════
CONFIRMED = both agree. DISAGREE = models differ in emphasis (both still net-negative on the
dimension, but Codex goes further on 2 and 5) → treated as USER CHALLENGE material, not taste.
```

### USER CHALLENGES (deferred to the Phase 4 gate, not auto-decided)

**Challenge 1 — Unconditional summarization removes the existing privacy/consent gate.**
You said (this session, earlier): summaries should generate regardless of Salesforce linkage — "I still want the summary." Both models independently agree this is right in *intent* but wrong as currently specified: today `sessions.ts` never sends a transcript to an LLM unless `interview_id` is set; this plan deletes that gate with no replacement, meaning every accidental/private capture gets auto-summarized by Anthropic before the user can flag it as private. What we might be missing: whether a lightweight "is this OK to summarize" gate (reusing existing consent/capture-policy infrastructure) fully satisfies "I still want the summary" without reopening the linkage requirement. If we ship as specified, the cost of being wrong is: real transcript data leaves the device for conversations the user never intended to process, before any UI decision point exists.

**Challenge 2 — No thin validation slice; full 5-phase scope ships before any usage signal.**
Codex's strongest challenge: build deterministic pre-linking + on-demand (not automatic) summary + one confirmed write path first, and measure real usage before committing to durable storage, ranking, provenance, and reminders. This is in tension with the Premise Gate answer you already gave this session (one bundled plan) — that answer resolved *whether UI and backend ship together*, not *whether the full backend scope (multi-object ranking, provenance, decide_later queue) should all land in v1 vs. a smaller v1 slice*. If we're wrong to ship full scope at once, the cost is: providing large amounts of exact but unvalidated infrastructure (Smart-attach ranking, provenance UI, reminder queue) before knowing if recruiters actually want the review workflow at all.

### 0D — Mode-Specific Analysis (SELECTIVE EXPANSION)
Scope held at the bundled plan the user confirmed. Expansion opportunities surfaced by the dual voices (pre-call linkage via calendar context, success metrics, admin-configurable object taxonomy) are cherry-pick candidates — deferred to TODOS.md individually below, not silently added.

### 0E — Temporal Interrogation
**Hour 1:** Phase 0 data model change (linked_records[], notes-with-privacy-flag) ships; nothing user-visible yet — existing single-interview_id flows must not regress.
**Hour 6+:** Phase 1 (always-on summary) is live — this is the hour the consent-gate decision (Challenge 1) actually matters in production; shipping without resolving it means real data exposure starts here, not at full Phase 4 completion.

### 0F — Mode Confirmation
SELECTIVE EXPANSION confirmed (per autoplan Phase 1 override). Proceeding to Sections 1-11.

---

### Section 1 — Architecture Review

```
DEPENDENCY GRAPH (new components, relation to existing):

  desktop UI (post-call.jsx port)
     │  reads: session summary, notes, transcript, link candidates
     ▼
  control-plane: sessions.ts (extended)          extraction-worker (extended)
     │  finalizeSession() ─────────────────────▶  new general-summary prompt
     │  linked_records[]/link_status (NEW field)  (reuses claude-sonnet-4-5 client)
     │  notes[] w/ private flag (NEW)                    │
     ▼                                                    ▼
  Firestore session doc (extended schema)         tenant transcript store (NEW —
     │                                             blocked on Phase 0 durability work)
     ▼
  NEW: Smart-attach ranking service (SOSL/SOQL across
  Job Applicant/Job/Contact/Account/Opportunity, ownership-checked)
     │
     ▼
  Salesforce (existing OAuth session cache, unchanged)
```

**Data flow — 4 paths, for the new "generate summary on finalize" flow:**
```
  HAPPY:  finalize → notes+transcript persisted → summary prompt → summary+provenance stored → UI shows it
  NIL:    finalize with zero notes → summary prompt runs on transcript alone → UI shows "built from
          transcript alone" (08b spec's N1 scenario — already specified, good)
  EMPTY:  finalize with empty transcript (capture failed) → summary prompt must short-circuit, not send an
          empty string to the LLM — **GAP, not in plan today**
  ERROR:  Anthropic API unavailable/rate-limited → today's extraction-worker has no analogous fallback
          documented for the general-summary path — **GAP** (see Section 2)
```

**State machine — `link_status`:**
```
        ┌─────────┐  link chosen   ┌────────┐
        │unlinked │───────────────▶│ linked │
        └────┬────┘                └────────┘
             │ keep internal                 ▲
             ▼                                │ link added later
        ┌──────────────┐   decide later  ┌────┴────────┐
        │ kept_internal │◀───────────────│decide_later │
        └──────────────┘   (Codex #23:   └─────────────┘
         no reversal path   no reversal/reassignment path defined either — GAP)
```
Both terminal-looking states (`kept_internal`, `decide_later`) lack a documented transition back to `linked` — Codex findings #22/#23 confirmed. **Auto-decided (P5, explicit>clever):** add explicit transitions `kept_internal → linked` (admin/user override) and `decide_later → linked | kept_internal` (resolution) to the schema now, before Phase 0 ships, rather than discovering the need for a migration later.

**Coupling:** `sessions.ts` gains a hard dependency on the new Smart-attach ranking service and the new general-summary prompt — both single points of failure for `finalizeSession`, which today has none. **Auto-decided (P1, completeness):** both calls must be non-blocking / best-effort with respect to `finalizeSession`'s own success — a ranking-service outage must not fail session finalization.

**Scaling:** Every finalize now triggers 1 LLM call (up from only interview-linked ones) + 1 SOSL/SOQL fan-out across 5 object types. At 10x capture volume, this is 10x LLM spend and 10x SF API call volume — SF API limits are per-org and finite. **Flagged as User Challenge material already covered above (Challenge 1); the SF API rate-limit angle is new — added to Section 7 (Performance).**

**Security architecture / who can call what:** covered fully in Section 3.

**Production failure scenario:** Smart-attach ranking service times out mid-search in the 08c flyout. **Auto-decided (P1):** per the spec's own N1 scenario, this is already handled ("local suggestions only + 'Salesforce search unavailable — link later'") — confirmed present in the design spec, no gap.

**Rollback posture:** the `linked_records[]` schema migration replacing `interview_id` needs a rollback path if Phase 0 ships broken. **Auto-decided (P3, pragmatic):** additive migration — keep `interview_id` as a read-compat field during the transition rather than a destructive rename, so rollback is a deploy revert, not a data migration reversal.

### Section 2 — Error & Rescue Map

```
METHOD/CODEPATH                          | WHAT CAN GO WRONG              | EXCEPTION CLASS
------------------------------------------|--------------------------------|-------------------
general-summary prompt call (new)         | Anthropic API timeout          | TimeoutError
                                           | Anthropic API rate-limited     | RateLimitError
                                           | Empty/malformed transcript     | InvalidInputError (GAP)
                                           | Model returns malformed JSON   | JSONParseError (GAP)
Smart-attach SOSL/SOQL ranking (new)       | SF API timeout                 | TimeoutError
                                           | SF API rate limit              | RateLimitError
                                           | Ownership check throws         | AuthorizationError (GAP)
notes finalize payload (extended)         | Note missing timestamp/offset  | InvalidInputError (GAP)
SF write path (create/link/attach)        | Duplicate rule blocks write    | ValidationError (GAP)
                                           | No create permission           | PermissionError — spec's own
                                           |                                 N5 already handles this (hide,
                                           |                                 don't error) — OK

EXCEPTION CLASS       | RESCUED? | RESCUE ACTION                          | USER SEES
-----------------------|----------|------------------------------------------|------------------
TimeoutError (LLM)     | N — GAP  | none specified                          | undefined today
RateLimitError (LLM)   | N — GAP  | none specified                          | undefined today
InvalidInputError      | N — GAP  | none specified (empty transcript case)  | undefined today
JSONParseError         | N — GAP  | none specified                          | undefined today
AuthorizationError     | N — GAP  | none specified                          | undefined today
ValidationError (SF)   | Partial  | spec's N5 covers permission; duplicate  | undefined for
                        |          | rule / validation rule failure not     | duplicate/validation
                        |          | covered                                 | case
```
**Auto-decided (P1, completeness — this is exactly the "boil the ocean" case, cheap with CC):** every GAP row above gets a rescue action added to Phase 1/2/4 scope: LLM timeout/rate-limit → retry-with-backoff then degrade to "summary pending, retry later" state (mirrors the Mule proxy's own timeout pattern from earlier this session); empty transcript → short-circuit before the LLM call with a "nothing to summarize" state; SF write validation/duplicate failures → surface the SF error message verbatim in the confirm-and-upload flow rather than a generic failure.

### Section 3 — Security & Threat Model

This section is where **User Challenge 1** (unconditional summarization removing the consent gate) formally lives as a threat, plus additional items both dual voices raised:

- **Attack surface expansion:** new Smart-attach search endpoint (user-controlled query string into SOSL) — **auto-decided (P1):** must use the same parameterized-query discipline already fixed in this codebase for SOQL injection (task #29/Security F1, this session's memory) — the fix pattern already exists, apply it here from day one, don't reintroduce the bug class.
- **Authorization:** Codex #12 — search results, summaries, and linked records can each have different visibility. **Auto-decided (P1):** every Smart-attach candidate must pass the same per-record ownership/sharing check the plan already specifies (§3 Phase 2) — the gap Codex flagged is that this was stated as one generic check; making it explicit per-object-type (Job Applicant sharing rules differ from Opportunity sharing rules) is a real requirement, added to Phase 2 scope.
- **Data classification / consent:** the core of User Challenge 1 — deferred to the gate, not auto-decided here.
- **PII in logs:** new logging added per Section 8 must not log transcript/note content — only IDs and counts, matching this repo's existing PII log-scrub convention (`CLAUDE-CODE-HANDOFF.md` §11: "PII log-scrub verified (zero meeting URLs/emails in prod logs)").

### Section 4 — Data Flow & Interaction Edge Cases

```
INTERACTION              | EDGE CASE                          | HANDLED?  | HOW
--------------------------|-------------------------------------|-----------|----------------------------
Confirm & upload          | Double-click submit                 | ?         | GAP — no idempotency key on
                          |                                      |           the SF write mentioned
Confirm & upload          | Navigate away mid-upload             | ?         | GAP — no resume/retry state
Re-summarize              | Clicked while a summary is in-flight | ?         | GAP — no in-flight guard
Smart-attach search       | Zero results                        | Y         | spec's N2 already covers
Smart-attach search       | SF search offline/timeout            | Y         | spec's N1 already covers
Notes editor              | Note marked private after summary    | ?         | GAP — does re-summarize
                          | already ran                          |           purge it from a stale
                          |                                      |           provenance card? Not
                          |                                      |           specified (ties to
                          |                                      |           Codex #14, provenance
                          |                                      |           staleness)
```
**Auto-decided (P1):** the 4 GAP rows get explicit handling added to Phase 3/1 scope — idempotency key on confirm-and-upload (prevents double-submit duplicate SF writes), disable Re-summarize button while a generation is in-flight, and re-summarize must invalidate/regenerate the provenance rail (not just the summary text) so a newly-privatized note can't linger in a stale "IN SUMMARY" badge.

### Section 5 — Code Quality Review

No code exists yet (plan stage). Applying the review to the *plan's described patterns*: the plan correctly reuses the existing Anthropic client (DRY — no new SDK), the existing SF session-cache/OAuth pattern (DRY), and the existing consent/capture-policy infrastructure is available for reuse (per User Challenge 1's resolution direction) rather than inventing a new gate. No over-engineering detected — the multi-object Smart-attach service is justified by the actual product requirement (08c explicitly needs it), not speculative. **No issues, moving on** (real code-quality review recurs at implementation-review time via `/review`).

### Section 6 — Test Review

```
NEW UX FLOWS: confirm-and-upload (multi-attach), notes editing post-call, re-summarize,
  link flyout (search/create/keep-internal/decide-later), attention-queue surfacing (deferred, see below)

NEW DATA FLOWS: finalize→summary generation, notes→provenance mapping, SF search→ranked candidates,
  SF write (link/attach/create)

NEW CODEPATHS: link_status state transitions, private-note filtering before LLM call, multi-object
  ownership checks, idempotent confirm-and-upload

NEW BACKGROUND JOBS: none yet scoped for decide_later's 7-day reminder (Codex #22 — this is real,
  unscoped work, not a test gap; see TODOS below)

NEW INTEGRATIONS: Smart-attach SOSL/SOQL service, general-summary Anthropic call

NEW ERROR/RESCUE PATHS: all 5 GAP rows from Section 2
```
Test ambition check: the 2am-Friday test is "does a private note ever appear in an uploaded SF summary" — this needs an explicit regression test, not just a manual QA pass, given Codex #16's structural-enforcement concern. **Auto-decided (P1):** add a test asserting private-flagged notes are excluded from (a) the LLM prompt payload and (b) the SF write payload, at the unit level, not just UI-level hiding.

**Test plan artifact** written to `~/.gstack/projects/asymbl-ti-desktop/{user}-{branch}-eng-review-test-plan-{datetime}.md` during the Eng Review phase (per that skill's own instructions) — not duplicated here.

### Section 7 — Performance Review

- **LLM call volume:** covered under User Challenge 1/Claude finding #4 — cost scales with total captures, not just linked ones.
- **SF API rate limits (new, from Section 1's scaling note):** Smart-attach's SOSL/SOQL fan-out across 5 object types runs on every unlinked finalize. **Auto-decided (P1):** cache/dedupe candidate searches per session (don't re-run the full 5-object search on every UI re-render of the flyout), and respect SF's per-org API call limits — add this as an explicit Phase 2 requirement, not an afterthought.
- **Caching:** ranked candidates should be cached for the session's lifetime once computed, invalidated only by explicit "Find another record" re-search.

### Section 8 — Observability & Debuggability Review

Currently **zero** observability is specified anywhere in the plan for the new summary-generation or Smart-attach flows. **Auto-decided (P1, "observability is scope, not afterthought"):** add, as explicit Phase 1/2 deliverables: a metric for summary generation success/failure rate, a metric for Smart-attach candidate-acceptance rate (did the user take the top-ranked suggestion or search for another — this is the eval signal for whether ranking is any good), and structured log lines (IDs/counts only, no content) at finalize, summary-generation start/end, and SF write.

### Section 9 — Deployment & Rollout Review

- **Migration safety:** `linked_records[]` replacing `interview_id` — resolved in Section 1 (additive, not destructive).
- **Feature flag:** **Auto-decided (P1, given the still-open consent question):** the always-on summary generation should ship behind a flag/gradual rollout, not instantly to 100% of captures — this directly de-risks User Challenge 1 regardless of how it's resolved (if a consent gate is added, the flag lets it roll out gradually; if not, the flag is the safety valve).
- **Rollback:** revert the flag; the additive schema means no data migration rollback is needed.

### Section 10 — Long-Term Trajectory Review

- **Technical debt introduced:** the plan's own Section 5/1 debt (no consent gate, no cost tiering, no decide_later queue) is real and already surfaced — not hidden.
- **Reversibility:** 3/5 — the schema change is additive/reversible; the consent posture, once shipped without a gate, is much harder to walk back (can't un-send transcripts already sent to Anthropic).
- **1-year question:** a new engineer reading this plan in 12 months would ask "why does Section 11 exclude the Transcript tab (08a) when it's the one place users can verify a wrong summary" — Codex #20 already names this; **added to TODOS below**, not silently dropped.

### Section 11 — Design & UX Review (CEO-level; full pass deferred to Phase 2 /plan-design-review)

Information architecture and interaction-state coverage are strong in the underlying spec (`08b-08c-post-call-notes-link.md` already has a scenario table: P1-P4, N1-N5). The one CEO-level design flag: **AI slop risk is low** (the design is specific — hand-font notes, provenance cards, confidence percentages — not generic patterns), but Section 11's "user journey coherence" flags the same T9 issue Claude's subagent found: the Smart-attach rail's visual weight (320px sidebar, small uppercase label) doesn't match its actual importance as the primary filing decision. **Recommend running /plan-design-review next** (Phase 2) to resolve this at full depth — noting it here so Phase 2 doesn't have to rediscover it.

## Required Outputs (Section 1-11 rollup)

**"NOT in scope"** (this CEO pass): pre-call linkage via calendar/attendee context (Codex #2 — real idea, deferred to TODOS); admin-configurable SF object taxonomy (Codex #10 — deferred to TODOS); success-metrics dashboard (Codex #6 — deferred to TODOS); recruiting-workflow-execution reframing (Codex #8, #26 — a genuinely bigger idea, deferred to TODOS as a future direction, not this plan's job to solve).

**"What already exists"**: consent/capture-policy infrastructure (reusable for User Challenge 1's resolution), existing SOQL-injection fix pattern (F1, reusable for Smart-attach), existing PII log-scrub convention, existing notes-sync retry pattern (`notes-sync.js`, reusable pattern for summary-generation retry).

**Dream state delta:** this plan reaches the 12-month ideal on linkage generality; falls short on consent/cost-tiering/success-metrics unless the User Challenges are resolved in the user's favor at the gate.

## GSTACK CEO REVIEW — DECISION AUDIT TRAIL

| # | Section | Decision | Classification | Principle | Rationale |
|---|---------|----------|-----------------|-----------|-----------|
| 1 | Step 0/1 | Add explicit `kept_internal`/`decide_later` reverse transitions to schema | Mechanical | P5 | Avoid future migration for an obvious gap |
| 2 | Step 0/1 | Ranking-service and summary-prompt calls must be non-blocking to finalizeSession | Mechanical | P1 | New SPOFs on a previously-reliable path |
| 3 | Step 0/1 | Additive schema migration (keep interview_id as compat field) | Mechanical | P3 | Cheaper rollback than destructive rename |
| 4 | Section 2 | Add rescue actions for all 5 error-handling GAPs | Mechanical | P1 | Cheap with CC, currently silent-failure risk |
| 5 | Section 3 | Apply existing parameterized-query fix pattern to new SOSL search | Mechanical | P4 (DRY) | Don't reintroduce a bug class already fixed once |
| 6 | Section 3 | Per-object-type ownership checks, not one generic check | Mechanical | P1 | Sharing rules differ by SF object type |
| 7 | Section 4 | Idempotency key on confirm-and-upload; in-flight guard on re-summarize; provenance invalidation on privatize-after-summarize | Mechanical | P1 | Real gaps, cheap fixes |
| 8 | Section 6 | Add explicit unit test: private notes excluded from LLM + SF payloads | Mechanical | P1 | Structural enforcement, not UI-only hiding |
| 9 | Section 7 | Cache Smart-attach candidates per session; respect SF API limits | Mechanical | P1 | New fan-out on every finalize |
| 10 | Section 8 | Add metrics + structured logs for summary/attach flows | Mechanical | P1 | Currently zero observability specified |
| 11 | Section 9 | Ship always-on summary behind a rollout flag | Mechanical | P1 | De-risks Challenge 1 regardless of resolution |
| — | Step 0 | Unconditional summarization vs. consent gate | **User Challenge 1 — RESOLVED** | User decision | **User explicitly chose: ship with NO consent gate, exactly as scoped.** Both dual voices recommended adding one; user was presented the full tradeoff and decided against it. Standing decision — do not re-add a gate or re-litigate without the user raising it again. |
| — | Step 0 | Full 5-phase scope vs. thin validation slice | **User Challenge 2 — RESOLVED** | User decision | **User confirmed: full plan as scoped**, consistent with the earlier Premise Gate answer. Codex's thin-slice argument was heard and explicitly declined. |
| — | Step 0/11 | T9 layout conflict (pixel-perfect vs. flagged-wrong Smart-attach rail) | **Taste Decision — RESOLVED** | User decision | **User confirmed: build pixel-perfect to the current side-rail export**, deferring the T9 fix rather than resolving it first. Phase 3 builds the 320px-rail Smart-attach layout as-is; T9 remains open in the backlog (task #12) for a future pass, not silently dropped. |

**All three Phase 1 decisions are now settled — zero unresolved items entering Phase 2.**

## CEO Review — Completion Summary

```
+====================================================================+
|            MEGA PLAN REVIEW — COMPLETION SUMMARY (Phase 1/4)       |
+====================================================================+
| Mode selected        | SELECTIVE EXPANSION                          |
| Premise Gate         | User confirmed: one bundled plan             |
| Section 1  (Arch)    | 4 issues found, all auto-decided             |
| Section 2  (Errors)  | 5 codepaths mapped, 5 GAPS, all auto-decided |
| Section 3  (Security)| 3 issues found; 1 deferred as User Challenge |
| Section 4  (Data/UX) | 4 edge cases mapped, 4 unhandled, auto-fixed |
| Section 5  (Quality)| No issues (plan stage, patterns sound)       |
| Section 6  (Tests)   | Diagram produced, 1 structural-test gap      |
| Section 7  (Perf)    | 2 issues found, auto-decided                 |
| Section 8  (Observ)  | Zero observability found, 2 metrics added    |
| Section 9  (Deploy)  | 1 risk flagged (rollout flag added)          |
| Section 10 (Future)  | Reversibility: 3/5, 2 debt items named       |
| Section 11 (Design)  | T9 layout conflict found; deferred to gate;  |
|                       | recommend /plan-design-review next           |
+--------------------------------------------------------------------+
| NOT in scope         | written (5 items, deferred to TODOS #22-26)  |
| What already exists  | written (4 reusable patterns identified)     |
| Dream state delta    | written                                      |
| Error/rescue registry| 5 methods, 5 GAPS (all resolved via auto-decide)|
| Failure modes        | 9 total, 0 remaining CRITICAL GAPS           |
| TODOS.md updates     | 5 items added (#22-26)                       |
| Scope proposals      | 5 proposed (pre-call linkage, admin taxonomy,|
|                       | success metrics, reframe, decide_later queue)|
|                       | 0 accepted into this plan's scope (all       |
|                       | deferred to TODOS - correctly out of blast   |
|                       | radius per user's Premise Gate answer)       |
| Outside voice        | N/A - dual voice (Claude subagent + Codex)   |
|                       | already run as this phase's own review       |
| Diagrams produced    | 5 (dependency graph, data flow, state machine,|
|                       | error flow, deployment note)                 |
| Unresolved decisions | 3 (2 User Challenges, 1 Taste Decision) -    |
|                       | deferred to Phase 4 final gate               |
+====================================================================+
```

## Phase 2 — Design Review (via /autoplan)

### Step 0: Initial rating
**7/10 on visual specificity** (colors/spacing/typography are pixel-exact, hand-font/badge/chip system is intentional, low AI-slop risk) — **3/10 on interaction-state completeness** (loading/error/partial/empty states, accessibility, responsive behavior are almost entirely unspecified). No `DESIGN.md` exists in this repo — proceeding with universal design principles, existing token system (`tokens.css`) as the only formal design-system anchor.

### Dual Voices

**CLAUDE SUBAGENT (design — independent review), 12 findings:** no confirm-and-upload result state (CRITICAL — in-flight/success/failure entirely unspecified for the single most consequential action on the screen); Discard has no confirmation/destructive styling; confirm-and-upload duplicated across tabs but selection state only visible on Summary tab (what does clicking Confirm from the Notes tab actually attach?); default-checked "Also attach" on a 62%-confidence match is a concrete CRM-pollution defect, not just an abstract risk; no loading/skeleton state for summary generation or Smart-attach ranking; "Create record from call" has zero visual design despite 5 different object-type forms; no control anywhere for a user to actually mark/unmark a note private; timestamp-chip "jump to transcript" has no valid destination since 08a is out of scope; no visual design for provenance going stale after a note is privatized; flyout has no dismiss affordance (Esc/click-outside undefined — does it no-op or silently trigger "Decide later," a materially different data outcome); Definition of Done's "motion" claim is unfalsifiable against a static-markup reference.

**CODEX (design — UX challenge), 25 findings:** independently confirms several of the above (no result state, no Discard confirmation, no loading states, T9 acknowledged-then-deferred) and adds: responsive strategy is fixed-pixel with no breakpoints/min-window-size/collapse behavior; scroll ownership across 5 independent regions is unspecified; **accessibility is absent, not aspirational** — tabs are unlabeled `<span>`s with no ARIA/keyboard model, the flyout's search is a decorative span not a real input, result rows are `<div>`s not buttons, text runs 9-12px with no minimum-target-size standard, contrast on `--ink-5`/10px text and the 45%-dimmed background is unverified; multi-attach selection semantics are contradictory (primary has no checkbox and reads as mandatory, secondaries default-checked); confidence percentages ("94%") create false authority over what the plan itself calls weak/ambiguous matching signals; provenance is presented as certainty an LLM cannot actually guarantee; **the "Stays local until you confirm" UI string is now a materially false product promise** given the architecture (and the user's explicit Challenge-1 decision to ship without a consent gate) — this is a copy-accuracy defect, independent of and not reopening that architecture decision; the visible-but-out-of-scope Transcript tab is a dead affordance that should be explicitly disabled, not silently broken.

**DESIGN DUAL VOICES — LITMUS SCORECARD:**
```
═══════════════════════════════════════════════════════════════════
  Litmus check                                    Verdict
  ────────────────────────────────────────────── ──────────────────
  Brand/product unmistakable in first screen?      YES
  One strong visual anchor present?                YES (TL;DR card)
  Understandable by scanning headlines only?       YES
  Each section has one job?                        YES
  Are cards actually necessary?                     YES (candidate cards, provenance cards earn their existence)
  Does motion improve hierarchy?                    UNVERIFIABLE (no motion spec exists — both voices flagged)
  Premium feel with shadows removed?               YES
  AI slop blacklist hit?                            NO (specific, not generic — both voices agree)
═══════════════════════════════════════════════════════════════════
Both voices converge: visual design is genuinely good (low AI-slop risk, real hierarchy, real
brand specificity). The gap is entirely in unspecified STATES and ACCESSIBILITY, not aesthetics.
```

### Auto-decided (P1, completeness — cheap with CC, currently silent gaps), added to Phase 3 scope:
Confirm-and-upload gets explicit in-flight/success/failure states (spinner+disable → success confirmation with SF record link → inline error with retry, matching Section 2's rescue actions). Discard gets destructive styling + a one-step confirm ("Discard this call? This can't be undone."). Summary/Smart-attach get skeleton-loading states appearing immediately on finalize. Notes/Transcript-tab confirm buttons surface a read-only "Filing to: X — see Summary tab to change" line rather than acting on invisible state. Default-uncheck any "Also attach" suggestion below 80% confidence. The private-note toggle gets an explicit hover-reveal affordance on each note row. The Transcript-tab entry is disabled/grayed (not hidden, not silently clickable-but-dead) until 08a ships. The flyout gets an explicit Escape/click-outside = no-op decision (does NOT implicitly trigger Decide later — that requires deliberate footer action). Tabs get real `button`/ARIA-tab semantics with keyboard arrow support; the flyout's search becomes a real `<input>`; result rows become real buttons — baseline accessibility, not optional. Confidence percentages get a qualifying label ("estimated match," not bare "94%") given the plan's own admission these are weak signals. Provenance cards get language framing them as supporting context ("likely informed this line"), not causal fact. **The "Stays local until you confirm" string is corrected to accurately describe what actually happens** (transcript/non-private notes are sent for summarization on finalize; only the Salesforce write itself waits for confirmation) — a copy fix, not a reopening of the already-decided no-consent-gate architecture.

### Deferred to TODOS.md (real scope, not this plan's job to fully solve now):
Responsive/min-window-size strategy for Post-call (ties to existing backlog item T12, "Define minimum window size + collapse behavior," already pending) — this plan's phases don't re-solve T12, they inherit whatever T12 eventually decides. "Create record from call" needs its own small design pass across 5 object types before Phase 4 builds it (already flagged in CEO Phase 1). Navigate-away-mid-upload's full resumability/background-continuation story (idempotency key from Section 4 handles duplicate-write safety; full background-continuation UX is bigger than this plan's scope) — logged as a residual gap, not silently dropped.

## Design Review — Completion Summary
```
+====================================================================+
|         DESIGN PLAN REVIEW — COMPLETION SUMMARY (Phase 2/4)        |
+====================================================================+
| Step 0                | 7/10 visual specificity, 3/10 state coverage|
| Dual voices            | Claude: 12 findings. Codex: 25 findings.   |
| Pass 1 (Info Arch)     | 6/10 -> fixed via confirm-button prominence,|
|                        |  Notes/Transcript-tab attach-preview line   |
| Pass 2 (States)        | 2/10 -> 8/10 (loading/error/success/empty   |
|                        |  states added for every new flow)           |
| Pass 3 (Journey)       | 5/10 -> 8/10 (Discard/Keep-internal/Decide- |
|                        |  later now give explicit commitment feedback|
| Pass 4 (AI Slop)       | 9/10, no fix needed (both voices: low risk) |
| Pass 5 (Design System) | N/A - no DESIGN.md exists (noted, not a gap |
|                        |  introduced by this plan)                   |
| Pass 6 (Responsive/A11y)| 1/10 -> 6/10 (real ARIA/keyboard/input      |
|                        |  semantics added; responsive strategy       |
|                        |  deferred to existing T12, not solved here) |
| Pass 7 (Decisions)     | 1 resolved now (flyout Escape behavior),    |
|                        |  2 deferred to TODOS (responsive/T12,       |
|                        |  create-record design pass)                 |
+--------------------------------------------------------------------+
| Overall design score   | 5/10 -> 8/10 (visual quality was always     |
|                        |  high; state/accessibility gaps now closed) |
| Unresolved decisions   | 0 (copy-accuracy fix does not reopen        |
|                        |  User Challenge 1 - architecture unchanged) |
+====================================================================+
```

## 5. Non-negotiables carried into every phase

- Security and performance are in scope for every change, not a follow-up pass (explicit user instruction).
- Follow the `electron-development` skill (https://github.com/sickn33/agentic-awesome-skills/blob/main/skills/electron-development/SKILL.md) checklist for any new window/IPC/renderer surface — same checklist already used for the meeting-notification panel (task #37h).
- Pixel-perfect against the reference `.jsx` + `tokens.css`, not a reinterpretation — verify via `claude_design` MCP `render_preview` + browser-harness screenshot diff, same process used for screens 01/02/02b (tasks #30m/#30n/#30o).
