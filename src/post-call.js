/**
 * Screen 08 family — Post-call UI (pixel shell + Gemini summary + SF link flyout).
 * Logic: PLAN-screen-08-post-call-v2 (Gemini only for summary).
 */

let currentMeeting = null;
let selectedLinks = [];
let activeTab = 'summary';
let uiHooks = {};

function $(id) {
  return document.getElementById(id);
}

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
  const meetingId = meeting.id;

  const poll = async () => {
    // The user navigated away from this meeting - don't keep polling for a
    // view that isn't showing anymore.
    if (!currentMeeting || currentMeeting.id !== meetingId) return;
    const res = await window.electronAPI.getMeetingSummaryStatus(meeting.notesSessionId);
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
  $('pcDuration').textContent = `${dur} · just now`;
  $('pcSubMeta').textContent = `${dur} · ${(meeting.transcript || []).length} segments · ${words} words`;

  const unlinked =
    !meeting.interviewId &&
    !meeting.interview_id &&
    meeting.link_status !== 'linked' &&
    !(meeting.linked_records && meeting.linked_records.length);

  $('pcChipUnlinked').style.display = unlinked && meeting.link_status !== 'kept_internal' ? 'inline-flex' : 'none';
  $('pcMain').classList.toggle('dimmed', unlinked && meeting.link_status !== 'kept_internal' && meeting.link_status !== 'decide_later');
  $('pcFlyout').style.display =
    unlinked && meeting.link_status !== 'kept_internal' && meeting.link_status !== 'decide_later' ? 'block' : 'none';

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
    body.textContent = meeting.aiSummaryError || 'Try Re-summarize. Summary uses Gemini on the server.';
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
    // Tone hints from design tokens
    const tone = String(s.label || '').toLowerCase();
    if (tone.includes('flag') || tone.includes('comp')) lab.classList.add('tone-amber');
    if (tone.includes('skill') || tone.includes('decision')) lab.classList.add('tone-green');
    if (tone.includes('motivation') || tone.includes('action')) lab.classList.add('tone-accent');
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
  const prov = $('pcProvenance');
  if (!prov) return;
  prov.innerHTML = '';
  const items = meeting.aiSummaryProvenance || [];
  if (!items.length) {
    prov.innerHTML = '<div class="pc-meta">Note → summary provenance appears after Gemini finishes when notes informed the summary.</div>';
    return;
  }
  items.forEach((p) => {
    const card = document.createElement('div');
    card.className = 'pc-provenance-card';
    card.innerHTML = `<div class="note"></div><div class="into"></div>`;
    card.querySelector('.note').textContent = `“${p.note}”`;
    card.querySelector('.into').textContent = `Likely informed: ${p.into}`;
    prov.appendChild(card);
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
  if (meeting.interviewId || meeting.interview_id) {
    const card = document.createElement('div');
    card.className = 'pc-candidate primary';
    card.innerHTML = `<div class="name">Interview linked</div><div class="why"></div>`;
    card.querySelector('.why').textContent = meeting.interviewId || meeting.interview_id;
    body.appendChild(card);
  }
  records.forEach((r) => {
    if (r.type === 'Interview' && (r.id === meeting.interviewId || r.id === meeting.interview_id)) return;
    const card = document.createElement('div');
    card.className = 'pc-candidate primary';
    card.innerHTML = `<div class="name"></div><div class="why"></div>`;
    card.querySelector('.name').textContent = r.name || r.id;
    card.querySelector('.why').textContent = `${r.type} · ${r.id}`;
    body.appendChild(card);
  });
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
  if ($('pcTldrCard')) $('pcTldrCard').style.display = tab === 'summary' ? '' : 'none';
  if ($('pcSections')) $('pcSections').style.display = tab === 'summary' ? '' : 'none';
  if ($('pcNotesPane')) $('pcNotesPane').style.display = tab === 'notes' ? '' : 'none';
  if ($('pcTranscriptPane')) $('pcTranscriptPane').style.display = tab === 'transcript' ? '' : 'none';
  if (tab === 'notes' && currentMeeting) {
    renderNotes(currentMeeting);
  }
  if (tab === 'transcript' && currentMeeting) {
    renderTranscript(currentMeeting);
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
    box.innerHTML = `<div class="pc-meta" style="padding:8px 12px;"></div>`;
    box.querySelector('.pc-meta').textContent = res.message || 'Search failed';
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
    row.className = 'pc-flyout-row';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = isBest || r.score >= ATTACH_THRESHOLD;
    if (cb.checked) checked.add(r);
    cb.setAttribute('aria-label', `Attach ${r.name}`);
    row.appendChild(cb);
    const chip = document.createElement('span');
    chip.className = 'pc-chip pc-chip-green';
    chip.textContent = r.type;
    row.appendChild(chip);
    const info = document.createElement('div');
    info.style.cssText = 'flex:1;min-width:0';
    const name = document.createElement('div');
    name.style.cssText = 'font-size:12.5px;font-weight:600;';
    name.textContent = isBest ? `${r.name} · Best match` : r.name;
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
    } finally {
      btn.disabled = false;
    }
  });
  $('pcTabSummary')?.addEventListener('click', () => setTab('summary'));
  $('pcTabNotes')?.addEventListener('click', () => setTab('notes'));
  $('pcTabTranscript')?.addEventListener('click', () => setTab('transcript'));

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
        $('pcTldrBody').textContent = result.error || 'Re-summarize failed';
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
      try {
        await window.electronAPI.linkMeetingRecords(currentMeeting.id, selectedLinks);
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
