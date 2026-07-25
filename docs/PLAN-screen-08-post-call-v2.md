# PLAN v2 — Screen 08 family: Post-call review

**Status:** approved direction (2026-07-24) — supersedes Claude-as-summary assumptions in earlier autoplan drafts  
**Canonical build index:** [`implementation-08-post-call.md`](./implementation-08-post-call.md)  
**Repos:** `asymbl-ti-desktop` (UI), `Recall` (`gcp/control-plane`, Temporal worker activities)  
**Design SoT:** `/Users/sdevinarayanan/Downloads/TI Recall (1)/`  
- `desktop/post-call.jsx` → **08** Summary + Smart-attach  
- `desktop/post-call-notes-link.jsx` → **08b** Notes + provenance, **08c** Unlinked + flyout  
- `screen-specs/08b-08c-post-call-notes-link.md` → behavior  
- `tokens.css` + `brand/` → colors / logo  

**DoD:** pixel-match 08 / 08b / 08c against design (layout, tokens, type, chips, rails, flyout); real backend data (no mock arrays in prod path); summary for **every** intentional capture including unlinked; SF link optional via slide-out; Gemini-only summary; secure Electron + metered LLM; no provider keys on desktop.

---

## 0. Product premises (locked)

1. **Not every meeting is an interview.** Slack huddles, account calls, ad-hoc captures are first-class.
2. **Summary always (for intentional captures)** — independent of Salesforce link. Brandon-class meetings still get AI Notes.
3. **If unlinked → slide-out / flyout** to connect to Interview **or** other SF records (Job, Job Applicant, Contact, Account, Opportunity), or Keep internal / Decide later.
4. **UI from design is pixel-perfect inspiration; logic from this plan supersedes mock arrays and stub messages.**
5. **Post-call / AI Notes summary = Gemini only.** Not Claude. Not Recall “AI.”  
   Claude remains **only** for interview **signal extraction** when an Interview is linked.
6. **Desktop never calls LLMs** and never holds provider API keys.
7. **Privacy:** `kept_internal` / Discard never send transcript to Gemini. Auto-summary needs an explicit consent/privacy rule (P0-9) before production enqueue.

---

## 1. Three pipelines (do not conflate)

```
A. TRANSCRIPT (exists)
   Recall Desktop SDK → local meetings.json (+ finalize upload)
   Provider: Recall (media + words only)

B. MEETING SUMMARY / AI NOTES (build — Gemini)
   Keyed by notesSessionId / session
   Runs with or without SF link
   Templates: general (unlinked) | recruiter-aware (after Interview link + re-summarize)
   UI: 08 TL;DR (+ sections when interview-shaped), 08c dimmed general summary

C. INTERVIEW SIGNAL (exists — Claude)
   Temporal process_interview_capture
   Only when Interview linked
   Skills / Comp / Motivation / Flags → Firestore interview_signals + SF writeback
   UI: 08 section cards when linked to Interview
```

| | A Transcript | B Summary (new) | C Signal (existing) |
|--|--------------|-----------------|---------------------|
| Model | Recall STT | **Gemini** | Claude Sonnet |
| Needs interview_id? | No | **No** | **Yes** |
| Desktop field | `transcript[]` | `aiSummary` + status | optional compose into sections |
| SF | optional later | ContentNote / activity when linked | Extraction_Status + signal LWCs |

---

## 2. Screens (pixel + behavior)

### Shared shell (all tabs)

| Element | Token / visual | Behavior |
|---------|----------------|----------|
| Captured chip | `--green` / `--green-bg` | Session finalized |
| Duration | `--ink-4` 12px | From media or wall-clock estimate until finalized duration available |
| Tabs: Summary · Notes · Transcript | Segmented control (`--paper` active, shadow-sm) | Local tab state; **real buttons + ARIA** (not bare spans) |
| Re-summarize | Ghost, refresh icon | Re-run **Gemini** with current non-private notes |
| Discard | Ghost (destructive restyle) | Define deletes: local + server summary + no SF write |
| Confirm & upload | `--ink` fill | Only after link selection (or Keep internal has no upload) |

**08a Transcript tab:** out of scope (no design). Tab may be disabled or stub “Coming soon” until specified.

### 08 — Summary + Smart-attach (linked)

- Left: Avatar, title, meta (duration · speakers · words)  
- TL;DR card: sparkle + “Recruiter-aware summary” (or “General summary” if non-interview link) — **Gemini**  
- Section grid: Skills / Comp / Motivation / Flags when **Interview-linked signal** ready; hide or show “signal pending” if Claude path still running  
- Right rail **Smart-attach:** ranked candidates, Best match, confidence as “estimated match”, Also attach (default unchecked below threshold ~80%), Find another record…  
- Footer: Confirm & upload · “Stays local until you confirm”

### 08b — Notes + provenance

- Left: hand font (`--font-hand` / Caveat) editable notes until sync  
- Per note: timestamp chip (jump to transcript — **disabled until 08a**), PRIVATE badge, IN SUMMARY badge, action-item ☐  
- Right: “How your notes shaped the summary” — note → section line; private notes never appear  
- Zero notes: “Summary was built from the transcript alone”

### 08c — Unlinked + link flyout

- Amber **Not linked** chip  
- Main pane dimmed (~0.45): **General summary still shown** (Gemini)  
- Flyout “Where does this call belong?”  
  - Live search input (real `<input>`, not decorative span)  
  - Ranked rows: type chip · name · context · match reason  
  - Escape hatches: Create new record · Keep internal · Decide later  
- Summary **does not wait** on flyout; flyout is non-blocking

Design files: `post-call.jsx`, `post-call-notes-link.jsx`, `tokens.css`.

---

## 3. Current code reality (evidence)

| Gap | Evidence |
|-----|----------|
| Summary stub | `main.js` `generateMeetingSummary` returns static “removed…” string |
| `hasSummary=true` on stub | main.js ~1335, 1531, 2191 |
| No server summary API | PLAN-rich-notes §5.1 never built |
| Signal only if `interview_id` | `sessions.ts` finalize gate → `finalize_orphan_session` |
| Brandon meeting | 193 utterances, no interview_id, content = stub |
| No durable server transcript | finalize `transcript_destination_url: null` |
| Claude hardcoded for signal | `extraction-worker/src/extract.ts` |
| PostHog secret missing | separate ops fix |

---

## 4. Target architecture

```
Desktop (Electron)
  meetings.json: content (my notes) | aiSummary | aiSummaryStatus | linked_records | link_status | sessionId | notesSessionId | transcript
  JWT → control-plane (Mule optional hop)
       │
       ▼
control-plane (Cloud Run)
  finalizeSession:
    1. Persist transcript chunks + notes (non-private) under notesSessionId
    2. If privacy allows → Temporal start process_meeting_summary (Gemini)
    3. If Interview in linked_records → Temporal process_interview_capture (Claude) [existing]
  GET/POST /api/ti/desktop/notes/{id}/summary|generate-summary
  POST /api/ti/desktop/sessions/{id}/link  (search + attach)
  GET  /api/ti/desktop/sf/search?q=        (SOSL via user SF session)
       │
       ▼
Secret Manager: ti-gemini-api-key | ti-anthropic-api-key (signal only)
OpenMeter: feature=meeting_summary|interview_signal, provider=gemini|anthropic, tenant_id, tokens
Firestore / GCS: transcript + summary docs
Salesforce: on Confirm — multi-attach + ContentNote / Interview signal writeback
```

---

## 5. Gemini summary contract

### Trigger
- Finalize with non-empty transcript **and** privacy gate allows  
- Re-summarize button  
- After link to Interview (re-run with recruiter template) optional auto

### API (PLAN-rich-notes §5.1 shape)
```
POST /api/ti/desktop/notes/{notesSessionId}/generate-summary
GET  /api/ti/desktop/notes/{notesSessionId}/summary
→ { status: pending|writing|ready|error, markdown?, tldr?, sections?, provenance?, error? }
```

### Model
- **Gemini only** (pick at P1-2: e.g. `gemini-2.5-flash` default, pro if quality eval fails)  
- Secret: `ti-gemini-api-key` or Vertex AI SA  
- **Never** call Anthropic for this path

### Inputs
- Transcript utterances  
- Non-private notes with offsets  
- Optional SF context after link (job title, candidate name) for template switch  

### Outputs
- General: TL;DR + topics + action items  
- Recruiter-aware (Interview context): richer sections if design requires; may still be Gemini prose, with Claude signal filling Skills/Comp cards separately  
- Provenance map: note_id → summary line (best-effort “likely informed”, not causal claim in UI copy)

### Delivery
- Temporal `Client.start` (not fire-and-forget; Cloud Run `cpu_idle` would stall)  
- Desktop polls GET until ready  

---

## 6. Privacy gate (P0-9 — decide before Phase 1 prod)

Recommended default (keeps “I still want the summary” without auto-leaking private calls):

| Capture outcome | Auto Gemini summary? |
|-----------------|----------------------|
| User completed intentional recording (DESKTOP_ONLY / SUPPLEMENT / etc.) | Yes |
| User chooses **Keep internal** before/at end | No — and never re-prompt summary |
| **Discard** | No; delete local + server draft if any |
| Consent / capture-policy NONE | No capture / no summary |
| Empty transcript | No LLM call |

---

## 7. Smart-attach / link flyout

### Objects (v1)
Job · Job Applicant · Contact · Account · Opportunity · Interview (`bpats__Interview__c`)

### Mechanics
- Search via control-plane SOSL **as the signed-in user** (`sf-session-cache` / `soqlQueryAsUser`)  
- **`escapeSoslString()`** — SOSL reserved set ≠ SOQL (`?&|!{}[]()^~*:\"'+-`)  
- Ownership / sharing check before surface or attach  
- Ranking signals: calendar link, participant domain, transcript mentions (voice-match = later)  
- Multi-attach (“Also attach”)  
- States: `linked` | `unlinked` | `kept_internal` | `decide_later`  
  - Prefer derive “linked” from `linked_records[]`; scalar only for escape hatches  

### After link
| Link type | Then |
|-----------|------|
| Interview | Optional start Claude signal; Gemini re-summarize with recruiter template |
| Other | Gemini summary + ContentNote / activity on Confirm; no skills schema |
| Keep internal | No SF, no further Gemini if they opted out of AI |
| Decide later | Persist; Home attention queue (TODOS #22 — may ship thin: badge only) |

---

## 8. Per-tenant LLM / cost tracking

| Item | Approach |
|------|----------|
| Keys | GCP Secret Manager: `ti-gemini-api-key` (+ Anthropic for signal only) |
| Desktop | JWT only — zero provider keys |
| Meter | OpenMeter: `tenant_id`, `user_id`, `feature`, `provider`, `model`, tokens |
| BYOK | Follow-on (per-tenant Gemini secret) |
| Budgets | Per-tenant monthly cap; deny/degrade when exceeded |
| Join | `X-Asymbl-Request-Id` desktop → CP → logs |

ADR-022: one GCP project ≈ one tenant today → secret per project is enough for v1.

---

## 9. Phases & dependency graph

```
Phase 0 — Data model & honesty (desktop + CP)
  P0-1 Transcript storage shape (chunked / object store; not unbounded Firestore doc)
  P0-2 link_status + linked_records[] model
  P0-3 interview_id dual-write / read-compat during migration
  P0-4 Schema migration
  P0-5 Notes finalize payload { text, transcriptOffset, private }
  P0-6 Split meeting.content (My Notes) vs aiSummary / aiSummaryStatus; kill stub; fix hasSummary
  P0-7 Persist control-plane sessionId durably on meeting
  P0-8 Scope meetings.json per signed-in user/org
  P0-9 Privacy gate decision (documented + implemented)

Phase 1 — Always-on Gemini summary  [depends on P0-1,4,5,6,9]
  P1-1 Status protocol pending|writing|ready|error
  P1-2 General-summary prompt (Gemini)
  P1-2b Gemini client + Secret Manager
  P1-3 Temporal process_meeting_summary start (not fire-and-forget)
  P1-4 POST generate-summary + GET summary
  P1-5 OpenMeter + structured logs (provider=gemini)
  P1-6 Desktop poll + AI Notes UI field wiring

Phase 2 — Smart-attach  [depends on Phase 0; parallel to Phase 1]
  P2-1 Ranking / search via per-user SF session
  P2-2 escapeSoslString()
  P2-3 Per-object ownership checks
  P2-4 Partial SOSL failure handling (local cache + decide later)

Phase 3 — Pixel-perfect UI  [depends on Phase 1 + 2 for real data]
  P3-1 Accessible tab shell
  P3-2 08 Summary + Smart-attach rail (tokens exact)
  P3-3 08b Notes + provenance
  P3-4 08c Unlinked flyout (real input, escape hatches)
  P3-5 Confirm-and-upload + Discard confirmations
  P3-6 Electron security checklist

Phase 4 — SF write  [depends on Phase 2 + 3]
  P4-1 Idempotent multi-attach + ContentNote / signal
  P4-2 Create-record mini-form (own slice)

Ship order for value:
  P0-6 → P0-9 → P0-1/4/5 → Phase 1 (Brandon works) → Phase 2 → Phase 3 pixels → Phase 4
```

---

## 10. Desktop data model (local)

```text
meeting: {
  id, title, platform, date,
  transcript: [{ text, speaker, timestamp }],
  content,                 // My Notes only (never AI stub)
  aiSummary,               // Gemini markdown / structured
  aiSummaryStatus,         // none|pending|writing|ready|error
  hasSummary,              // true only if aiSummaryStatus === ready
  notesSessionId,
  controlPlaneSessionId,   // durable
  linked_records: [{ type, id, name, linkedAt }],
  link_status: unlinked|linked|kept_internal|decide_later,
  recordingId, recallRecordingId, recordingComplete, ...
}
```

---

## 11. Electron / security

- Render inside existing main window if possible  
- `contextIsolation: true`, no `nodeIntegration`, preload `contextBridge` only  
- Validate IPC; all CP calls via `control-plane-client` + `authStore`  
- No Gemini/Anthropic keys, no SF tokens in renderer storage  
- Sanitize any HTML render of summary (`marked` + strict sanitize)

---

## 12. Explicitly out of scope

| Item | Notes |
|------|--------|
| 08a Transcript tab design | No jsx/spec |
| Claude for general summary | Forbidden |
| Gemini for interview signal | Not required in v1; Claude stays |
| MuleSoft / asymbl.app custom domain | Parallel track |
| Full Home attention-queue + 7-day scheduler | TODOS #22; thin badge OK in v1 |
| Voice-match ranking | Later |
| Admin-configurable SF object taxonomy | TODOS #23 |
| Pre-call calendar linkage | TODOS #25 |
| Product pivot to “auto SF mutations” only | TODOS #26 |

---

## 13. Success metrics (minimal)

| Metric | Target (set after 2 weeks of data) |
|--------|-------------------------------------|
| `meeting_summary` success rate | Track fail reasons |
| Time finalize → summary ready | p50 / p95 |
| Link rate on unlinked captures | % linked within 24h |
| Keep internal rate | Watch privacy usage |
| OpenMeter $ / tenant / feature | Budget alerts |

---

## 14. Test plan (minimum)

| Layer | Cases |
|-------|--------|
| Unit | Gemini prompt short-circuit empty transcript; provenance excludes private notes; hasSummary only when ready |
| CP | Finalize orphan → summary workflow started; Keep internal → no Gemini; Interview link → Claude signal + optional Gemini re-run |
| SOSL | Injection / reserved chars; ownership filter |
| Desktop | Stub gone; poll states; flyout search keyboard ↵; tabs ARIA |
| E2E | Brandon-like: 193 utts, no interview → Gemini summary ready; then link Interview → signal path |

---

## 15. Open decisions (block Phase 1 only where noted)

| # | Decision | Default if silent |
|---|----------|-------------------|
| P0-9 | Privacy gate for auto Gemini | Auto-summarize intentional recordings; never if kept_internal/discard |
| Gemini model | flash vs pro | `gemini-2.5-flash` until quality fails eval |
| T9 Smart-attach layout | Side rail (design) vs primary surface | **v1 = design rail** (post-call.jsx); T9 later |
| Re-summarize after non-Interview link | Always / never / optional | Optional manual Re-summarize only |
| Decide later queue | Full 7-day vs badge only | Badge + link_status in v1 |

---

## 16. Definition of done (checklist)

- [ ] P0-6: no stub string in `content`; `hasSummary` truthful  
- [ ] Finalize without interview_id enqueues **Gemini** summary (privacy allowing)  
- [ ] 08c shows general summary while unlinked  
- [ ] Flyout searches SF (user session) and can link multi-object  
- [ ] Interview link can still run Claude signal  
- [ ] 08 / 08b / 08c pixel-match design tokens and layout  
- [ ] OpenMeter events for Gemini summary  
- [ ] No LLM keys on desktop  
- [ ] Electron security checklist pass  

---

## 17. References

- Design: `/Users/sdevinarayanan/Downloads/TI Recall (1)/`  
- Spec: `screen-specs/08b-08c-post-call-notes-link.md`  
- Build index: `docs/implementation-08-post-call.md`  
- Backend pointer: Recall `TODOS.md` #27  
- Prior autoplan review: `PLAN-screen-08-post-call.md` (historical; **summary provider = Gemini overrides any Claude-summary language there**)  
