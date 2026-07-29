/**
 * Screen 08 family — Post-call UI (pixel shell + Gemini summary + SF link flyout).
 * Logic: PLAN-screen-08-post-call-v2 (Gemini only for summary).
 */

let currentMeeting = null;
let selectedLinks = [];
let activeTab = 'summary';
let uiHooks = {};

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
  $('pcMain').classList.toggle('dimmed', unlinked && meeting.link_status !== 'kept_internal' && meeting.link_status !== 'decide_later');
  $('pcFlyout').style.display =
    unlinked && meeting.link_status !== 'kept_internal' && meeting.link_status !== 'decide_later' ? 'block' : 'none';
  // post-call-notes-link.jsx's Unlinked variant also uses the 340px rail.
  if ($('pcBody')) $('pcBody').classList.toggle('pc-body-wide-rail', unlinked);

  renderSummary(meeting);
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
    ? `${items.length} of ${noteLineCount} notes were woven in. Private notes never leave this device.`
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
  const renderCandidateCard = (name, why, type, isPrimary) => {
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
    return card;
  };

  let isFirst = true;
  if (meeting.interviewId || meeting.interview_id) {
    body.appendChild(renderCandidateCard('Interview linked', meeting.interviewId || meeting.interview_id, 'Interview', isFirst));
    isFirst = false;
  }
  records.forEach((r) => {
    if (r.type === 'Interview' && (r.id === meeting.interviewId || r.id === meeting.interview_id)) return;
    body.appendChild(renderCandidateCard(r.name || r.id, `${r.type} · ${r.id}`, r.type, isFirst));
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
  // Best match = highest-scored hit (results arrive pre-sorted by score,
  // desc). "Also attach" below ~80 confidence starts unchecked - PLAN v2
  // §7: "Also attach (default unchecked below threshold ~80%)".
  const ATTACH_THRESHOLD = 80;
  const checked = new Set(res.results?.length ? [res.results[0]] : []);

  // Security audit (2026-07-25, Grok #8): this used to call
  // linkMeetingRecords on every keystroke/checkbox toggle - typing in the
  // search box wrote link state to the server before the user confirmed
  // anything. Selection is now purely local (updates in-memory state only)
  // until the user explicitly clicks "Done" (see pcFlyoutDone below), which
  // is the one place that actually persists it.
  const updateLocalSelection = () => {
    selectedLinks = [...checked];
    if (currentMeeting) {
      currentMeeting.link_status = selectedLinks.length ? 'linked' : currentMeeting.link_status;
      const interview = selectedLinks.find((r) => r.type === 'Interview');
      if (interview) currentMeeting.interviewId = interview.id;
      currentMeeting.linked_records = selectedLinks;
      if (selectedLinks.length) {
        $('pcChipUnlinked').style.display = 'none';
        $('pcMain').classList.remove('dimmed');
        renderRail(currentMeeting, false);
      }
    }
  };

  (res.results || []).forEach((r, i) => {
    const isBest = i === 0;
    const row = document.createElement('div');
    // post-call-notes-link.jsx: the top row gets an accent-3 background,
    // not a text suffix - "selected" already carries that treatment.
    row.className = 'pc-flyout-row' + (isBest ? ' selected' : '');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = isBest || r.score >= ATTACH_THRESHOLD;
    if (cb.checked) checked.add(r);
    cb.setAttribute('aria-label', `Attach ${r.name}`);
    row.appendChild(cb);
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
    cb.onchange = () => {
      if (cb.checked) checked.add(r);
      else checked.delete(r);
      updateLocalSelection();
    };
    box.appendChild(row);
  });

  if (res.results?.length) {
    updateLocalSelection();
  }
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
    const btn = $('pcCopy');
    const original = btn.textContent;
    // Inline button-text feedback, not alert() - a blocking native dialog
    // for a clipboard failure is worse than the failure itself (real gap
    // found via testing, 2026-07-28: alert() froze the whole renderer).
    try {
      await navigator.clipboard.writeText(activeTabText(currentMeeting));
      btn.textContent = 'Copied ✓';
    } catch (e) {
      btn.textContent = 'Could not copy';
    }
    setTimeout(() => {
      btn.textContent = original;
    }, 1500);
  });

  $('pcExport')?.addEventListener('click', () => {
    if (!currentMeeting) return;
    const isTranscript = activeTab === 'transcript';
    const text = activeTabText(currentMeeting);
    const safeTitle = (currentMeeting.title || 'meeting').replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '');
    const filename = `${safeTitle}-${isTranscript ? 'transcript' : 'summary'}.txt`;
    const blob = new Blob([text], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
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

  $('pcFlyoutDone')?.addEventListener('click', async () => {
    // The one place selection actually persists server-side (Grok #8) -
    // everything before this was local-only state.
    if (currentMeeting?.id && selectedLinks.length) {
      const btn = $('pcFlyoutDone');
      btn.disabled = true;
      // Real bug found via CodeRabbit review: neither a rejected promise nor
      // a resolved-but-{success:false} result was checked, so the flyout
      // closed as if the link had succeeded even when it hadn't.
      try {
        const res = await window.electronAPI.linkMeetingRecords(currentMeeting.id, selectedLinks);
        if (!res?.success) {
          alert(res?.error || 'Could not link these records');
          return;
        }
      } catch (e) {
        alert(e.message || 'Could not link these records');
        return;
      } finally {
        btn.disabled = false;
      }
    }
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
    alert('Creating a new Salesforce record from here is coming soon. Use Keep internal or Decide later for now.');
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
    $('pcMain').classList.remove('dimmed');
    $('pcRailSub').textContent = 'Kept internal — will not sync to Salesforce.';
  });

  $('pcDecideLater')?.addEventListener('click', () => {
    if (currentMeeting) {
      currentMeeting.link_status = 'decide_later';
      if (typeof hooks.onPersistLinkStatus === 'function') {
        hooks.onPersistLinkStatus(currentMeeting.id, 'decide_later');
      }
    }
    $('pcFlyout').style.display = 'none';
  });

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
      return;
    }
    btn.disabled = true;
    btn.textContent = 'Uploading…';
    try {
      // Save notes edits before upload
      if ($('pcNotesEditor') && typeof hooks.onSaveNotes === 'function') {
        hooks.onSaveNotes(currentMeeting.id, $('pcNotesEditor').value);
      }
      const res = await window.electronAPI.confirmUploadMeeting(currentMeeting.id);
      if (res.success) {
        currentMeeting.sfUpload = res.result;
        currentMeeting.link_status = 'linked';
        btn.textContent = 'Uploaded ✓';
        renderRail(currentMeeting, false);
        setTimeout(() => {
          btn.textContent = 'Confirm & upload to Salesforce';
          btn.disabled = false;
        }, 2000);
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
