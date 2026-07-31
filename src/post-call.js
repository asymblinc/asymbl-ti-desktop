/**
 * Screen 08 family — Post-call UI (pixel shell + Gemini summary + SF link flyout).
 * Logic: PLAN-screen-08-post-call-v2 (Gemini only for summary).
 */

let currentMeeting = null;
let selectedLinks = [];
let activeTab = 'summary';
let uiHooks = {};
// The signed-in user's SF instance host (e.g. https://foo.my.salesforce.com),
// known only once a search response has returned it this session - lets
// Smart-attach cards link straight to the real record. Session-lifetime
// only, same as suppressedMeetingUrls elsewhere in this app; a meeting
// linked in a past session just renders its card non-clickable until a
// fresh search happens again.
let sfInstanceUrl = null;

// tokens.css chip tones per SF object type - shared by the Smart-attach
// rail (renderRail) and the flyout search results (runSearch).
const CHIP_TONE = { Interview: 'blue', Job: 'blue', JobApplicant: 'blue', Contact: 'green', Account: 'purple', Opportunity: 'amber' };

// Verified live (2026-07-25): same class of bug as sf_reconnect_required -
// internal error codes/messages (e.g. "gemini_api_key_missing", or a raw
// Temporal "Failed to start Workflow") were rendered to the user verbatim.
// Shared by renderSummary (auto-poll path) and the Re-summarize button's own
// handler (which used to write result.error straight to the DOM).
const SUMMARY_ERROR_MESSAGES = {
  gemini_api_key_missing: "The server's Gemini API key isn't configured yet. Try again after that's fixed, or keep editing your notes.",
  empty_transcript: 'No transcript was captured for this call, so there was nothing to summarize.',
};
function summaryErrorMessage(error) {
  return SUMMARY_ERROR_MESSAGES[error] || 'Try Re-summarize. Summary uses Gemini on the server.';
}

function $(id) {
  return document.getElementById(id);
}

// post-call.jsx's own example data: Skills=neutral, Comp=amber,
// Motivation=green, Flags=accent. gemini-summary.ts's prompt only ever
// emits one of these fixed labels per template (recruiter: Skills/Comp/
// Motivation/Flags/Next steps; general: Topics/Decisions/Action items/
// Open questions) - an exact lookup is both correct and simpler than a
// keyword heuristic (the previous version tagged Skills as green and
// Motivation as accent - backwards from the actual design). Hoisted to
// module scope (CodeRabbit review, 2026-07-27) - was recreated on every
// forEach iteration.
const SECTION_TONE = {
  comp: 'tone-amber',
  motivation: 'tone-green',
  flags: 'tone-accent',
  'next steps': 'tone-accent',
  decisions: 'tone-green',
  'action items': 'tone-accent',
  'open questions': 'tone-amber',
};

// Perf audit (2026-07-25, Grok P1/P4): the only way to pick up a
// finalize-enqueued Gemini summary used to be the "Re-summarize" button,
// which calls generate-summary and RE-ENQUEUES a second Temporal workflow -
// there was no read-only "is it done yet" path. This polls the read-only
// summary status endpoint only (never re-triggers generation) with
// exponential backoff (2s -> 10s cap), and stops the moment the status is
// terminal (ready/error/skipped) instead of running for a fixed 120s.
let pollTimer = null;

function stopSummaryPoll() {
  if (pollTimer) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }
}

function startSummaryPoll(meeting) {
  stopSummaryPoll();
  if (!meeting?.notesSessionId) return;
  const status = meeting.aiSummaryStatus || (meeting.hasSummary ? 'ready' : 'none');
  if (status !== 'pending' && status !== 'writing') return;

  let delay = 2000;
  const MAX_DELAY_MS = 10000;
  // Real bug found via CodeRabbit review: with no ceiling, a summary stuck
  // in 'writing'/'pending' forever (e.g. a crashed worker) polled forever
  // and left "Writing notes…" showing indefinitely with no way out but
  // manually clicking Re-summarize.
  const MAX_POLL_MS = 3 * 60 * 1000;
  const startedAt = Date.now();
  const meetingId = meeting.id;

  const poll = async () => {
    // The user navigated away from this meeting - don't keep polling for a
    // view that isn't showing anymore.
    if (!currentMeeting || currentMeeting.id !== meetingId) return;
    if (Date.now() - startedAt > MAX_POLL_MS) {
      currentMeeting.aiSummaryStatus = 'error';
      currentMeeting.aiSummaryError = null;
      renderSummary(currentMeeting);
      if (typeof uiHooks.onSummaryUpdated === 'function') {
        uiHooks.onSummaryUpdated(meetingId, currentMeeting);
      }
      return;
    }
    const res = await window.electronAPI.getMeetingSummaryStatus(meetingId);
    if (res.status === 'success') {
      const s = res.summary;
      if (s.status === 'ready' || s.status === 'error' || s.status === 'skipped') {
        currentMeeting.aiSummary = s.markdown || s.tldr || currentMeeting.aiSummary;
        currentMeeting.aiSummaryTldr = s.tldr ?? currentMeeting.aiSummaryTldr;
        currentMeeting.aiSummarySections = s.sections ?? currentMeeting.aiSummarySections;
        currentMeeting.aiSummaryProvenance = s.provenance ?? currentMeeting.aiSummaryProvenance;
        currentMeeting.aiSummaryStatus = s.status;
        currentMeeting.hasSummary = s.status === 'ready';
        currentMeeting.aiSummaryError = s.error || s.skip_reason || null;
        renderSummary(currentMeeting);
        if (typeof uiHooks.onSummaryUpdated === 'function') {
          uiHooks.onSummaryUpdated(meetingId, currentMeeting);
        }
        return; // terminal - stop polling
      }
    }
    delay = Math.min(Math.round(delay * 1.6), MAX_DELAY_MS);
    pollTimer = setTimeout(poll, delay);
  };
  pollTimer = setTimeout(poll, delay);
}

export function openPostCallView(meeting) {
  currentMeeting = meeting;
  selectedLinks = Array.isArray(meeting.linked_records) ? [...meeting.linked_records] : [];
  const view = $('postCallView');
  if (!view) return;
  // Prime the SF host from bootstrap (via getAuthStatus) so already-linked
  // record cards are clickable the moment this view opens - without this,
  // sfInstanceUrl was only ever populated by an /sf/search response, so a
  // meeting linked in an earlier session rendered a dead card until the
  // user happened to search again.
  if (!sfInstanceUrl) {
    window.electronAPI
      .getAuthStatus()
      .then((s) => {
        if (s?.sfInstanceUrl && !sfInstanceUrl) {
          sfInstanceUrl = s.sfInstanceUrl;
          if (isPostCallOpen() && currentMeeting) renderRail(currentMeeting, isUnlinked(currentMeeting));
        }
      })
      .catch(() => {});
  }
  view.classList.add('is-open');
  view.style.display = 'flex';
  if ($('editorView')) $('editorView').style.display = 'none';
  if ($('homeView')) $('homeView').style.display = 'none';
  const appMain = document.querySelector('.home-grid');
  if (appMain) appMain.style.display = 'none';

  if ($('backButton')) $('backButton').style.display = 'block';
  if ($('newNoteBtn')) $('newNoteBtn').style.display = 'none';
  if ($('toggleSidebar')) $('toggleSidebar').style.display = 'none';
  const joinMeetingBtn = $('joinMeetingBtn');
  if (joinMeetingBtn) joinMeetingBtn.style.display = 'none';

  $('pcTitle').textContent = meeting.title || 'Meeting';
  const dur = meeting.duration_s != null ? `${Math.round(meeting.duration_s / 60)} min` : formatDurationFromMeeting(meeting);
  const words = (meeting.transcript || []).reduce(
    (n, t) => n + String(t.text || '').split(/\s+/).filter(Boolean).length,
    0
  );
  // post-call.jsx meta line format: "32 min · 2 speakers · 4,212 words".
  const speakerCount = new Set((meeting.transcript || []).map((t) => t.speaker).filter(Boolean)).size;
  $('pcDuration').textContent = `${dur} · ${formatRelativeCompletion(meeting)}`;
  $('pcSubMeta').textContent = `${dur} · ${speakerCount} speaker${speakerCount === 1 ? '' : 's'} · ${words.toLocaleString()} words`;

  const unlinked = isUnlinked(meeting);

  $('pcChipUnlinked').style.display = unlinked && meeting.link_status !== 'kept_internal' ? 'inline-flex' : 'none';
  // /autoplan C3: never auto-open. This used to slam the flyout over the
  // summary the moment the view opened - often while that summary still read
  // "Gemini is summarizing this conversation" - demanding a filing decision
  // before delivering the thing the user came for. The "Not linked" chip and
  // the rail's own CTA are the nudge now.
  $('pcFlyout').style.display = 'none';
  // post-call-notes-link.jsx's Unlinked variant also uses the 340px rail.
  if ($('pcBody')) $('pcBody').classList.toggle('pc-body-wide-rail', unlinked);

  renderSummary(meeting);
  refreshCommitButton();
  renderNotes(meeting);
  renderTranscript(meeting);
  renderRail(meeting, unlinked);
  setTab('summary');
  startSummaryPoll(meeting);
}

export function closePostCallView() {
  stopSummaryPoll();
  const view = $('postCallView');
  if (view) {
    view.classList.remove('is-open');
    view.style.display = 'none';
  }
  if ($('pcFlyout')) $('pcFlyout').style.display = 'none';
  const appMain = document.querySelector('.home-grid');
  if (appMain) appMain.style.display = '';
  currentMeeting = null;
}

function formatDurationFromMeeting(meeting) {
  if (meeting.recordingStartTime && meeting.recordingEndTime) {
    const s = (new Date(meeting.recordingEndTime) - new Date(meeting.recordingStartTime)) / 1000;
    if (s > 0) return `${Math.max(1, Math.round(s / 60))} min`;
  }
  return '—';
}

// Real "when" for the meta line - was hardcoded to "just now" regardless of
// how long ago the call actually finished (found via CodeRabbit review).
function formatRelativeCompletion(meeting) {
  const iso = meeting.recordingEndTime || meeting.date;
  const then = iso ? new Date(iso).getTime() : NaN;
  if (Number.isNaN(then)) return 'just now';
  const minutes = Math.round((Date.now() - then) / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function isUnlinked(meeting) {
  if (!meeting) return false;
  return (
    !meeting.interviewId &&
    !meeting.interview_id &&
    meeting.link_status !== 'linked' &&
    !(meeting.linked_records && meeting.linked_records.length)
  );
}

export function renderSummary(meeting) {
  const status = meeting.aiSummaryStatus || (meeting.hasSummary ? 'ready' : 'none');
  const label = $('pcTldrLabel');
  const body = $('pcTldrBody');
  const sectionsEl = $('pcSections');
  if (!label || !body || !sectionsEl) return;
  sectionsEl.innerHTML = '';

  if (status === 'pending' || status === 'writing') {
    label.textContent = '✦ Writing notes…';
    body.textContent = 'Gemini is summarizing this conversation. You can keep editing your notes.';
    body.className = 'pc-tldr-body pc-status-writing';
    return;
  }
  if (status === 'error') {
    label.textContent = '✦ Summary unavailable';
    body.textContent = summaryErrorMessage(meeting.aiSummaryError);
    body.className = 'pc-tldr-body';
    return;
  }
  if (status === 'skipped') {
    label.textContent = '✦ Kept internal';
    body.textContent = 'AI summary was skipped for this capture.';
    body.className = 'pc-tldr-body';
    return;
  }

  const isRecruiter = Boolean(meeting.interviewId || meeting.interview_id);
  label.textContent = isRecruiter ? '✦ Recruiter-aware summary' : '✦ General summary';
  body.className = 'pc-tldr-body';
  body.textContent = meeting.aiSummaryTldr || meeting.aiSummary || 'No summary yet — click Re-summarize.';

  const sections = meeting.aiSummarySections || [];
  sections.forEach((s) => {
    const card = document.createElement('div');
    card.className = 'pc-section-card';
    const lab = document.createElement('div');
    lab.className = 'pc-section-label';
    lab.textContent = s.label;
    const toneClass = SECTION_TONE[String(s.label || '').toLowerCase()];
    if (toneClass) lab.classList.add(toneClass);
    card.appendChild(lab);
    const ul = document.createElement('ul');
    (s.items || []).forEach((item) => {
      const li = document.createElement('li');
      li.innerHTML = `<span style="color:var(--ink-5)">·</span><span></span>`;
      li.querySelector('span:last-child').textContent = item;
      ul.appendChild(li);
    });
    card.appendChild(ul);
    sectionsEl.appendChild(card);
  });
}

function renderNotes(meeting) {
  const editor = $('pcNotesEditor');
  if (editor) editor.value = meeting.content || '';
}

// post-call-notes-link.jsx: the Notes tab's right rail shows provenance
// ("How your notes shaped the summary"), not Smart-attach - the same rail
// slot renderRail() uses for the Summary tab, swapped per active tab (see
// setTab). No "stays local" caption in this variant's footer.
function renderProvenanceRail(meeting) {
  const body = $('pcRailBody');
  if (!body) return;
  const items = meeting.aiSummaryProvenance || [];
  const noteLineCount = String(meeting.content || '').split('\n').filter((l) => l.trim()).length;

  $('pcRailTitle').textContent = 'How your notes shaped the summary';
  $('pcRailSub').textContent = noteLineCount
    // Says "not in Salesforce", NOT "never leaves this device" - the latter
    // was false (verified 2026-07-30): main.js's saveMeetingsData fires
    // notesSync.syncNote on every save, POSTing the full note body to
    // control-plane (notes-sync.js). The `private: true` flag it sends keeps
    // the note out of Salesforce, which is a materially different promise.
    ? `${items.length} of ${noteLineCount} notes were woven in. Private notes are never written to Salesforce.`
    : 'Summary was built from the transcript alone.';

  body.innerHTML = '';
  if (!items.length) {
    const empty = document.createElement('div');
    empty.className = 'pc-meta';
    empty.textContent = 'Note → summary provenance appears after Gemini finishes when notes informed the summary.';
    body.appendChild(empty);
    return;
  }
  items.forEach((p) => {
    const card = document.createElement('div');
    card.className = 'pc-provenance-card';
    const note = document.createElement('div');
    note.className = 'note hand';
    note.textContent = `"${p.note}"`;
    const into = document.createElement('div');
    into.className = 'into';
    into.innerHTML = '<span aria-hidden="true">→</span> <span></span>';
    into.querySelector('span:last-child').textContent = p.into;
    card.appendChild(note);
    card.appendChild(into);
    body.appendChild(card);
  });
}

function renderTranscript(meeting) {
  const pane = $('pcTranscriptPane');
  if (!pane) return;
  const lines = meeting.transcript || [];
  if (!lines.length) {
    pane.innerHTML = '<div class="pc-meta">No transcript segments yet.</div>';
    return;
  }
  pane.innerHTML = '';
  lines.forEach((t) => {
    const row = document.createElement('div');
    row.className = 'pc-tx-row';
    const who = document.createElement('span');
    who.className = 'pc-tx-speaker';
    who.textContent = t.speaker || 'Speaker';
    const text = document.createElement('span');
    text.className = 'pc-tx-text';
    text.textContent = t.text || '';
    row.appendChild(who);
    row.appendChild(text);
    pane.appendChild(row);
  });
}

// Plain-text renderings for Copy/Export - read from the same underlying
// meeting fields the Summary/Transcript panes already render from, not from
// the DOM, so formatting stays correct even if a pane hasn't rendered yet.
function buildSummaryText(meeting) {
  const lines = [];
  if (meeting.title) lines.push(meeting.title);
  const isRecruiter = Boolean(meeting.interviewId || meeting.interview_id);
  lines.push(isRecruiter ? 'Recruiter-aware summary' : 'General summary');
  lines.push('');
  lines.push(meeting.aiSummaryTldr || meeting.aiSummary || 'No summary yet.');
  (meeting.aiSummarySections || []).forEach((s) => {
    lines.push('');
    lines.push(s.label || '');
    (s.items || []).forEach((item) => lines.push(`- ${item}`));
  });
  return lines.join('\n').trim();
}

function buildTranscriptText(meeting) {
  const lines = meeting.transcript || [];
  if (!lines.length) return 'No transcript segments yet.';
  return lines.map((t) => `${t.speaker || 'Speaker'}: ${t.text || ''}`).join('\n');
}

function activeTabText(meeting) {
  return activeTab === 'transcript' ? buildTranscriptText(meeting) : buildSummaryText(meeting);
}

/** Commit button state. Terminal ("Filed to Salesforce ✓", disabled) once
 * everything currently selected has been uploaded; re-armed as soon as a
 * not-yet-uploaded record is selected, so a second attach after an upload is
 * still possible. */
function refreshCommitButton() {
  const btn = $('pcConfirmUpload');
  if (!btn || !currentMeeting) return;
  const uploadedIds = new Set(
    (currentMeeting.sfUpload?.uploaded || []).map((u) => u.id).filter(Boolean)
  );
  const selected = currentMeeting.linked_records || [];
  const pending = selected.filter((r) => !uploadedIds.has(r.id));
  if (uploadedIds.size > 0 && pending.length === 0) {
    btn.textContent = 'Filed to Salesforce ✓';
    btn.disabled = true;
  } else if (uploadedIds.size > 0) {
    btn.textContent = `Upload ${pending.length} more to Salesforce`;
    btn.disabled = false;
  } else {
    btn.textContent = 'Confirm & upload to Salesforce';
    btn.disabled = false;
  }
}

// Transient "Copied ✓"/"Exported ✓" confirmation on a button. Keyed per
// button so two clicks in quick succession don't let the first click's
// reset timer wipe the second click's confirmation (noticed during
// verification, 2026-07-29).
const labelResetTimers = new WeakMap();
function flashButtonLabel(btn, message, restoreTo) {
  if (!btn) return;
  clearTimeout(labelResetTimers.get(btn));
  btn.textContent = message;
  labelResetTimers.set(
    btn,
    setTimeout(() => {
      btn.textContent = restoreTo;
    }, 1500)
  );
}

function renderRail(meeting, unlinked) {
  const body = $('pcRailBody');
  if (!body) return;
  body.innerHTML = '';
  if (unlinked) {
    $('pcRailTitle').textContent = 'Link this call';
    $('pcRailSub').textContent = 'Search Salesforce or use the flyout. Summary still generates without a link.';
    const tip = document.createElement('div');
    tip.className = 'pc-meta';
    tip.textContent = 'Open the link flyout to search records, keep internal, or decide later.';
    body.appendChild(tip);
    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'pc-btn-ghost';
    open.style.marginTop = '12px';
    open.style.width = '100%';
    open.textContent = 'Open link flyout';
    open.onclick = () => {
      $('pcFlyout').style.display = 'block';
    };
    body.appendChild(open);
    return;
  }
  $('pcRailTitle').textContent = 'Smart-attach';
  $('pcRailSub').textContent = 'Files this conversation under the right Salesforce records.';
  const records = meeting.linked_records || [];

  // post-call.jsx candidate card: primary gets a "Best match" badge
  // (absolute, top:-8/left:12, accent pill) + 1.5px accent border; every
  // other candidate is a plain 1px-border card. Confidence (s.confidence in
  // the mockup) only exists for records that came from an actual Smart-
  // attach search - an already-linked record has no such score to show, so
  // it's omitted rather than fabricated (same honesty rule as sf-search.ts).
  const renderCandidateCard = (name, why, type, isPrimary, id) => {
    const card = document.createElement('div');
    card.className = 'pc-candidate' + (isPrimary ? ' primary' : '');
    if (isPrimary) {
      const badge = document.createElement('div');
      badge.className = 'pc-candidate-badge';
      badge.textContent = 'Best match';
      card.appendChild(badge);
    }
    const top = document.createElement('div');
    top.className = 'pc-candidate-top';
    const chip = document.createElement('span');
    chip.className = `pc-chip pc-chip-${CHIP_TONE[type] || 'blue'}`;
    chip.textContent = type;
    top.appendChild(chip);
    card.appendChild(top);
    const nameEl = document.createElement('div');
    nameEl.className = 'name';
    nameEl.textContent = name;
    card.appendChild(nameEl);
    const whyEl = document.createElement('div');
    whyEl.className = 'why';
    whyEl.textContent = why;
    card.appendChild(whyEl);
    // Salesforce's plain ID-redirect URL works for any object type
    // (standard or custom) - only clickable once a search this session has
    // told us the signed-in user's real instance host (see sfInstanceUrl).
    if (id && sfInstanceUrl) {
      card.classList.add('clickable');
      card.setAttribute('role', 'button');
      card.setAttribute('tabindex', '0');
      card.title = 'Open in Salesforce';
      const open = () => window.electronAPI.openExternalUrl(`${sfInstanceUrl}/${id}`);
      card.addEventListener('click', open);
      card.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          open();
        }
      });
    }
    return card;
  };

  let isFirst = true;
  if (meeting.interviewId || meeting.interview_id) {
    const interviewId = meeting.interviewId || meeting.interview_id;
    body.appendChild(renderCandidateCard('Interview linked', interviewId, 'Interview', isFirst, interviewId));
    isFirst = false;
  }
  records.forEach((r) => {
    if (r.type === 'Interview' && (r.id === meeting.interviewId || r.id === meeting.interview_id)) return;
    body.appendChild(renderCandidateCard(r.name || r.id, `${r.type} · ${r.id}`, r.type, isFirst, r.id));
    isFirst = false;
  });

  const findAnother = document.createElement('button');
  findAnother.type = 'button';
  findAnother.className = 'pc-find-another';
  findAnother.textContent = 'Find another record…';
  findAnother.onclick = () => {
    $('pcFlyout').style.display = 'block';
    $('pcFlyoutSearch')?.focus();
  };
  body.appendChild(findAnother);

  if (meeting.sfUpload?.uploaded?.length) {
    const ok = document.createElement('div');
    ok.className = 'pc-meta';
    ok.style.marginTop = '8px';
    ok.textContent = `Uploaded ${meeting.sfUpload.uploaded.length} note(s) to Salesforce.`;
    body.appendChild(ok);
  }
}

function setTab(tab) {
  activeTab = tab;
  ['summary', 'notes', 'transcript'].forEach((t) => {
    const btn = document.getElementById(`pcTab${t[0].toUpperCase()}${t.slice(1)}`);
    if (btn) btn.setAttribute('aria-selected', t === tab ? 'true' : 'false');
  });
  // post-call-notes-link.jsx: Notes tab's rail is 340px, not the Summary
  // tab's 320px. An unlinked meeting also uses the 340px rail on the
  // Summary tab (see openPostCallView) - real bug found via CodeRabbit
  // review: this used to key off `tab === 'notes'` alone, so switching to
  // Notes and back to Summary silently dropped the unlinked wide-rail
  // state openPostCallView had set.
  if ($('pcBody')) {
    $('pcBody').classList.toggle('pc-body-wide-rail', tab === 'notes' || isUnlinked(currentMeeting));
  }
  if ($('pcTldrCard')) $('pcTldrCard').style.display = tab === 'summary' ? '' : 'none';
  if ($('pcSections')) $('pcSections').style.display = tab === 'summary' ? '' : 'none';
  if ($('pcNotesPane')) $('pcNotesPane').style.display = tab === 'notes' ? '' : 'none';
  if ($('pcTranscriptPane')) $('pcTranscriptPane').style.display = tab === 'transcript' ? '' : 'none';
  // Copy/export only make sense for Summary and Transcript - Notes already
  // has its own editable/auto-save affordance.
  if ($('pcCopy')) $('pcCopy').style.display = tab === 'notes' ? 'none' : '';
  if ($('pcExport')) $('pcExport').style.display = tab === 'notes' ? 'none' : '';
  // post-call-notes-link.jsx: the rail swaps content per tab (Smart-attach
  // for Summary, provenance for Notes) - not just the main pane.
  if ($('pcRailFooterCaption')) $('pcRailFooterCaption').style.display = tab === 'notes' ? 'none' : '';
  if (currentMeeting) {
    if (tab === 'notes') {
      renderNotes(currentMeeting);
      renderProvenanceRail(currentMeeting);
    } else if (tab === 'transcript') {
      renderTranscript(currentMeeting);
    } else {
      renderRail(currentMeeting, isUnlinked(currentMeeting));
    }
  }
}

async function runSearch(q) {
  const box = $('pcFlyoutResults');
  if (!box) return;
  if (!q || q.length < 2) {
    box.innerHTML = '';
    return;
  }
  box.innerHTML = '<div class="pc-meta" style="padding:8px 12px;">Searching Salesforce…</div>';
  const res = await window.electronAPI.searchSalesforce(q);
  box.innerHTML = '';
  if (res.instanceUrl) sfInstanceUrl = res.instanceUrl;
  if (res.status !== 'success') {
    // Verified live (2026-07-25): this used to dump the raw error CODE
    // ("sf_reconnect_required") straight into the UI instead of a readable
    // message with an actual way to fix it - found by driving a real search
    // against a real (expired) Salesforce session, not just reading the code.
    if (res.message === 'sf_reconnect_required') {
      const wrap = document.createElement('div');
      wrap.className = 'pc-meta';
      wrap.style.cssText = 'padding:8px 12px;';
      wrap.textContent = 'Your Salesforce connection needs to be refreshed. ';
      const reconnect = document.createElement('a');
      reconnect.href = '#';
      reconnect.style.cssText = 'color:var(--accent);cursor:pointer;';
      reconnect.textContent = 'Reconnect Salesforce';
      reconnect.onclick = async (e) => {
        e.preventDefault();
        await window.electronAPI.startLogin();
      };
      wrap.appendChild(reconnect);
      box.appendChild(wrap);
      return;
    }
    const errBox = document.createElement('div');
    errBox.className = 'pc-meta';
    errBox.style.cssText = 'padding:8px 12px;';
    errBox.textContent = 'Search failed. Try again in a moment.';
    box.appendChild(errBox);
    return;
  }
  // Only the best match (highest-scored hit, results arrive pre-sorted by
  // score desc) is pre-checked. Real bug found via user report, 2026-07-28:
  // this used to also auto-check every OTHER result scoring >= 80 - fine
  // when only the best match clears that bar, but a common first name (e.g.
  // "Chris") can return several ~90%-confidence hits that all got silently
  // pre-selected, attaching people the user never chose. "Also attach" is
  // now opt-in only, regardless of score.
  // /autoplan 2026-07-30: NOTHING is pre-selected. Previously the top hit was
  // pre-checked and updateLocalSelection() was called unconditionally at the
  // end of every search - so merely TYPING attached a record, hid the "Not
  // linked" chip, and re-rendered the rail with a record the user never
  // picked. Selection now requires an explicit click, every time.
  // Seeded from whatever is already attached so re-searching doesn't appear
  // to drop existing attachments.
  // Seed from EVERYTHING already attached, not just what this search happens
  // to return. Filtering to the current result set (as an earlier pass did)
  // silently dropped a record attached under a previous query the moment the
  // user searched for something else - so attaching Contact then searching
  // for the Job Applicant lost the Contact.
  const checked = new Set(currentMeeting?.linked_records || []);

  // Security audit (2026-07-25, Grok #8): selection stays purely local - it
  // never writes link state SERVER-SIDE until the user explicitly commits via
  // "Confirm & upload". That constraint is unchanged here; only the local UI
  // state updates below.
  const updateLocalSelection = () => {
    selectedLinks = [...checked];
    if (!currentMeeting) return;
    currentMeeting.linked_records = selectedLinks;
    const interview = selectedLinks.find((r) => r.type === 'Interview');
    // Symmetric: set AND clear. Previously interviewId was assigned but never
    // cleared, so removing every record left stale renderer state that made
    // the upload guard pass while disk was empty.
    currentMeeting.interviewId = interview ? interview.id : null;
    currentMeeting.link_status = selectedLinks.length ? 'linked' : 'unlinked';
    // Symmetric: the empty branch used to be skipped entirely, leaving the
    // rail showing a record that was no longer selected and the chip hidden.
    $('pcChipUnlinked').style.display = selectedLinks.length ? 'none' : 'inline-flex';
    renderRail(currentMeeting, selectedLinks.length === 0);
    // The commit button goes terminal after a successful upload, but must
    // come back the moment the user selects something NOT yet uploaded -
    // otherwise the attach-a-second-record flow that F5 exists to fix would
    // be blocked by the very UI that reports success.
    refreshCommitButton();
  };

  (res.results || []).forEach((r) => {
    const row = document.createElement('div');
    const isChecked = [...checked].some((c) => c.id === r.id);
    row.className = 'pc-flyout-row' + (isChecked ? ' selected' : '');
    // The whole row is the control. It already had cursor:pointer and a hover
    // background but no handler - the only target was a 13x13 checkbox inside
    // a 354x46 row. Multi-attach is preserved deliberately: the server writes
    // one ContentNote per target, and Contact + Job Applicant on one call is a
    // real recruiter journey.
    row.setAttribute('role', 'checkbox');
    row.setAttribute('tabindex', '0');
    row.setAttribute('aria-checked', isChecked ? 'true' : 'false');
    row.setAttribute('aria-label', `Attach ${r.name}`);
    const mark = document.createElement('span');
    mark.className = 'pc-row-check' + (isChecked ? ' is-on' : '');
    mark.setAttribute('aria-hidden', 'true');
    mark.textContent = isChecked ? '✓' : '';
    row.appendChild(mark);
    const chip = document.createElement('span');
    chip.className = `pc-chip pc-chip-${CHIP_TONE[r.type] || 'blue'}`;
    chip.textContent = r.type;
    row.appendChild(chip);
    const info = document.createElement('div');
    info.style.cssText = 'flex:1;min-width:0';
    const name = document.createElement('div');
    name.style.cssText = 'font-size:12.5px;font-weight:600;';
    name.textContent = r.name;
    const why = document.createElement('div');
    why.style.cssText = 'font-size:10.5px;color:var(--ink-4);';
    why.textContent = `${r.sub} · ~${r.score}% estimated match`;
    info.appendChild(name);
    info.appendChild(why);
    row.appendChild(info);
    const toggle = () => {
      const on = [...checked].some((c) => c.id === r.id);
      if (on) {
        for (const c of [...checked]) if (c.id === r.id) checked.delete(c);
      } else {
        checked.add(r);
      }
      const nowOn = !on;
      row.classList.toggle('selected', nowOn);
      row.setAttribute('aria-checked', nowOn ? 'true' : 'false');
      mark.classList.toggle('is-on', nowOn);
      mark.textContent = nowOn ? '✓' : '';
      updateLocalSelection();
    };
    row.addEventListener('click', toggle);
    row.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        toggle();
      }
    });
    box.appendChild(row);
  });
}

export function wirePostCallUi(hooks = {}) {
  if (!$('postCallView')) return;
  uiHooks = hooks;

  $('pcClose')?.addEventListener('click', () => {
    closePostCallView();
    if (typeof hooks.onClose === 'function') hooks.onClose();
  });
  $('pcDiscard')?.addEventListener('click', async () => {
    if (!currentMeeting?.id) return;
    const confirmed = window.confirm(
      'Discard this call? This deletes your notes and summary and cannot be undone.'
    );
    if (!confirmed) return;
    const btn = $('pcDiscard');
    btn.disabled = true;
    try {
      const res = await window.electronAPI.discardMeeting(currentMeeting.id);
      if (!res.success) {
        alert(res.error || 'Could not discard this call');
        return;
      }
      closePostCallView();
      if (typeof hooks.onDiscarded === 'function') {
        hooks.onDiscarded(currentMeeting.id);
      } else if (typeof hooks.onClose === 'function') {
        hooks.onClose();
      }
    } catch (e) {
      alert(e.message || 'Could not discard this call');
    } finally {
      btn.disabled = false;
    }
  });
  $('pcTabSummary')?.addEventListener('click', () => setTab('summary'));
  $('pcTabNotes')?.addEventListener('click', () => setTab('notes'));
  $('pcTabTranscript')?.addEventListener('click', () => setTab('transcript'));

  $('pcCopy')?.addEventListener('click', async () => {
    if (!currentMeeting) return;
    // Inline button-text feedback, not alert() - a blocking native dialog
    // for a clipboard failure is worse than the failure itself (real gap
    // found via testing, 2026-07-28: alert() froze the whole renderer).
    let message = 'Copied ✓';
    try {
      await navigator.clipboard.writeText(activeTabText(currentMeeting));
    } catch (e) {
      message = 'Could not copy';
    }
    flashButtonLabel($('pcCopy'), message, 'Copy');
  });

  $('pcExport')?.addEventListener('click', async () => {
    if (!currentMeeting) return;
    const isTranscript = activeTab === 'transcript';
    const safeTitle = (currentMeeting.title || 'meeting').replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '');
    // Written by the main process (into ~/Downloads, then revealed in
    // Finder), not a Blob/<a download> - see main.js's exportTextFile
    // handler for why the browser trick doesn't finalize the file here.
    const res = await window.electronAPI.exportTextFile({
      filename: `${safeTitle}-${isTranscript ? 'transcript' : 'summary'}.txt`,
      content: activeTabText(currentMeeting),
    });
    flashButtonLabel($('pcExport'), res?.success ? 'Saved to Downloads ✓' : 'Export failed', 'Export');
  });

  $('pcResummarize')?.addEventListener('click', async () => {
    if (!currentMeeting?.id) return;
    // Explicit re-enqueue - stop the automatic read-only poll so it
    // doesn't race generateMeetingSummaryStreaming's own internal poll.
    stopSummaryPoll();
    $('pcTldrLabel').textContent = '✦ Writing notes…';
    $('pcTldrBody').textContent = 'Re-summarizing with Gemini…';
    $('pcResummarize').disabled = true;
    try {
      const result = await window.electronAPI.generateMeetingSummaryStreaming(currentMeeting.id);
      if (result.success) {
        currentMeeting.aiSummary = result.summary;
        currentMeeting.aiSummaryTldr = result.tldr;
        currentMeeting.aiSummaryStatus = 'ready';
        currentMeeting.hasSummary = true;
        renderSummary(currentMeeting);
        if (typeof uiHooks.onSummaryUpdated === 'function') {
          uiHooks.onSummaryUpdated(currentMeeting.id, currentMeeting);
        }
      } else {
        currentMeeting.aiSummaryStatus = 'error';
        currentMeeting.aiSummaryError = result.error || null;
        currentMeeting.hasSummary = false;
        renderSummary(currentMeeting);
        if (typeof uiHooks.onSummaryUpdated === 'function') {
          uiHooks.onSummaryUpdated(currentMeeting.id, currentMeeting);
        }
      }
    } catch (e) {
      currentMeeting.aiSummaryStatus = 'error';
      currentMeeting.aiSummaryError = null;
      currentMeeting.hasSummary = false;
      renderSummary(currentMeeting);
      if (typeof uiHooks.onSummaryUpdated === 'function') {
        uiHooks.onSummaryUpdated(currentMeeting.id, currentMeeting);
      }
    } finally {
      $('pcResummarize').disabled = false;
    }
  });

  let searchTimer;
  $('pcFlyoutSearch')?.addEventListener('input', (e) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => runSearch(e.target.value.trim()), 280);
  });

  // /autoplan C1: "Done" is gone. It looked like a dismiss button but was a
  // mandatory save - confirmUploadMeeting read links from DISK while the
  // renderer's guard read in-memory selectedLinks, so skipping Done produced
  // "Select a Salesforce record first" while the rail visibly showed the
  // record attached. confirmUploadMeeting now takes selectedLinks directly
  // and does a strict superset of what linkMeetingRecords did.
  $('pcFlyoutClose')?.addEventListener('click', () => {
    $('pcFlyout').style.display = 'none';
  });
  // Design review fix: Escape/click-outside must not implicitly trigger
  // "Decide later" - a materially different data outcome from just closing.
  $('pcFlyout')?.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      $('pcFlyout').style.display = 'none';
    }
  });

  // Create-record mini-form is explicitly out-of-scope this pass (PLAN v2
  // §12, TODOS.md item 27's P4-2) - honest "not built yet" rather than a
  // silent no-op or a fake success.
  $('pcCreateRecord')?.addEventListener('click', () => {
    alert('Creating a new Salesforce record from here is coming soon. Use Keep internal for now, or close this and file it later.');
  });

  $('pcKeepInternal')?.addEventListener('click', () => {
    if (currentMeeting) {
      currentMeeting.link_status = 'kept_internal';
      if (typeof hooks.onPersistLinkStatus === 'function') {
        hooks.onPersistLinkStatus(currentMeeting.id, 'kept_internal');
      }
    }
    $('pcFlyout').style.display = 'none';
    $('pcChipUnlinked').style.display = 'none';
    $('pcRailSub').textContent = 'Kept internal — will not sync to Salesforce.';
  });

  // /autoplan C2: "Decide later" is gone. It cost a click to set a flag
  // nothing read, and named an attention queue that has no unfiled row.
  // Not filing IS deciding later - closing the search already means that.
  // Persisted 'decide_later' values from older records are still accepted by
  // main.js's setMeetingLinkStatus and render as unlinked (isUnlinked treats
  // any non-'linked' status without records as unlinked), so old data is
  // readable rather than orphaned.

  $('pcConfirmUpload')?.addEventListener('click', async () => {
    if (!currentMeeting?.id) return;
    const btn = $('pcConfirmUpload');
    if (currentMeeting.link_status === 'kept_internal') {
      alert('Kept internal — nothing to upload to Salesforce.');
      return;
    }
    const hasLink =
      selectedLinks.length ||
      currentMeeting.interviewId ||
      currentMeeting.interview_id ||
      (currentMeeting.linked_records && currentMeeting.linked_records.length);
    if (!hasLink) {
      alert('Select a Salesforce record first (or Keep internal).');
      $('pcFlyout').style.display = 'block';
      $('pcFlyoutSearch')?.focus();
      return;
    }
    btn.disabled = true;
    btn.textContent = 'Uploading…';
    try {
      // Save notes edits before upload
      if ($('pcNotesEditor') && typeof hooks.onSaveNotes === 'function') {
        hooks.onSaveNotes(currentMeeting.id, $('pcNotesEditor').value);
      }
      // C1: hand the renderer's selection straight to the commit. This is the
      // explicit user action that Grok #8 requires before anything is written
      // server-side - nothing before this point touched the server.
      const res = await window.electronAPI.confirmUploadMeeting(
        currentMeeting.id,
        selectedLinks.length ? selectedLinks : currentMeeting.linked_records || []
      );
      if (res.success) {
        currentMeeting.sfUpload = res.result;
        currentMeeting.link_status = 'linked';
        // Terminal state, not a 2s flash that re-arms an action which can no
        // longer do anything. Filing the call is the payoff of this screen.
        $('pcChipUnlinked').style.display = 'none';
        renderRail(currentMeeting, false);
        refreshCommitButton();
      } else {
        alert(res.error || 'Upload failed');
        btn.textContent = 'Confirm & upload to Salesforce';
        btn.disabled = false;
      }
    } catch (e) {
      alert(e.message || 'Upload failed');
      btn.textContent = 'Confirm & upload to Salesforce';
      btn.disabled = false;
    }
  });

  $('pcNotesEditor')?.addEventListener('change', () => {
    if (currentMeeting && typeof hooks.onSaveNotes === 'function') {
      currentMeeting.content = $('pcNotesEditor').value;
      hooks.onSaveNotes(currentMeeting.id, $('pcNotesEditor').value);
    }
  });

  // Live summary updates from main process
  if (window.electronAPI?.onSummaryUpdate) {
    window.electronAPI.onSummaryUpdate((data) => {
      if (!currentMeeting || data.meetingId !== currentMeeting.id) return;
      if (data.aiSummaryStatus) currentMeeting.aiSummaryStatus = data.aiSummaryStatus;
      if (data.content && data.aiSummaryStatus === 'writing') {
        $('pcTldrBody').textContent = data.content;
        $('pcTldrLabel').textContent = '✦ Writing notes…';
      }
    });
  }
  if (window.electronAPI?.onSummaryGenerated) {
    window.electronAPI.onSummaryGenerated(async (meetingId) => {
      if (!currentMeeting || meetingId !== currentMeeting.id) return;
      if (typeof hooks.onReloadMeeting === 'function') {
        const m = await hooks.onReloadMeeting(meetingId);
        if (m) {
          currentMeeting = m;
          renderSummary(m);
          renderNotes(m);
        }
      }
    });
  }
}

export function isPostCallOpen() {
  const view = $('postCallView');
  return Boolean(view && view.classList.contains('is-open'));
}

/** Prefer post-call for finished captures with transcript or summary work. */
export function shouldOpenPostCall(meeting) {
  if (!meeting) return false;
  if (meeting.recordingComplete) return true;
  if (meeting.aiSummaryStatus && meeting.aiSummaryStatus !== 'none') return true;
  if (meeting.hasSummary || meeting.aiSummary) return true;
  if (meeting.transcript && meeting.transcript.length > 0 && meeting.notesSessionId) return true;
  return false;
}
