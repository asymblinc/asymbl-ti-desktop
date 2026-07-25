/**
 * This file will automatically be loaded by webpack and run in the "renderer" context.
 * To learn more about the differences between the "main" and the "renderer" context in
 * Electron, visit:
 *
 * https://electronjs.org/docs/tutorial/process-model
 */

import './index.css';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import {
  openPostCallView,
  closePostCallView,
  wirePostCallUi,
  shouldOpenPostCall,
  isPostCallOpen,
  renderSummary,
} from './post-call.js';

marked.setOptions({ mangle: false, headerIds: false });

// Renders #simple-editor's markdown content into the read-only preview pane
// shown by default (real bug found via live use: the note view was a bare
// textarea with no rendering at all, so raw #/** characters showed
// literally). Keeps the existing textarea/autosave/streaming-update logic
// completely untouched - this only adds a rendered view on top of it.
function syncEditorPreview(content) {
  const preview = document.getElementById('simple-editor-preview');
  if (preview) {
    // Content includes transcript-derived and (later) server-generated AI
    // text, not just what the user typed - marked() doesn't sanitize
    // embedded HTML, so sanitize before it ever reaches innerHTML.
    preview.innerHTML = DOMPurify.sanitize(marked(content || ''));
  }
}

function setEditorContent(value) {
  const editorElement = document.getElementById('simple-editor');
  if (editorElement) {
    editorElement.value = value;
  }
  syncEditorPreview(value);
}

// Create empty meetings data structure to be filled from the file
const meetingsData = {
  upcomingMeetings: [],
  pastMeetings: []
};

// Create empty arrays that will be filled from file
const upcomingMeetings = [];
const pastMeetings = [];

// Shared toast helper - was duplicated inline at 2 call sites already
// (joinMeetingBtn's "no active meeting"/"error joining" cases); extracted
// here rather than adding a 3rd copy for the sign-in error case.
function showToast(message) {
  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.textContent = message;
  document.body.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = '0';
    setTimeout(() => {
      toast.remove();
    }, 300);
  }, 3000);
}

// Human-readable messages for sign-in failure reasons - the raw error/
// locked_reason strings from the OAuth callback were only ever
// console.error'd before, never shown to the user (real gap found during
// end-to-end testing, 2026-07-22).
const SIGN_IN_ERROR_MESSAGES = {
  license_inactive: {
    package_not_installed: 'Your Salesforce org doesn’t have Recall installed. Contact your admin.',
    license_not_assigned: 'You don’t have a Recall license assigned yet. Contact your admin.',
    license_revoked: 'Your Recall license has been revoked. Contact your admin.',
    sf_reconnect_required: 'Your Salesforce connection needs to be refreshed. Please sign in again.',
  },
  sf_oauth_failed: 'Salesforce sign-in failed. Please try again.',
  timeout: 'Sign-in timed out. Please try again.',
  missing_tokens: 'Salesforce sign-in failed. Please try again.',
};

function signInErrorMessage(error, lockedReason) {
  const entry = SIGN_IN_ERROR_MESSAGES[error];
  if (typeof entry === 'string') return entry;
  if (entry && lockedReason && entry[lockedReason]) return entry[lockedReason];
  return 'Sign-in failed. Please try again.';
}

// Shared between the header's small sign-in button and screen 00's gate CTA
// (added 2026-07-23) - both call the same startLogin() IPC path, they only
// differ in label. The gate button wraps its label in a span (it also has
// an icon), the header button doesn't, so update whichever text target the
// button actually has rather than assuming textContent is the whole button.
function wireSignInButton(btn, defaultLabel) {
  const labelEl = btn.querySelector('.auth-gate-btn-label') || btn;
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    labelEl.textContent = 'Signing in...';
    // try/finally (real gap found via code review, 2026-07-23): a rejected
    // startLogin() promise used to leave the button permanently disabled
    // showing "Signing in..." forever, with no error surfaced.
    try {
      const result = await window.electronAPI.startLogin();
      if (result.status !== 'success') {
        console.error('Sign-in failed:', result.error);
        showToast(signInErrorMessage(result.error, result.lockedReason));
        labelEl.textContent = defaultLabel;
      }
    } catch (error) {
      console.error('Sign-in threw:', error);
      showToast(signInErrorMessage());
      labelEl.textContent = defaultLabel;
    } finally {
      btn.disabled = false;
      await refreshAuthUi();
    }
  });
}

// Tracks sign-in state for gating recording actions - Record In-person
// Meeting/Record Meeting should not be usable while signed out (real gap
// found during end-to-end testing: these worked regardless of auth state).
window.isSignedIn = false;

// Spec B F2: toggles the header's sign-in button vs. avatar based on
// whether we've ever completed SF login (getAuthStatus checks in-memory
// access token OR the persisted refresh token, not full session validity -
// an expired/revoked refresh token still shows "signed in" here until the
// next real API call fails).
async function refreshAuthUi() {
  const signInBtn = document.getElementById('signInBtn');
  const userAvatar = document.getElementById('userAvatar');
  if (!signInBtn || !userAvatar) {
    return;
  }
  const { signedIn, email, photoDataUri, orgId, orgName, orgIsSandbox } = await window.electronAPI.getAuthStatus();
  window.isSignedIn = signedIn;
  window.currentUserEmail = email || null;
  if (typeof renderHomeConnection === 'function') {
    renderHomeConnection();
  }

  // Screen 00: full-bleed gate replaces the whole app while signed out -
  // except mid-recording, where auth dropping must never yank away the
  // stop/status controls out from under an in-progress capture (CEO review
  // finding, 2026-07-23). isSignedIn already reflects the persisted 7-day
  // refresh token (auth-store.js), not just the in-memory access token, so
  // an actively-used session doesn't flicker this on across restarts.
  const authGateView = document.getElementById('authGateView');
  const appContainer = document.querySelector('.app-container');
  if (authGateView && appContainer) {
    const shouldGate = !signedIn && !window.isRecording;
    authGateView.style.display = shouldGate ? 'grid' : 'none';
    appContainer.style.display = shouldGate ? 'none' : 'flex';
    // debugPanel/debugPanelToggle are siblings of .app-container, not
    // children - hiding the container alone left the gear icon floating
    // over the gate (found via visual verification screenshot).
    const debugPanel = document.getElementById('debugPanel');
    const debugPanelToggle = document.getElementById('debugPanelToggle');
    if (debugPanel) debugPanel.style.display = shouldGate ? 'none' : '';
    if (debugPanelToggle) debugPanelToggle.style.display = shouldGate ? 'none' : '';
    // @recallai/desktop-sdk injects its own floating widget button directly
    // onto <body> (its host element is a zero-width block with an
    // internally fixed-position button, so hiding .app-container doesn't
    // touch it) - also found via visual verification screenshot. Nothing
    // meeting-related is actionable behind the gate anyway (no home view
    // to act on its signals), so hiding it is correct, not just cosmetic.
    const recallWidgetRoot = document.getElementById('id-recall-widget-root');
    if (recallWidgetRoot) recallWidgetRoot.style.display = shouldGate ? 'none' : '';
  }

  signInBtn.style.display = signedIn ? 'none' : 'block';
  userAvatar.style.display = signedIn ? 'flex' : 'none';
  const newNoteBtn = document.getElementById('newNoteBtn');
  if (newNoteBtn) {
    newNoteBtn.disabled = !signedIn;
    newNoteBtn.title = signedIn ? '' : 'Sign in with Asymbl to record a meeting';
  }
  const joinMeetingBtn = document.getElementById('joinMeetingBtn');
  if (joinMeetingBtn) {
    // Re-evaluate against the last known detection state, not just
    // "signed out" - onMeetingDetectionStatus only fires on a detection
    // change, so if a meeting was already detected before sign-in
    // completed, no new event arrives to re-enable the button. Real gap
    // found during end-to-end testing 2026-07-22 (stayed greyed out after
    // sign-in with an active Slack meeting already detected).
    joinMeetingBtn.disabled = !window.meetingDetected || !signedIn;
    joinMeetingBtn.title = signedIn ? '' : 'Sign in with Asymbl to record a meeting';
  }
  // Real SF profile photo when the user has one set (fetched fresh on
  // every login, see control-plane's sf-oauth.ts); falls back to initials
  // otherwise - not every SF user has a profile photo.
  if (signedIn && photoDataUri) {
    userAvatar.style.backgroundImage = `url(${photoDataUri})`;
    userAvatar.style.backgroundSize = 'cover';
    userAvatar.style.backgroundPosition = 'center';
    userAvatar.textContent = '';
    userAvatar.title = email || '';
  } else if (signedIn && email) {
    userAvatar.style.backgroundImage = '';
    userAvatar.title = email;
    userAvatar.textContent = email[0].toUpperCase();
  } else {
    userAvatar.style.backgroundImage = '';
    userAvatar.removeAttribute('title');
    userAvatar.textContent = '';
  }
  const userMenuEmail = document.getElementById('userMenuEmail');
  if (userMenuEmail) {
    userMenuEmail.textContent = signedIn && email ? email : '';
  }
  // orgName is best-effort (control-plane's fetchOrganizationName - most
  // recruiter SF profiles lack "View Setup and Configuration" needed to read
  // it, researched 2026-07-23) - shown when available, falls back to just
  // the org ID (always present, no special permission needed) rather than
  // hiding the whole row.
  const userMenuOrg = document.getElementById('userMenuOrg');
  if (userMenuOrg) {
    if (signedIn && (orgName || orgId)) {
      userMenuOrg.style.display = '';
      userMenuOrg.innerHTML = '';
      if (orgName) {
        const nameRow = document.createElement('div');
        nameRow.className = 'user-menu-org-name-row';
        // Same cloud glyph as the sign-in screen's "Continue with Salesforce"
        // button (auth-gate-btn-primary) - one Salesforce icon, reused, not
        // a second one invented for this row.
        nameRow.innerHTML =
          '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" class="user-menu-org-icon"><path d="M2.5 9.5a2.5 2.5 0 0 1 4-2 3 3 0 0 1 5.5 1 2 2 0 0 1 .5 4H4.5a2 2 0 0 1-2-2.5z"/></svg>';
        const nameEl = document.createElement('span');
        nameEl.className = 'user-menu-org-name';
        nameEl.textContent = orgName;
        nameRow.appendChild(nameEl);
        if (orgIsSandbox) {
          const badge = document.createElement('span');
          badge.className = 'home-chip tone-amber';
          badge.textContent = 'Sandbox';
          nameRow.appendChild(badge);
        }
        userMenuOrg.appendChild(nameRow);
      }
      if (orgId) {
        const idEl = document.createElement('div');
        idEl.className = 'user-menu-org-id';
        idEl.textContent = orgId;
        userMenuOrg.appendChild(idEl);
      }
    } else {
      userMenuOrg.style.display = 'none';
      userMenuOrg.innerHTML = '';
    }
  }
  if (!signedIn) {
    document.getElementById('userMenu')?.classList.remove('open');
  }
  // Signing in via Salesforce already grants the calendar/Interview__c access
  // that powers "Today's schedule" - there's no separate "connect calendar"
  // step for SF, so this reflects sign-in state rather than a dead button
  // (real gap found via user testing, 2026-07-23: button always read
  // "Connect calendar" even for an already-connected SF account).
  const calConnLabel = document.getElementById('calConnLabel');
  const calConnDot = document.getElementById('calConnDot');
  if (calConnLabel && calConnDot) {
    calConnLabel.textContent = signedIn ? 'Salesforce · Connected' : 'Connect calendar';
    calConnDot.classList.toggle('is-connected', signedIn);
  }
  if (!signedIn) {
    document.getElementById('calConnMenu')?.classList.remove('open');
  }
}

// Click-to-toggle dropdown on the signed-in avatar (Sign out is the only
// action today - a real settings entry point doesn't exist yet, so this
// menu isn't wired to one; that's future work, not dropped scope).
document.getElementById('userAvatar')?.addEventListener('click', (event) => {
  event.stopPropagation();
  document.getElementById('userMenu')?.classList.toggle('open');
});

document.getElementById('signOutBtn')?.addEventListener('click', async () => {
  document.getElementById('userMenu')?.classList.remove('open');
  await window.electronAPI.signOut();
  await refreshAuthUi();
});

// Calendar-connection dropdown (only Salesforce is real today - Google/
// Outlook rows are disabled placeholders for TODOS.md #21's future
// multi-calendar work, shown so the plan is visible rather than hidden).
document.getElementById('calConnTrigger')?.addEventListener('click', (event) => {
  event.stopPropagation();
  document.getElementById('calConnMenu')?.classList.toggle('open');
});

document.addEventListener('click', (event) => {
  const wrapper = document.getElementById('userMenuWrapper');
  if (wrapper && !wrapper.contains(event.target)) {
    document.getElementById('userMenu')?.classList.remove('open');
  }
  const calConnWrapper = document.getElementById('calConnWrapper');
  if (calConnWrapper && !calConnWrapper.contains(event.target)) {
    document.getElementById('calConnMenu')?.classList.remove('open');
  }
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    document.getElementById('userMenu')?.classList.remove('open');
    document.getElementById('calConnMenu')?.classList.remove('open');
  }
});

// Pushed by the main process whenever tokens change (sign-in callback,
// sign-out) - decoupled from whether a startLogin() promise is still
// pending, which is what left the UI stuck signed-out before this fix.
window.electronAPI.onAuthStatusChanged?.(() => {
  refreshAuthUi();
});

// Screen 01: tray's "Start an unscheduled call" reuses the exact same
// createNewMeeting() the in-app "Record In-person Meeting" button already
// calls (renderer.js:1871), rather than main.js duplicating that note-
// creation logic - createNewMeeting is only defined in this file.
window.electronAPI.onTriggerNewNote?.(() => {
  createNewMeeting();
});

// Group past meetings by date
let pastMeetingsByDate = {};

// Global recording state variables
window.isRecording = false;
window.currentRecordingId = null;


// Function to check if there's an active recording for the current note
async function checkActiveRecordingState() {
  if (!currentEditingMeetingId) return;

  try {
    console.log('Checking active recording state for note:', currentEditingMeetingId);
    const result = await window.electronAPI.getActiveRecordingId(currentEditingMeetingId);

    if (result.success && result.data) {
      console.log('Found active recording for current note:', result.data);
      updateRecordingButtonUI(true, result.data.recordingId);
    } else {
      console.log('No active recording found for note');
      updateRecordingButtonUI(false, null);
    }
  } catch (error) {
    console.error('Error checking recording state:', error);
  }
}

// Function to update the recording button UI
function updateRecordingButtonUI(isActive, recordingId) {
  const recordButton = document.getElementById('recordButton');
  if (!recordButton) return;

  // Get the elements inside the button
  const recordIcon = recordButton.querySelector('.record-icon');
  const stopIcon = recordButton.querySelector('.stop-icon');

  if (isActive) {
    // Recording is active
    console.log('Updating UI for active recording:', recordingId);
    window.isRecording = true;
    window.currentRecordingId = recordingId;

    // Update button UI
    recordButton.classList.add('recording');
    recordIcon.style.display = 'none';
    stopIcon.style.display = 'block';
  } else {
    // No active recording
    console.log('Updating UI for inactive recording');
    window.isRecording = false;
    window.currentRecordingId = null;

    // Update button UI
    recordButton.classList.remove('recording');
    recordIcon.style.display = 'block';
    stopIcon.style.display = 'none';
  }
}

// Function to format date for section headers
function formatDateHeader(dateString) {
  const date = new Date(dateString);
  const now = new Date();
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);

  // Check if date is today, yesterday, or earlier
  if (date.toDateString() === now.toDateString()) {
    return 'Today';
  } else if (date.toDateString() === yesterday.toDateString()) {
    return 'Yesterday';
  } else {
    // Format as "Fri, Apr 25" or similar
    const options = { weekday: 'short', month: 'short', day: 'numeric' };
    return date.toLocaleDateString('en-US', options);
  }
}

// We'll initialize pastMeetings and pastMeetingsByDate when we load data from file

// Save meetings data back to file
async function saveMeetingsData() {
  // Save to localStorage as a backup
  localStorage.setItem('meetingsData', JSON.stringify(meetingsData));

  // Save to the actual file using IPC
  try {
    console.log('Saving meetings data to file...');
    const result = await window.electronAPI.saveMeetingsData(meetingsData);
    if (result.success) {
      console.log('Meetings data saved successfully to file');
    } else {
      console.error('Failed to save meetings data to file:', result.error);
    }
  } catch (error) {
    console.error('Error saving meetings data to file:', error);
  }
}

// Keep track of which meeting is being edited
let currentEditingMeetingId = null;

// Function to save the current note
async function saveCurrentNote() {
  const editorElement = document.getElementById('simple-editor');
  const noteTitleElement = document.getElementById('noteTitle');

  // Early exit if elements aren't available
  if (!editorElement || !noteTitleElement) {
    console.warn('Cannot save note: Editor elements not found');
    return;
  }

  // Early exit if no current meeting ID
  if (!currentEditingMeetingId) {
    console.warn('Cannot save note: No active meeting ID');
    return;
  }

  // Get title text, defaulting to "New Note" if empty
  const noteTitle = noteTitleElement.textContent.trim() || 'New Note';

  // Set title back to element in case it was empty
  if (!noteTitleElement.textContent.trim()) {
    noteTitleElement.textContent = noteTitle;
  }

  // Find which meeting is currently active by ID
  const activeMeeting = [...upcomingMeetings, ...pastMeetings].find(m => m.id === currentEditingMeetingId);

  if (activeMeeting) {
    console.log(`Saving note with ID: ${currentEditingMeetingId}, Title: ${noteTitle}`);

    // Get the current content from the editor
    const content = editorElement.value;
    console.log(`Note content length: ${content.length} characters`);

    // Update the title and content in the meeting object
    activeMeeting.title = noteTitle;
    activeMeeting.content = content;

    // Update the data arrays directly to make sure they stay in sync
    const pastIndex = meetingsData.pastMeetings.findIndex(m => m.id === currentEditingMeetingId);
    if (pastIndex !== -1) {
      meetingsData.pastMeetings[pastIndex].title = noteTitle;
      meetingsData.pastMeetings[pastIndex].content = content;
      console.log('Updated meeting in pastMeetings array');
    }

    const upcomingIndex = meetingsData.upcomingMeetings.findIndex(m => m.id === currentEditingMeetingId);
    if (upcomingIndex !== -1) {
      meetingsData.upcomingMeetings[upcomingIndex].title = noteTitle;
      meetingsData.upcomingMeetings[upcomingIndex].content = content;
      console.log('Updated meeting in upcomingMeetings array');
    }

    // Also update the subtitle if it's a date-based one
    const dateObj = new Date(activeMeeting.date);
    if (dateObj) {
      document.getElementById('noteDate').textContent = formatDate(dateObj);
    }

    try {
      // Save the data to file
      await saveMeetingsData();
      console.log('Note saved successfully:', noteTitle);
    } catch (error) {
      console.error('Error saving note:', error);
    }
  } else {
    console.error(`Cannot save note: Meeting not found with ID: ${currentEditingMeetingId}`);

    // Log all available meetings for debugging
    console.log('Available meeting IDs:', [...upcomingMeetings, ...pastMeetings].map(m => m.id).join(', '));
  }
}

// Format date for display in the note header
function formatDate(date) {
  const options = { month: 'short', day: 'numeric' };
  return date.toLocaleDateString('en-US', options);
}

// Simple debounce function
function debounce(func, wait) {
  let timeout;
  return function(...args) {
    const context = this;
    clearTimeout(timeout);
    timeout = setTimeout(() => func.apply(context, args), wait);
  };
}



// Function to create meeting card elements
// Screen 02 (Home/Today §2.5) "Recent captures" meta line - "58m · Today
// 11:00 AM" for today/yesterday (matches design), "45m · Fri, Apr 25"
// further back. Real duration_s (persisted on finalize), not fabricated.
function homeRecentMeta(meeting) {
  const durText = typeof meeting.duration_s === 'number' ? `${Math.round(meeting.duration_s / 60)}m · ` : '';
  const dateLabel = formatDateHeader(meeting.date);
  const timeText = dateLabel === 'Today' || dateLabel === 'Yesterday'
    ? ` ${new Date(meeting.date).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', hour12: true })}`
    : '';
  return `${durText}${dateLabel}${timeText}`;
}

function createMeetingCard(meeting) {
  const card = document.createElement('div');
  card.className = 'meeting-card';
  card.dataset.id = meeting.id;

  const titleHtml = meeting.hasDemo
    ? `<a class="meeting-demo-link">${meeting.title}</a>`
    : meeting.title;

  // Screen 02 (Home/Today §2.5) sync-state chip - real duration_s (persisted
  // on finalize) and real pending-sync state (notes-sync.js), same source
  // this card already renders from, not a second data path.
  const isPending = homePendingSyncIds.includes(meeting.id);
  const syncChipHtml = isPending
    ? '<span class="home-chip tone-amber">Local</span>'
    : '<span class="home-chip tone-green">Synced</span>';

  // meeting.title is externally-influenced (calendar/window-title data) -
  // sanitize the same way every other innerHTML assignment in this file
  // does (markdown preview, transcript, home lists). Real gap found via
  // code review, 2026-07-23: this was the one innerHTML site missing it.
  card.innerHTML = DOMPurify.sanitize(`
    <div class="home-avatar">${homeInitials(meeting.title)}</div>
    <div class="meeting-content">
      <span class="meeting-title">${titleHtml}</span>
      <span class="meeting-time">${homeRecentMeta(meeting)}</span>
    </div>
    ${syncChipHtml}
    <div class="meeting-actions">
      <button class="delete-meeting-btn" data-id="${meeting.id}" title="Delete note">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z" fill="currentColor"/>
        </svg>
      </button>
    </div>
  `);

  return card;
}

// Function to show home view
function showHomeView() {
  closePostCallView();
  document.getElementById('homeView').style.display = 'block';
  document.getElementById('editorView').style.display = 'none';
  document.getElementById('backButton').style.display = 'none';
  document.getElementById('newNoteBtn').style.display = 'block';
  document.getElementById('toggleSidebar').style.display = 'none';
  if (typeof refreshHomeDashboard === 'function') {
    refreshHomeDashboard();
  }

  // Show Record Meeting button and set its state based on meeting detection.
  // Screen 02 pixel-fidelity pass: design's header shows exactly one CTA
  // ("New capture") when idle - "Record Meeting" only appears once a
  // meeting is actually detected, rather than always showing (disabled).
  const joinMeetingBtn = document.getElementById('joinMeetingBtn');
  if (joinMeetingBtn) {
    joinMeetingBtn.style.display = window.meetingDetected ? 'block' : 'none';
    joinMeetingBtn.innerHTML = `Record ${window.meetingPlatform || "Meeting"}`;

    // Enable/disable based on meeting detection AND sign-in state - matches
    // refreshAuthUi()/onMeetingDetectionStatus's gating (real gap found via
    // review: this path ignored isSignedIn, so navigating home while signed
    // out with a meeting still detected re-enabled the button in the UI,
    // even though main.js's join handler still refuses the actual join).
    joinMeetingBtn.disabled = !window.meetingDetected || !window.isSignedIn;
  }
}

// Function to show editor view
function showEditorView(meetingId, { forceClassicEditor = false } = {}) {
  console.log(`Showing editor view for meeting ID: ${meetingId}`);

  // Find the meeting in either upcoming or past meetings
  let meeting = [...upcomingMeetings, ...pastMeetings].find(m => m.id === meetingId);

  if (!meeting) {
    console.error(`Meeting not found: ${meetingId}`);
    return;
  }

  // Screen 08 — finished captures open post-call (summary + link flyout)
  if (!forceClassicEditor && shouldOpenPostCall(meeting)) {
    closePostCallView();
    document.getElementById('homeView').style.display = 'none';
    document.getElementById('editorView').style.display = 'none';
    document.getElementById('backButton').style.display = 'block';
    document.getElementById('newNoteBtn').style.display = 'none';
    document.getElementById('toggleSidebar').style.display = 'none';
    const joinMeetingBtn = document.getElementById('joinMeetingBtn');
    if (joinMeetingBtn) joinMeetingBtn.style.display = 'none';
    currentEditingMeetingId = meetingId;
    openPostCallView(meeting);
    return;
  }

  closePostCallView();
  // Make the views visible/hidden
  document.getElementById('homeView').style.display = 'none';
  document.getElementById('editorView').style.display = 'block';
  document.getElementById('backButton').style.display = 'block';
  document.getElementById('newNoteBtn').style.display = 'none';
  document.getElementById('toggleSidebar').style.display = 'none'; // Hide the sidebar toggle

  // Always hide the join meeting button when in editor view
  const joinMeetingBtn = document.getElementById('joinMeetingBtn');
  if (joinMeetingBtn) {
    joinMeetingBtn.style.display = 'none';
  }

  // Set the current editing meeting ID
  currentEditingMeetingId = meetingId;
  console.log(`Now editing meeting: ${meetingId} - ${meeting.title}`);



  // Set the meeting title
  document.getElementById('noteTitle').textContent = meeting.title;

  // Set the date display
  const dateObj = new Date(meeting.date);
  document.getElementById('noteDate').textContent = formatDate(dateObj);

  // Reset the live transcript panel to hidden per note switch, and load
  // whatever transcript this meeting already has (if the panel gets opened)
  const liveTranscriptPanel = document.getElementById('liveTranscriptPanel');
  if (liveTranscriptPanel) {
    liveTranscriptPanel.classList.add('hidden');
  }
  renderLiveTranscript(meeting.transcript);

  // Get the editor element
  const editorElement = document.getElementById('simple-editor');

  // Important: Reset the editor content completely
  if (editorElement) {
    editorElement.value = '';
    syncEditorPreview('');
  }

  // Add a small delay to ensure the DOM has updated before setting content
  setTimeout(() => {
    if (meeting.content) {
      editorElement.value = meeting.content;
      syncEditorPreview(meeting.content);
      console.log(`Loaded content for meeting: ${meetingId}, length: ${meeting.content.length} characters`);
    } else {
      // If content is missing, create template
      const now = new Date();
      const template = `# Meeting Title\n• ${meeting.title}\n\n# Meeting Date and Time\n• ${now.toLocaleString()}\n\n# Participants\n• \n\n# Description\n• \n\nChat with meeting transcript: `;
      editorElement.value = template;
      syncEditorPreview(template);

      // Save this template to the meeting
      meeting.content = template;
      saveMeetingsData();
      console.log(`Created new template for meeting: ${meetingId}`);
    }

    // Set up auto-save handler for this specific note
    setupAutoSaveHandler();

    // Add event listener to the title
    setupTitleEditing();

    // Check if this note has an active recording and update the record button
    checkActiveRecordingState();

    // Update debug panel with any available data if it's open
    const debugPanel = document.getElementById('debugPanel');
    if (debugPanel && !debugPanel.classList.contains('hidden')) {
      // Update transcript if available
      if (meeting.transcript && meeting.transcript.length > 0) {
        updateDebugTranscript(meeting.transcript);
      } else {
        // Clear transcript area if no transcript
        const transcriptContent = document.getElementById('transcriptContent');
        if (transcriptContent) {
          transcriptContent.innerHTML = `
            <div class="placeholder-content">
              <p>No transcript available yet</p>
            </div>
          `;
        }
      }

      // Update participants if available
      if (meeting.participants && meeting.participants.length > 0) {
        updateDebugParticipants(meeting.participants);
      } else {
        // Clear participants area if no participants
        const participantsContent = document.getElementById('participantsContent');
        if (participantsContent) {
          participantsContent.innerHTML = `
            <div class="placeholder-content">
              <p>No participants detected yet</p>
            </div>
          `;
        }
      }

      // Reset video preview when changing notes
      const videoContent = document.getElementById('videoContent');
      if (videoContent) {
        videoContent.innerHTML = `
          <div class="placeholder-content video-placeholder">
            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M17 10.5V7c0-.55-.45-1-1-1H4c-.55 0-1 .45-1 1v10c0 .55.45 1 1 1h12c.55 0 1-.45 1-1v-3.5l4 4v-11l-4 4z" fill="#999"/>
            </svg>
            <p>Video preview will appear here</p>
          </div>
        `;
      }
    }
  }, 50);
}

// Setup the title editing and save function
function setupTitleEditing() {
  const titleElement = document.getElementById('noteTitle');

  // Remove existing event listeners if any
  titleElement.removeEventListener('blur', titleBlurHandler);
  titleElement.removeEventListener('keydown', titleKeydownHandler);

  // Add event listeners
  titleElement.addEventListener('blur', titleBlurHandler);
  titleElement.addEventListener('keydown', titleKeydownHandler);
}

// Event handler for title blur
async function titleBlurHandler() {
  await saveCurrentNote();
}

// Event handler for title keydown
function titleKeydownHandler(e) {
  if (e.key === 'Enter') {
    e.preventDefault(); // Prevent new line
    e.target.blur(); // Remove focus to trigger save
  }
}

// Create a single reference to the auto-save handler to ensure we can remove it properly
let currentAutoSaveHandler = null;


// Function to set up auto-save handler
function setupAutoSaveHandler() {
  // Create a debounced auto-save handler
  const autoSaveHandler = debounce(async () => {
    console.log('Auto-saving note due to content change');
    if (currentEditingMeetingId) {
      console.log(`Auto-save triggered for meeting: ${currentEditingMeetingId}`);
      await saveCurrentNote();
    } else {
      console.warn('Cannot auto-save: No active meeting ID');
    }
  }, 1000);

  // First remove any existing handler
  if (currentAutoSaveHandler) {
    const editorElement = document.getElementById('simple-editor');
    if (editorElement) {
      console.log('Removing existing auto-save handler');
      editorElement.removeEventListener('input', currentAutoSaveHandler);
    }
  }

  // Store the reference for future cleanup
  currentAutoSaveHandler = autoSaveHandler;

  // Get the editor element and attach the new handler
  const editorElement = document.getElementById('simple-editor');
  if (editorElement) {
    editorElement.addEventListener('input', autoSaveHandler);
    console.log(`Set up editor auto-save handler for meeting: ${currentEditingMeetingId || 'none'}`);

    // Manually trigger a save once to ensure the content is saved
    setTimeout(() => {
      console.log('Triggering initial save after setup');
      editorElement.dispatchEvent(new Event('input'));
    }, 500);
  } else {
    console.warn('Editor element not found for auto-save setup');
  }
}

// Function to create a new meeting
async function createNewMeeting() {
  console.log('Creating new note...');

  // Save any existing note before creating a new one
  if (currentEditingMeetingId) {
    await saveCurrentNote();
    console.log('Saved current note before creating new one');
  }

  // Reset the current editing ID to ensure we start fresh
  currentEditingMeetingId = null;

  // Generate a unique ID
  const id = 'meeting-' + Date.now();
  console.log('Generated new meeting ID:', id);

  // Current date and time
  const now = new Date();

  // Generate the template for the content
  const template = `# Meeting Title\n• New Note\n\n# Meeting Date and Time\n• ${now.toLocaleString()}\n\n# Participants\n• \n\n# Description\n• \n\nChat with meeting transcript: `;

  // Create a new meeting object - ensure it's of type document
  const newMeeting = {
    id: id,
    type: 'document', // Explicitly set as document type, not calendar
    title: 'New Note',
    subtitle: now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    hasDemo: false,
    date: now.toISOString(),
    participants: [],
    content: template // Set the content directly
  };

  // Log what we're adding
  console.log(`Adding new meeting: id=${id}, title=${newMeeting.title}, content.length=${template.length}`);

  // Add to pastMeetings - make sure to push to both arrays
  pastMeetings.unshift(newMeeting);
  meetingsData.pastMeetings.unshift(newMeeting);

  // Update the grouped meetings
  const dateKey = formatDateHeader(newMeeting.date);
  if (!pastMeetingsByDate[dateKey]) {
    pastMeetingsByDate[dateKey] = [];
  }
  pastMeetingsByDate[dateKey].unshift(newMeeting);

  // Save the data to file
  try {
    await saveMeetingsData();
    console.log('New meeting created and saved:', newMeeting.title);
  } catch (error) {
    console.error('Error saving new meeting:', error);
  }

  // Set current editing ID to the new meeting ID BEFORE showing the editor
  currentEditingMeetingId = id;
  console.log('Set currentEditingMeetingId to:', id);

  // Force a reset of the editor before showing the new meeting
  const editorElement = document.getElementById('simple-editor');
  if (editorElement) {
    editorElement.value = '';
    syncEditorPreview('');
  }

  // Now show the editor view with the new meeting
  showEditorView(id);

  // Automatically start recording for the new note
  try {
    console.log('Auto-starting recording for new note');
    // Start manual recording for the new note
    window.electronAPI.startManualRecording(id)
      .then(result => {
        if (result.success) {
          console.log('Auto-started recording for new note with ID:', result.recordingId);
          // Update recording button UI
          window.isRecording = true;
          window.currentRecordingId = result.recordingId;

          // Update recording button UI
          const recordButton = document.getElementById('recordButton');
          if (recordButton) {
            const recordIcon = recordButton.querySelector('.record-icon');
            const stopIcon = recordButton.querySelector('.stop-icon');

            recordButton.classList.add('recording');
            recordIcon.style.display = 'none';
            stopIcon.style.display = 'block';
          }
        } else {
          console.error('Failed to auto-start recording:', result.error);
        }
      })
      .catch(error => {
        console.error('Error auto-starting recording:', error);
      });
  } catch (error) {
    console.error('Exception auto-starting recording:', error);
  }

  return id;
}

// Populate the notes list container with meeting cards, optionally filtered by a
// case-insensitive substring match against meeting.title
function renderNotesInto(notesContainer, query) {
  notesContainer.innerHTML = '';

  // Add all meetings to the notes section (both upcoming and past)
  const allMeetings = [...upcomingMeetings, ...pastMeetings];

  // Sort by date, newest first
  allMeetings.sort((a, b) => {
    return new Date(b.date) - new Date(a.date);
  });

  const normalizedQuery = (query || '').trim().toLowerCase();

  // Filter out calendar entries and add only document type meetings to the container
  allMeetings
    .filter(meeting => meeting.type !== 'calendar') // Skip calendar entries
    .filter(meeting => !normalizedQuery || (meeting.title || '').toLowerCase().includes(normalizedQuery))
    .forEach(meeting => {
      notesContainer.appendChild(createMeetingCard(meeting));
    });
}

// Function to render meetings to the page
function renderMeetings() {
  // Clear previous content
  const mainContent = document.querySelector('.main-content .content-container');
  mainContent.innerHTML = '';

  // Create all notes section (replaces both upcoming and date-grouped sections).
  // Heading + "Library →" link: the Library screen (#27) doesn't exist yet,
  // so this list IS the history surface (screen 02 spec §2.5) - no separate
  // "Recent captures" preview duplicating the same data (feedback 2026-07-23:
  // "notes is recent captures").
  const notesSection = document.createElement('section');
  notesSection.className = 'meetings-section';
  notesSection.innerHTML = `
    <div class="home-section-header" style="margin-top: 0;">
      <h2 class="section-title" style="margin-bottom: 0;">Recent captures</h2>
      <div class="home-section-rule"></div>
      <span class="home-section-link" id="homeLibraryLink">Library →</span>
    </div>
    <div class="meetings-list" id="notes-list"></div>
  `;
  mainContent.appendChild(notesSection);

  // Get the notes container
  const notesContainer = notesSection.querySelector('#notes-list');

  renderNotesInto(notesContainer, '');

  // homeLibraryLink is rebuilt by this function on every reload - wire it
  // here rather than once in DOMContentLoaded, since the element itself is
  // recreated each time.
  const libraryLink = notesSection.querySelector('#homeLibraryLink');
  if (libraryLink) {
    libraryLink.addEventListener('click', () => {
      notesSection.scrollIntoView({ behavior: 'smooth' });
    });
  }
}

// Load meetings data from file
async function loadMeetingsDataFromFile() {
  console.log("Loading meetings data from file...");
  try {
    const result = await window.electronAPI.loadMeetingsData();
    console.log("Load result success:", result.success);

    if (result.success) {
      console.log(`Got data with ${result.data.pastMeetings?.length || 0} past meetings`);
      if (result.data.pastMeetings && result.data.pastMeetings.length > 0) {
        console.log("Most recent meeting:", result.data.pastMeetings[0].id, result.data.pastMeetings[0].title);
      }

      // Initialize arrays if they don't exist in the loaded data
      if (!result.data.upcomingMeetings) {
        result.data.upcomingMeetings = [];
      }

      if (!result.data.pastMeetings) {
        result.data.pastMeetings = [];
      }

      // Update the meetings data objects
      Object.assign(meetingsData, result.data);

      // Clear and reassign the references
      upcomingMeetings.length = 0;
      pastMeetings.length = 0;

      console.log("Before updating arrays, pastMeetings count:", pastMeetings.length);

      // Filter out calendar entries when loading data
      meetingsData.upcomingMeetings
        .filter(meeting => meeting.type !== 'calendar')
        .forEach(meeting => upcomingMeetings.push(meeting));

      meetingsData.pastMeetings
        .filter(meeting => meeting.type !== 'calendar')
        .forEach(meeting => pastMeetings.push(meeting));

      console.log("After updating arrays, pastMeetings count:", pastMeetings.length);
      if (pastMeetings.length > 0) {
        console.log("First past meeting:", pastMeetings[0].id, pastMeetings[0].title);
      }

      // Regroup past meetings by date
      pastMeetingsByDate = {};
      meetingsData.pastMeetings.forEach(meeting => {
        const dateKey = formatDateHeader(meeting.date);
        if (!pastMeetingsByDate[dateKey]) {
          pastMeetingsByDate[dateKey] = [];
        }
        pastMeetingsByDate[dateKey].push(meeting);
      });

      console.log('Meetings data loaded from file');

      // Re-render the meetings (refreshHomeDashboard also calls
      // renderMeetings(), so its sync-state chips use fresh pending-sync data)
      refreshHomeDashboard();
    } else {
      console.error('Failed to load meetings data from file:', result.error);
    }
  } catch (error) {
    console.error('Error loading meetings data from file:', error);
  }
}

// ---------------------------------------------------------------------------
// Screen 02/02b - Home/Today dashboard (docs/screen-specs/02-home-today.md).
// State + render functions. Data sources, per §12 of the spec: today's
// schedule is real (SF Event via today-schedule-updated IPC), recent
// captures/stats are real (local meetingsData), needs-attention is real for
// only 2 of 5 queue types (waiting-to-sync, speaker-labels - the other 3 have
// no backing data source anywhere in this app yet), connection status is
// real (auth + mic permission; calendar is honestly never "connected").
// ---------------------------------------------------------------------------
let homeTodaySchedule = [];
let homeLiveRecording = null; // { noteId, recordingId, startedAt, title } | null
let homePendingSyncIds = [];
let homeTickInterval = null;

function homeInitials(name) {
  if (!name) return '?';
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] || '') + (parts[1]?.[0] || '')).toUpperCase() || '?';
}

function homeFormatTime(iso) {
  // Explicit hour12 - this app launches with --lang=en-GB, whose default
  // toLocaleTimeString format is 24-hour ("14:30"), not the design's 12-hour
  // "2:30 PM".
  return new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', hour12: true });
}

function homeMinutesUntil(iso) {
  return Math.round((new Date(iso).getTime() - Date.now()) / 60000);
}

function renderHomeGreeting() {
  const dateEl = document.getElementById('homeDate');
  const greetEl = document.getElementById('homeGreeting');
  if (!dateEl || !greetEl) return;

  const now = new Date();
  // Explicit "Weekday, Month Day" (design: "Tuesday, July 22") rather than
  // toLocaleDateString's locale-dependent field order (en-GB, this app's
  // launch locale, renders "Thursday, 23 July" instead).
  const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  dateEl.textContent = `${WEEKDAYS[now.getDay()]}, ${MONTHS[now.getMonth()]} ${now.getDate()}`;

  const hour = now.getHours();
  const timeGreeting = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
  const name = window.currentUserEmail ? window.currentUserEmail.split('@')[0] : 'there';
  const count = homeTodaySchedule.length;
  greetEl.textContent = count === 0
    ? `${timeGreeting}, ${name}. Nothing scheduled — capture an unscheduled call anytime.`
    : `${timeGreeting}, ${name}. ${count} conversation${count === 1 ? '' : 's'} today.`;
}

// Up-next hero (spec §2.3) + Today's schedule list (spec §2.4). Capture-mode
// pill always reads "You capture" - the capture-policy pre-check service
// that would distinguish "Bot joins"/"Both" doesn't exist in this build.
function renderHomeSchedule() {
  const heroEl = document.getElementById('homeHero');
  const emptyEl = document.getElementById('homeEmptySchedule');
  const listEl = document.getElementById('homeScheduleList');
  if (!heroEl || !emptyEl || !listEl) return;

  renderHomeGreeting();

  emptyEl.style.display = homeTodaySchedule.length === 0 ? 'flex' : 'none';

  const next = homeTodaySchedule[0];
  const nextMins = next ? homeMinutesUntil(next.startTime) : null;
  // Hero collapses while a recording is live (spec §3 - "you're in the
  // meeting"), and only shows for a next meeting under 2h away.
  if (!homeLiveRecording && next && nextMins >= 0 && nextMins < 120) {
    heroEl.style.display = 'block';
    document.getElementById('homeHeroKicker').textContent = `Up next · in ${nextMins} min`;
    document.getElementById('homeHeroAvatar').textContent = homeInitials(next.whoName || next.subject);
    document.getElementById('homeHeroTitle').textContent = next.subject;
    document.getElementById('homeHeroSub').textContent =
      [next.whoName, homeFormatTime(next.startTime), next.location].filter(Boolean).join(' · ');
  } else {
    heroEl.style.display = 'none';
  }

  listEl.innerHTML = DOMPurify.sanitize(homeTodaySchedule.map((evt) => {
    const mins = homeMinutesUntil(evt.startTime);
    const isLiveRow = homeLiveRecording && mins <= 0 && mins > -180;
    const isCurrent = !homeLiveRecording && mins <= 0 && mins > -60;
    const timeCell = isLiveRow
      ? `<span class="home-schedule-live"><span class="recall-pulse"></span>LIVE</span>`
      : `<span class="home-schedule-time${isCurrent ? ' is-current' : ''}">${homeFormatTime(evt.startTime)}</span>`;
    return `
      <div class="home-schedule-row">
        ${timeCell}
        <div class="home-avatar">${homeInitials(evt.whoName || evt.subject)}</div>
        <div class="home-schedule-meta">
          <div class="home-schedule-title">${evt.subject || 'Untitled event'}</div>
          <div class="home-schedule-sub">${evt.whoName || 'No linked record'}</div>
        </div>
        <span class="home-schedule-dur">${evt.location || ''}</span>
        <span class="home-mode-pill">You capture</span>
      </div>
    `;
  }).join(''));
}

// Needs attention (spec §2.6) - only 2 of 5 queue types have a real data
// source in this build (see file header comment + TODOS.md #11).
const HOME_ATTENTION_ICONS = {
  // upload (waiting to sync)
  amber: '<svg width="13" height="13" viewBox="0 0 16 16" fill="none"><path d="M8 11V3M8 3L4.5 6.5M8 3l3.5 3.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><path d="M2.5 11v1.5A1.5 1.5 0 0 0 4 14h8a1.5 1.5 0 0 0 1.5-1.5V11" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
  // users (speakers need labels)
  blue: '<svg width="13" height="13" viewBox="0 0 16 16" fill="none"><circle cx="5.5" cy="5" r="2" stroke="currentColor" stroke-width="1.4"/><circle cx="11" cy="5.5" r="1.6" stroke="currentColor" stroke-width="1.3"/><path d="M1.8 13c0-2.2 1.7-3.8 3.7-3.8s3.7 1.6 3.7 3.8M9.6 9.8c1.7.2 2.9 1.6 2.9 3.3" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>',
};

// Needs attention (spec §2.6) - only 2 of 5 queue types have a real data
// source in this build (see file header comment + TODOS.md #11). Each item
// has a real click action, not a static row: retry sync now, or open the
// note to review/relabel speakers.
function renderHomeAttention() {
  const listEl = document.getElementById('homeAttentionList');
  if (!listEl) return;

  const items = [];
  if (homePendingSyncIds.length > 0) {
    const first = pastMeetings.find((m) => m.id === homePendingSyncIds[0]);
    items.push({
      tone: 'amber',
      title: homePendingSyncIds.length === 1 ? '1 capture waiting to sync' : `${homePendingSyncIds.length} captures waiting to sync`,
      sub: first ? `${first.title} · stored locally · click to retry` : 'Stored locally · click to retry',
      action: 'retry-sync',
      meetingId: homePendingSyncIds[0],
    });
  }
  const needsLabels = pastMeetings.filter((m) =>
    (m.transcript || []).some((t) => t.speaker === 'Unknown Speaker' || /^Speaker \d+$/.test(t.speaker || ''))
  );
  if (needsLabels.length > 0) {
    items.push({
      tone: 'blue',
      title: needsLabels.length === 1 ? 'Speakers need labels' : `${needsLabels.length} calls need speaker labels`,
      sub: `${needsLabels[0].title} · click to review`,
      action: 'open-note',
      meetingId: needsLabels[0].id,
    });
  }

  if (items.length === 0) {
    listEl.innerHTML = `
      <div class="home-all-clear">
        <strong>All clear.</strong>&nbsp;Nothing needs your attention right now.
      </div>
    `;
    return;
  }

  const toneBg = { amber: 'var(--brand-tint-yellow)', blue: 'var(--brand-tint-blue)' };
  const toneFg = { amber: '#a36d00', blue: '#0273c4' };
  listEl.innerHTML = DOMPurify.sanitize(items.map((item) => `
    <div class="home-attention-item" data-action="${item.action}" data-meeting-id="${item.meetingId}">
      <div class="home-attention-icon" style="background:${toneBg[item.tone]};color:${toneFg[item.tone]}">${HOME_ATTENTION_ICONS[item.tone]}</div>
      <div style="flex: 1; min-width: 0;">
        <div class="home-attention-title">${item.title}</div>
        <div class="home-attention-sub">${item.sub}</div>
      </div>
      <svg width="12" height="12" viewBox="0 0 16 16" fill="none" style="flex-shrink: 0;"><path d="M6 3l5 5-5 5" stroke="var(--brand-gray)" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>
    </div>
  `).join(''));

  listEl.querySelectorAll('.home-attention-item').forEach((row) => {
    row.addEventListener('click', async () => {
      const { action, meetingId } = row.dataset;
      if (action === 'open-note') {
        showEditorView(meetingId);
      } else if (action === 'retry-sync') {
        row.style.opacity = '0.6';
        await window.electronAPI.retryNoteSync(meetingId);
        refreshHomeDashboard();
      }
    });
  });
}

// This week (spec §2.7) - captures + hours are real (local data); synced-to-SF
// and signals-extracted are honestly unavailable (no tracking exists yet),
// not fabricated numbers.
function renderHomeStats() {
  const gridEl = document.getElementById('homeStatsGrid');
  if (!gridEl) return;

  const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const thisWeek = pastMeetings.filter((m) => new Date(m.date).getTime() >= weekAgo);
  const totalSeconds = thisWeek.reduce((sum, m) => sum + (typeof m.duration_s === 'number' ? m.duration_s : 0), 0);

  const stats = [
    { n: String(thisWeek.length), l: 'captures' },
    { n: `${(totalSeconds / 3600).toFixed(1)}h`, l: 'recorded' },
    { n: '—', l: 'synced to SF' },
    { n: '—', l: 'signals extracted' },
  ];

  gridEl.innerHTML = stats.map((s) => `
    <div class="home-stat-card">
      <div class="home-stat-num">${s.n}</div>
      <div class="home-stat-label">${s.l}</div>
    </div>
  `).join('');
}

// Connection status (spec §2.8) - real SF-token + mic-permission checks.
// Calendar is never "connected" (no Google/Outlook integration exists -
// TODOS.md #13) - this correctly shows the degraded state per spec §4.2,
// not a bug.
async function renderHomeConnection() {
  const cardEl = document.getElementById('homeConnectionCard');
  if (!cardEl) return;

  const micStatus = await window.electronAPI.getMicPermissionStatus();
  const micOk = micStatus === 'granted';

  if (!window.isSignedIn) {
    cardEl.className = 'home-connection-card is-degraded';
    cardEl.innerHTML = '<strong>Reconnect Salesforce.</strong>&nbsp;Captures keep working and will sync when you\'re back.';
  } else if (!micOk) {
    cardEl.className = 'home-connection-card is-degraded';
    cardEl.innerHTML = '<strong>Microphone access needed.</strong>&nbsp;Grant mic permission in System Settings to capture audio.';
  } else {
    cardEl.className = 'home-connection-card';
    // The empty-card's calendar-connection dropdown (#calConnMenu) now
    // covers this same caveat clearly (Salesforce connected, Google/Outlook
    // coming soon) - repeating it here read as a contradiction once that
    // shipped ("Salesforce connected" right next to "calendar isn't
    // connected"), found via user testing 2026-07-23.
    cardEl.innerHTML = '<strong>Salesforce and mic connected.</strong>&nbsp;Nothing to do here.';
  }
}

// 02b live-recording strip (spec §3).
function renderHomeLiveStrip() {
  const stripEl = document.getElementById('homeLiveStrip');
  if (!stripEl) return;

  stripEl.style.display = homeLiveRecording ? 'flex' : 'none';
  if (homeLiveRecording) {
    document.getElementById('homeLiveTitle').textContent = homeLiveRecording.title;
    const meeting = pastMeetings.find((m) => m.id === homeLiveRecording.noteId);
    document.getElementById('homeLiveSub').textContent = meeting?.participants?.length
      ? `${meeting.participants.length} participants · capturing`
      : 'capturing';
  }
}

function homeTickLiveTimer() {
  if (!homeLiveRecording) return;
  const elapsed = Math.max(0, Math.round((Date.now() - homeLiveRecording.startedAt) / 1000));
  const mm = String(Math.floor(elapsed / 60)).padStart(2, '0');
  const ss = String(elapsed % 60).padStart(2, '0');
  const timerEl = document.getElementById('homeLiveTimer');
  if (timerEl) timerEl.textContent = `${mm}:${ss}`;
}

function renderHomeDashboard() {
  renderHomeSchedule();
  renderHomeAttention();
  renderHomeStats();
  renderHomeConnection();
  renderHomeLiveStrip();
}

// Refreshes homePendingSyncIds (the one piece of Home's state not already
// pushed via IPC or loaded with meetingsData) before rendering. Also
// re-renders the notes list so its sync-state chips (createMeetingCard)
// reflect the freshly-fetched pending state, not whatever was cached when
// the list last rendered.
async function refreshHomeDashboard() {
  try {
    homePendingSyncIds = await window.electronAPI.getPendingSyncMeetingIds();
  } catch (error) {
    homePendingSyncIds = [];
  }
  renderMeetings();
  renderHomeDashboard();
}

// Real user-facing live transcript panel (task: give the transcript a
// proper scrollable view instead of the 5-second toast or the dark
// developer-only Debug panel). Same meeting.transcript data as
// updateDebugTranscript, styled for the main app rather than the debug
// panel's dark theme.
function renderLiveTranscript(transcript) {
  const content = document.getElementById('liveTranscriptContent');
  if (!content) return;

  const wasAtBottom = content.scrollTop + content.clientHeight >= content.scrollHeight - 5;

  if (!transcript || transcript.length === 0) {
    content.innerHTML = '<p class="live-transcript-placeholder">No transcript available yet</p>';
    return;
  }

  // Transcript text is speech-recognition output, not user-typed markdown,
  // but still not fully trusted - sanitize before it reaches innerHTML
  // (same reasoning as the markdown preview's DOMPurify usage above).
  content.innerHTML = DOMPurify.sanitize(transcript.map((entry) => {
    const speakerClass = entry.speaker === 'You' ? 'speaker-you'
      : entry.speaker === 'Them' ? 'speaker-them'
      : 'speaker-unknown';
    return `
      <div class="live-transcript-entry">
        <span class="live-transcript-speaker ${speakerClass}">${entry.speaker || 'Unknown Speaker'}:</span>
        <span class="live-transcript-text">${entry.text}</span>
      </div>
    `;
  }).join(''));

  if (wasAtBottom) {
    content.scrollTop = content.scrollHeight;
  }
}

// Function to update the transcript section in the debug panel
function updateDebugTranscript(transcript) {
  const transcriptContent = document.getElementById('transcriptContent');
  if (!transcriptContent) return;

  // Check if user was at bottom before clearing content
  const wasAtBottom = transcriptContent.scrollTop + transcriptContent.clientHeight >= transcriptContent.scrollHeight - 5;

  // Clear previous content
  transcriptContent.innerHTML = '';

  if (!transcript || transcript.length === 0) {
    // Show placeholder if no transcript is available
    transcriptContent.innerHTML = `
      <div class="placeholder-content">
        <p>No transcript available yet</p>
      </div>
    `;
    return;
  }

  // Create transcript entries
  const transcriptDiv = document.createElement('div');
  transcriptDiv.className = 'transcript-entries';

  // Add each transcript entry
  transcript.forEach((entry, index) => {
    const entryDiv = document.createElement('div');
    entryDiv.className = 'transcript-entry';

    // Format timestamp
    const timestamp = new Date(entry.timestamp);
    const formattedTime = timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

    // Distinct color per speaker (T19 spec, docs/PLAN-desktop-redesign.md) -
    // "You" and "Them" are the only two real states on this path (T17:
    // real diarization isn't available), "Unknown Speaker" is the neutral
    // fallback when even is_host isn't present.
    const speakerClass = entry.speaker === 'You' ? 'speaker-you'
      : entry.speaker === 'Them' ? 'speaker-them'
      : 'speaker-unknown';

    // Create HTML for this entry
    entryDiv.innerHTML = `
      <div class="transcript-speaker ${speakerClass}">${entry.speaker || 'Unknown'}</div>
      <div class="transcript-text">${entry.text}</div>
      <div class="transcript-timestamp">${formattedTime}</div>
    `;

    // Add a highlight class for the newest entry
    if (index === transcript.length - 1) {
      entryDiv.classList.add('newest-entry');
    }

    transcriptDiv.appendChild(entryDiv);
  });

  transcriptContent.appendChild(transcriptDiv);

  // Only auto-scroll to bottom if user was at the bottom before the update
  if (wasAtBottom) {
    // Use setTimeout to ensure DOM has updated
    setTimeout(() => {
      transcriptContent.scrollTop = transcriptContent.scrollHeight;
    }, 0);
  }
}

// Function to update the video preview in the debug panel
function updateDebugVideoPreview(frameData) {
  // Get the image data from the frame
  const { buffer, participantId, participantName, frameType } = frameData;

  // Determine if this is a screenshare or participant video
  const isScreenshare = frameType !== 'webcam';

  if (isScreenshare) {
    updateScreensharePreview(frameData);
  } else {
    updateParticipantVideoPreview(frameData);
  }

  // Make sure debug panel toggle shows new content notification if panel is closed
  const debugPanel = document.getElementById('debugPanel');
  if (debugPanel && debugPanel.classList.contains('hidden')) {
    const debugPanelToggle = document.getElementById('debugPanelToggle');
    if (debugPanelToggle && !debugPanelToggle.classList.contains('has-new-content')) {
      debugPanelToggle.classList.add('has-new-content');
    }
  }
}

// Function to update participant video preview
function updateParticipantVideoPreview(frameData) {
  const videoContent = document.getElementById('videoContent');
  if (!videoContent) return;

  const { buffer, participantId, participantName, frameType } = frameData;

  // Check if we already have a container for this participant
  let participantVideoContainer = document.getElementById(`video-participant-${participantId}`);

  // If no container exists, create one
  if (!participantVideoContainer) {
    // Clear the placeholder content if this is the first frame
    if (videoContent.querySelector('.placeholder-content')) {
      videoContent.innerHTML = '';
    }

    // Create a container for this participant's video
    participantVideoContainer = document.createElement('div');
    participantVideoContainer.id = `video-participant-${participantId}`;
    participantVideoContainer.className = 'video-participant-container';

    // Add the name label
    const nameLabel = document.createElement('div');
    nameLabel.className = 'video-participant-name';
    nameLabel.textContent = participantName;
    participantVideoContainer.appendChild(nameLabel);

    // Create an image element for the video frame
    const videoImg = document.createElement('img');
    videoImg.className = 'video-frame';
    videoImg.id = `video-frame-${participantId}`;
    participantVideoContainer.appendChild(videoImg);

    // Add the frame type label
    const typeLabel = document.createElement('div');
    typeLabel.className = 'video-frame-type';
    typeLabel.textContent = 'Camera';
    participantVideoContainer.appendChild(typeLabel);

    // Add to the video content area
    videoContent.appendChild(participantVideoContainer);
  }

  // Update the image with the new frame
  const videoImg = document.getElementById(`video-frame-${participantId}`);
  if (videoImg) {
    videoImg.src = `data:image/png;base64,${buffer}`;
  }
}

// Function to update screenshare preview
function updateScreensharePreview(frameData) {
  const screenshareContent = document.getElementById('screenshareContent');
  if (!screenshareContent) return;

  const { buffer, participantId, participantName, frameType } = frameData;

  // Check if we already have a container for this screenshare
  let screenshareContainer = document.getElementById(`screenshare-participant-${participantId}`);

  // If no container exists, create one
  if (!screenshareContainer) {
    // Clear the placeholder content if this is the first frame
    if (screenshareContent.querySelector('.placeholder-content')) {
      screenshareContent.innerHTML = '';
    }

    // Create a container for this participant's screenshare
    screenshareContainer = document.createElement('div');
    screenshareContainer.id = `screenshare-participant-${participantId}`;
    screenshareContainer.className = 'video-participant-container';

    // Create an image element for the screenshare frame
    const screenshareImg = document.createElement('img');
    screenshareImg.className = 'video-frame';
    screenshareImg.id = `screenshare-frame-${participantId}`;
    screenshareContainer.appendChild(screenshareImg);

    // Add the frame type label
    const typeLabel = document.createElement('div');
    typeLabel.className = 'video-frame-type';
    typeLabel.textContent = 'Screen';
    screenshareContainer.appendChild(typeLabel);

    // Add to the screenshare content area
    screenshareContent.appendChild(screenshareContainer);
  }

  // Update the image with the new frame
  const screenshareImg = document.getElementById(`screenshare-frame-${participantId}`);
  if (screenshareImg) {
    screenshareImg.src = `data:image/png;base64,${buffer}`;
  }
}

// Function to update the participants section in the debug panel
function updateDebugParticipants(participants) {
  const participantsContent = document.getElementById('participantsContent');
  if (!participantsContent) return;

  // Clear previous content
  participantsContent.innerHTML = '';

  if (!participants || participants.length === 0) {
    // Show placeholder if no participants are available
    participantsContent.innerHTML = `
      <div class="placeholder-content">
        <p>No participants detected yet</p>
      </div>
    `;
    return;
  }

  // Create participants list
  const participantsList = document.createElement('div');
  participantsList.className = 'participants-list';

  // Add each participant
  participants.forEach(participant => {
    const participantDiv = document.createElement('div');
    participantDiv.className = 'participant-entry';

    participantDiv.innerHTML = `
      <div class="participant-avatar">
        <svg width="24" height="24" viewBox="0 0 40 40" fill="none" xmlns="http://www.w3.org/2000/svg">
          <rect width="40" height="40" rx="20" fill="#f0f0f0"/>
          <path d="M20 20C22.7614 20 25 17.7614 25 15C25 12.2386 22.7614 10 20 10C17.2386 10 15 12.2386 15 15C15 17.7614 17.2386 20 20 20Z" fill="#a0a0a0"/>
          <path d="M12 31C12 26.0294 15.5817 22 20 22C24.4183 22 28 26.0294 28 31" stroke="#a0a0a0" stroke-width="4"/>
        </svg>
      </div>
      <div class="participant-name">${participant.name || 'Unknown'}</div>
      <div class="participant-status">${participant.status || 'Active'}</div>
    `;

    participantsList.appendChild(participantDiv);
  });

  participantsContent.appendChild(participantsList);
}

// Function to initialize the debug panel
function initDebugPanel() {
  const debugPanelToggle = document.getElementById('debugPanelToggle');
  const debugPanel = document.getElementById('debugPanel');
  const closeDebugPanelBtn = document.getElementById('closeDebugPanelBtn');

  // Set up toggle button for the debug panel
  if (debugPanelToggle && debugPanel) {
    debugPanelToggle.addEventListener('click', () => {
      // Toggle the debug panel visibility
      if (debugPanel.classList.contains('hidden')) {
        debugPanel.classList.remove('hidden');
        document.querySelector('.app-container').classList.add('debug-panel-open');

        // Update the toggle button position and remove any notification indicators
        debugPanelToggle.style.right = '50%';
        debugPanelToggle.classList.remove('has-new-content');
        debugPanelToggle.innerHTML = `
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M7.99 11H20v2H7.99v3L4 12l3.99-4v3z" fill="currentColor"/>
          </svg>
        `;

        // If there's an active meeting, refresh the debug panels with latest data
        if (currentEditingMeetingId) {
          const meeting = [...upcomingMeetings, ...pastMeetings].find(m => m.id === currentEditingMeetingId);
          if (meeting) {
            // Update transcript if available
            if (meeting.transcript && meeting.transcript.length > 0) {
              updateDebugTranscript(meeting.transcript);
            } else {
              // Clear transcript area if no transcript
              const transcriptContent = document.getElementById('transcriptContent');
              if (transcriptContent) {
                transcriptContent.innerHTML = `
                  <div class="placeholder-content">
                    <p>No transcript available yet</p>
                  </div>
                `;
              }
            }

            // Update participants if available
            if (meeting.participants && meeting.participants.length > 0) {
              updateDebugParticipants(meeting.participants);
            } else {
              // Clear participants area if no participants
              const participantsContent = document.getElementById('participantsContent');
              if (participantsContent) {
                participantsContent.innerHTML = `
                  <div class="placeholder-content">
                    <p>No participants detected yet</p>
                  </div>
                `;
              }
            }

            // Reset video preview when opening debug panel
            const videoContent = document.getElementById('videoContent');
            if (videoContent) {
              videoContent.innerHTML = `
                <div class="placeholder-content video-placeholder">
                  <svg width="48" height="48" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                    <path d="M17 10.5V7c0-.55-.45-1-1-1H4c-.55 0-1 .45-1 1v10c0 .55.45 1 1 1h12c.55 0 1-.45 1-1v-3.5l4 4v-11l-4 4z" fill="#999"/>
                  </svg>
                  <p>Video preview will appear here</p>
                </div>
              `;
            }
          }
        }
      } else {
        debugPanel.classList.add('hidden');
        document.querySelector('.app-container').classList.remove('debug-panel-open');

        // Reset the toggle button position
        debugPanelToggle.style.right = '0';
        debugPanelToggle.innerHTML = `
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M20 8h-2.81c-.45-.78-1.07-1.45-1.82-1.96L17 4.41 15.59 3l-2.17 2.17C12.96 5.06 12.49 5 12 5c-.49 0-.96.06-1.41.17L8.41 3 7 4.41l1.62 1.63C7.88 6.55 7.26 7.22 6.81 8H4v2h2.09c-.05.33-.09.66-.09 1v1H4v2h2v1c0 .34.04.67.09 1H4v2h2.81c1.04 1.79 2.97 3 5.19 3s4.15-1.21 5.19-3H20v-2h-2.09c.05-.33.09-.66.09-1v-1h2v-2h-2v-1c0-.34-.04-.67-.09-1H20V8zm-6 8h-4v-2h4v2zm0-4h-4v-2h4v2z" fill="currentColor"/>
          </svg>
        `;
      }
    });
  }

  // Set up close button for the debug panel
  if (closeDebugPanelBtn && debugPanel) {
    closeDebugPanelBtn.addEventListener('click', () => {
      debugPanel.classList.add('hidden');
      // Restore the editorView to full width
      document.querySelector('.app-container').classList.remove('debug-panel-open');

      // Reset the toggle button position and icon
      const debugPanelToggle = document.getElementById('debugPanelToggle');
      if (debugPanelToggle) {
        debugPanelToggle.style.right = '0';
        debugPanelToggle.innerHTML = `
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M20 8h-2.81c-.45-.78-1.07-1.45-1.82-1.96L17 4.41 15.59 3l-2.17 2.17C12.96 5.06 12.49 5 12 5c-.49 0-.96.06-1.41.17L8.41 3 7 4.41l1.62 1.63C7.88 6.55 7.26 7.22 6.81 8H4v2h2.09c-.05.33-.09.66-.09 1v1H4v2h2v1c0 .34.04.67.09 1H4v2h2.81c1.04 1.79 2.97 3 5.19 3s4.15-1.21 5.19-3H20v-2h-2.09c.05-.33.09-.66.09-1v-1h2v-2h-2v-1c0-.34-.04-.67-.09-1H20V8zm-6 8h-4v-2h4v2zm0-4h-4v-2h4v2z" fill="currentColor"/>
          </svg>
        `;
      }
    });
  }

  // Set up clear button for the logger section
  const clearLoggerBtn = document.getElementById('clearLoggerBtn');
  if (clearLoggerBtn) {
    clearLoggerBtn.addEventListener('click', () => {
      sdkLogger.clear();
    });
  }
}

// SDK Logger functions
const sdkLogger = {
  logs: [],
  maxLogs: 100,

  // Initialize the logger
  init() {
    // Listen for logs from the main process
    window.sdkLoggerBridge?.onSdkLog(logEntry => {
      // Add an origin flag to logs created in this renderer to prevent duplicates
      if (!logEntry.originatedFromRenderer) {
        this.addLogEntry(logEntry);
      }
    });

    // Log initialization
    this.log('SDK Logger initialized', 'info');
  },

  // Log an API call
  logApiCall(method, params = {}) {
    const logEntry = {
      type: 'api-call',
      method,
      params,
      timestamp: new Date()
    };

    // Send to main process
    this._sendToMainProcess(logEntry);

    // Add to local logs
    this.addLogEntry(logEntry);
  },

  // Log an event
  logEvent(eventType, data = {}) {
    const logEntry = {
      type: 'event',
      eventType,
      data,
      timestamp: new Date()
    };

    // Send to main process
    this._sendToMainProcess(logEntry);

    // Add to local logs
    this.addLogEntry(logEntry);
  },

  // Log an error
  logError(errorType, message) {
    const logEntry = {
      type: 'error',
      errorType,
      message,
      timestamp: new Date()
    };

    // Send to main process
    this._sendToMainProcess(logEntry);

    // Add to local logs
    this.addLogEntry(logEntry);
  },

  // Log a generic message
  log(message, level = 'info') {
    const logEntry = {
      type: level,
      message,
      timestamp: new Date()
    };

    // Send to main process
    this._sendToMainProcess(logEntry);

    // Add to local logs
    this.addLogEntry(logEntry);
  },

  // Helper to send logs to main process
  _sendToMainProcess(logEntry) {
    if (window.sdkLoggerBridge?.sendSdkLog) {
      // Mark this log entry as originating from this renderer to prevent duplicates
      const markedLogEntry = { ...logEntry, originatedFromRenderer: true };
      window.sdkLoggerBridge.sendSdkLog(markedLogEntry);
    }
  },

  // Add a log entry to the UI and internal array
  addLogEntry(entry) {
    // Add to internal logs array
    this.logs.push(entry);

    // Trim logs if we have too many
    if (this.logs.length > this.maxLogs) {
      this.logs = this.logs.slice(-this.maxLogs);
    }

    // Add to UI
    const loggerContent = document.getElementById('sdkLoggerContent');
    if (loggerContent) {
      const logElement = document.createElement('div');
      logElement.className = `sdk-log-entry ${entry.type}`;

      const timestamp = document.createElement('div');
      timestamp.className = 'timestamp';
      timestamp.textContent = this.formatTimestamp(entry.timestamp instanceof Date ? entry.timestamp : new Date(entry.timestamp));
      logElement.appendChild(timestamp);

      // Format content based on log type
      let content = '';

      switch (entry.type) {
        case 'api-call':
          content = `<span class="method">RecallAiSdk.${entry.method}()</span>`;
          if (entry.params && Object.keys(entry.params).length > 0) {
            content += `<div class="params">${this.formatParams(entry.params)}</div>`;
          }
          break;

        case 'event':
          content = `<span class="event-type">Event: ${entry.eventType}</span>`;
          if (entry.data && Object.keys(entry.data).length > 0) {
            content += `<div class="params">${this.formatParams(entry.data)}</div>`;
          }
          break;

        case 'error':
          content = `<span class="error-type">Error: ${entry.errorType}</span>`;
          if (entry.message) {
            content += `<div class="params">${entry.message}</div>`;
          }
          break;

        default:
          content = entry.message;
      }

      logElement.innerHTML += content;

      // Add to the top of the log
      loggerContent.insertBefore(logElement, loggerContent.firstChild);

      // Only auto-scroll to top if user is already at the top
      const isAtTop = loggerContent.scrollTop <= 5;
      if (isAtTop) {
        loggerContent.scrollTop = 0;
      }
    }
  },

  // Clear all logs
  clear() {
    this.logs = [];
    const loggerContent = document.getElementById('sdkLoggerContent');
    if (loggerContent) {
      loggerContent.innerHTML = '';
    }
  },

  // Format timestamp to readable string
  formatTimestamp(date) {
    return date.toLocaleTimeString('en-US', {
      hour12: false,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      fractionalSecondDigits: 3
    });
  },

  // Format parameters object to JSON string
  formatParams(params) {
    try {
      return JSON.stringify(params, null, 2)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;')
        .replace(/\n/g, '<br>')
        .replace(/ /g, '&nbsp;');
    } catch (e) {
      return String(params);
    }
  }
};

// Initialize the app when the DOM is loaded
document.addEventListener('DOMContentLoaded', async () => {
  console.log('DOM content loaded, loading data from file...');

  // A raw <img src="./assets/..."> path 404s against the webpack dev server -
  // electron-forge's webpack plugin only rewrites asset URLs that are
  // require()'d from JS, not ones referenced directly in static HTML.
  const appLogo = document.getElementById('appLogo');
  if (appLogo) {
    appLogo.src = require('./assets/asymbl-icon.png');
  }

  // Click the rendered preview to switch to raw-markdown editing; blur the
  // textarea to switch back to the rendered view. One-time listeners - both
  // elements are static in index.html, unlike the per-meeting autosave
  // handler in setupAutoSaveHandler().
  const editorPreviewEl = document.getElementById('simple-editor-preview');
  const editorTextareaEl = document.getElementById('simple-editor');
  if (editorPreviewEl && editorTextareaEl) {
    const enterEditMode = () => {
      editorPreviewEl.style.display = 'none';
      editorTextareaEl.style.display = 'block';
      editorTextareaEl.focus();
    };
    editorPreviewEl.addEventListener('click', enterEditMode);
    // Accessibility gap found via CodeRabbit review: the preview was only
    // mouse-operable despite being made tabindex-focusable - Enter/Space
    // now trigger the same edit-mode switch as a click.
    editorPreviewEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        enterEditMode();
      }
    });
    editorTextareaEl.addEventListener('blur', () => {
      syncEditorPreview(editorTextareaEl.value);
      editorTextareaEl.style.display = 'none';
      editorPreviewEl.style.display = 'block';
    });
  }

  // Live transcript panel toggle - one-time listeners, same pattern as
  // the markdown preview toggle above.
  const transcriptToggleBtn = document.getElementById('transcriptToggleBtn');
  const closeLiveTranscriptBtn = document.getElementById('closeLiveTranscriptBtn');
  const liveTranscriptPanelEl = document.getElementById('liveTranscriptPanel');
  if (transcriptToggleBtn && liveTranscriptPanelEl) {
    transcriptToggleBtn.addEventListener('click', () => {
      liveTranscriptPanelEl.classList.toggle('hidden');
    });
  }
  if (closeLiveTranscriptBtn && liveTranscriptPanelEl) {
    closeLiveTranscriptBtn.addEventListener('click', () => {
      liveTranscriptPanelEl.classList.add('hidden');
    });
  }

  // Screen 08 post-call shell
  wirePostCallUi({
    onClose: () => showHomeView(),
    onSaveNotes: (meetingId, content) => {
      const m = pastMeetings.find((x) => x.id === meetingId);
      if (m) {
        m.content = content;
        saveMeetingsData();
      }
    },
    onPersistLinkStatus: (meetingId, status) => {
      const m = pastMeetings.find((x) => x.id === meetingId);
      if (m) {
        m.link_status = status;
        saveMeetingsData();
      }
    },
    onReloadMeeting: async (meetingId) => {
      await loadMeetingsDataFromFile();
      return [...upcomingMeetings, ...pastMeetings].find((m) => m.id === meetingId) || null;
    },
    onDiscarded: async () => {
      await loadMeetingsDataFromFile();
      showHomeView();
    },
    // Screen 08 backoff poll (Grok P1/P4) - persists the summary fields the
    // read-only status poll picked up, same fields generateMeetingSummary's
    // IPC handlers already write on the manual Re-summarize path.
    onSummaryUpdated: (meetingId, updated) => {
      const m = pastMeetings.find((x) => x.id === meetingId);
      if (m) {
        m.aiSummary = updated.aiSummary;
        m.aiSummaryTldr = updated.aiSummaryTldr;
        m.aiSummarySections = updated.aiSummarySections;
        m.aiSummaryProvenance = updated.aiSummaryProvenance;
        m.aiSummaryStatus = updated.aiSummaryStatus;
        m.hasSummary = updated.hasSummary;
        m.aiSummaryError = updated.aiSummaryError;
        saveMeetingsData();
      }
    },
  });

  // Initialize the SDK Logger
  sdkLogger.init();

  // Initialize the debug panel
  initDebugPanel();

  // Try to load the latest data from file - this is the only data source.
  // loadMeetingsDataFromFile() and showHomeView() below each already call
  // refreshHomeDashboard() (which also re-renders the notes list), so no
  // separate renderMeetings()/refreshHomeDashboard() call is needed here.
  await loadMeetingsDataFromFile();
  console.log('Data loaded, rendering meetings...');

  // Initially show home view
  showHomeView();

  // Screen 02 (Home/Today) real SF Event schedule feed, pushed from main.js.
  window.electronAPI.onTodayScheduleUpdated((schedule) => {
    homeTodaySchedule = schedule || [];
    renderHomeDashboard();
  });

  // Hero's Pre-Brief CTA: honestly-documented no-op, same pattern as the
  // tray popover's openPreBrief (#22/#23 not built - no Pre-Brief window
  // exists yet to route to).
  const homeHeroCta = document.getElementById('homeHeroCta');
  if (homeHeroCta) {
    homeHeroCta.addEventListener('click', () => console.log('Pre-Brief not yet built (#22/#23)'));
  }
  const homeEmptyNewCaptureBtn = document.getElementById('homeEmptyNewCaptureBtn');
  if (homeEmptyNewCaptureBtn) {
    homeEmptyNewCaptureBtn.addEventListener('click', () => createNewMeeting());
  }
  // homeLibraryLink is wired inside renderMeetings() instead - that section
  // (and the link) is rebuilt on every data reload, so a one-time listener
  // here would go stale the first time the notes list re-renders.
  const homeLiveOpenBtn = document.getElementById('homeLiveOpenBtn');
  if (homeLiveOpenBtn) {
    homeLiveOpenBtn.addEventListener('click', () => {
      if (homeLiveRecording?.noteId) showEditorView(homeLiveRecording.noteId);
    });
  }
  const homeLiveStopBtn = document.getElementById('homeLiveStopBtn');
  if (homeLiveStopBtn) {
    homeLiveStopBtn.addEventListener('click', async () => {
      if (homeLiveRecording?.recordingId) {
        await window.electronAPI.stopManualRecording(homeLiveRecording.recordingId);
      }
    });
  }

  // Spec B F2: SF SSO login state
  await refreshAuthUi();
  const signInBtn = document.getElementById('signInBtn');
  if (signInBtn) {
    wireSignInButton(signInBtn, 'Sign in with Asymbl');
  }
  const authGateSignInBtn = document.getElementById('authGateSignInBtn');
  if (authGateSignInBtn) {
    wireSignInButton(authGateSignInBtn, 'Continue with Salesforce');
  }

  // Listen for meeting detection status updates
  window.electronAPI.onMeetingDetectionStatus((data) => {
    console.log('Meeting detection status update:', data);
    const joinMeetingBtn = document.getElementById('joinMeetingBtn');

    // Store the meeting detection state globally
    window.meetingDetected = data.detected;
    window.meetingPlatform = data.platformName;

    if (joinMeetingBtn) {
      // Only update button state if we're in the home view
      const inHomeView = document.getElementById('homeView').style.display !== 'none';

      if (inHomeView) {
        // Only shown once a meeting is actually detected (screen 02
        // pixel-fidelity pass - design's header has exactly one CTA when
        // idle); enable/disable still also depends on sign-in state -
        // recording while signed out was a real gap (worked regardless of
        // auth, found during end-to-end testing 2026-07-22).
        joinMeetingBtn.style.display = data.detected ? 'block' : 'none';
        joinMeetingBtn.disabled = !data.detected || !window.isSignedIn;
        joinMeetingBtn.title = window.isSignedIn ? '' : 'Sign in with Asymbl to record a meeting';
        joinMeetingBtn.textContent = data.detected ? `Record ${data.platformName}` : 'Record meeting';
      }
    }
  });

  // Listen for requests to open a meeting note (from notification click)
  window.electronAPI.onOpenMeetingNote((meetingId) => {
    console.log('Received request to open meeting note:', meetingId);

    // Ensure we have the latest data before showing the note
    loadMeetingsDataFromFile().then(() => {
      console.log('Data refreshed, checking for meeting ID:', meetingId);

      // Log the list of available meeting IDs to help with debugging
      console.log('Available meeting IDs:', pastMeetings.map(m => m.id));

      // Verify the meeting exists in our data
      const meeting = [...upcomingMeetings, ...pastMeetings].find(m => m.id === meetingId);

      if (meeting) {
        console.log('Found meeting to open:', meeting.title);
        setTimeout(() => {
          showEditorView(meetingId);
        }, 200); // Add a small delay to ensure UI is ready
      } else {
        console.error('Meeting not found with ID:', meetingId);
        // Attempt to reload data again after a delay
        setTimeout(() => {
          console.log('Retrying data load after delay...');
          loadMeetingsDataFromFile().then(() => {
            const retryMeeting = [...upcomingMeetings, ...pastMeetings].find(m => m.id === meetingId);
            if (retryMeeting) {
              console.log('Found meeting on second attempt:', retryMeeting.title);
              showEditorView(meetingId);
            } else {
              console.error('Meeting still not found after retry. Available meetings:',
                pastMeetings.map(m => `${m.id}: ${m.title}`));
            }
          });
        }, 1500);
      }
    });
  });

  // Listen for recording completed events → Screen 08 post-call
  window.electronAPI.onRecordingCompleted((meetingId) => {
    console.log('Recording completed for meeting:', meetingId);
    loadMeetingsDataFromFile().then(() => {
      const meeting = [...upcomingMeetings, ...pastMeetings].find((m) => m.id === meetingId);
      if (!meeting) return;
      currentEditingMeetingId = meetingId;
      if (shouldOpenPostCall(meeting)) {
        document.getElementById('homeView').style.display = 'none';
        document.getElementById('editorView').style.display = 'none';
        document.getElementById('backButton').style.display = 'block';
        openPostCallView(meeting);
        return;
      }
      if (currentEditingMeetingId === meetingId) {
        const ed = document.getElementById('simple-editor');
        if (ed) {
          ed.value = meeting.content;
          syncEditorPreview(meeting.content);
        }
      }
    });
  });

  // Listen for video frame events
  window.electronAPI.onVideoFrame((data) => {
    // Only handle video frames for the currently open meeting
    if (data.noteId === currentEditingMeetingId) {
      console.log(`Video frame received for participant: ${data.participantName}`);

      // Update the video preview in the debug panel
      updateDebugVideoPreview(data);
    }
  });

  // Listen for participants update events
  window.electronAPI.onParticipantsUpdated((meetingId) => {
    console.log('Participants updated for meeting:', meetingId);

    // If this note is currently being edited, refresh the data
    // and update the debug panel's participants section
    if (currentEditingMeetingId === meetingId) {
      loadMeetingsDataFromFile().then(() => {
        const meeting = [...upcomingMeetings, ...pastMeetings].find(m => m.id === meetingId);
        if (meeting && meeting.participants && meeting.participants.length > 0) {
          // Log the latest participant
          const latestParticipant = meeting.participants[meeting.participants.length - 1];
          console.log(`Participant updated: ${latestParticipant.name}`);

          // Update the participants area in the debug panel
          updateDebugParticipants(meeting.participants);

          // Show notification about new participant if debug panel is closed
          const debugPanel = document.getElementById('debugPanel');
          if (debugPanel && debugPanel.classList.contains('hidden')) {
            const debugPanelToggle = document.getElementById('debugPanelToggle');
            if (debugPanelToggle) {
              // Add pulse effect to show there's new content
              debugPanelToggle.classList.add('has-new-content');

              // Create a mini notification for participant join
              const miniNotification = document.createElement('div');
              miniNotification.className = 'debug-notification participant-notification';
              miniNotification.innerHTML = `
                <span class="debug-notification-title">New Participant:</span>
                <span class="debug-notification-name">${latestParticipant.name || 'Unknown'}</span>
              `;

              // Add to document
              document.body.appendChild(miniNotification);

              // Remove after a short time
              setTimeout(() => {
                miniNotification.classList.add('fade-out');
                setTimeout(() => {
                  document.body.removeChild(miniNotification);
                }, 500);
              }, 5000);
            }
          }
        }
      });
    }
  });

  // Listen for transcript update events
  window.electronAPI.onTranscriptUpdated((meetingId) => {
    console.log('Transcript updated for meeting:', meetingId);

    // If this note is currently being edited, we can refresh the data
    // and update the debug panel's transcript section
    if (currentEditingMeetingId === meetingId) {
      loadMeetingsDataFromFile().then(() => {
        const meeting = [...upcomingMeetings, ...pastMeetings].find(m => m.id === meetingId);
        if (meeting && meeting.transcript && meeting.transcript.length > 0) {
          // Log the latest transcript entry
          const latestEntry = meeting.transcript[meeting.transcript.length - 1];
          console.log(`Latest transcript: ${latestEntry.speaker}: "${latestEntry.text}"`);

          // Update the transcript area in the debug panel
          updateDebugTranscript(meeting.transcript);
          renderLiveTranscript(meeting.transcript);

          // Show notification about new transcript if debug panel is closed
          const debugPanel = document.getElementById('debugPanel');
          if (debugPanel && debugPanel.classList.contains('hidden')) {
            const debugPanelToggle = document.getElementById('debugPanelToggle');
            if (debugPanelToggle) {
              // Add pulse effect to show there's new content
              debugPanelToggle.classList.add('has-new-content');

              // Show a mini notification if we're recording. Real bug found
              // via live use: a new notification div was appended on every
              // transcript chunk without removing the previous one, so fast
              // chunks piled up at the same fixed position and rendered as
              // illegible overlapping text. One at a time - reuse the same
              // element and just update its content, matching the "single
              // most-recent utterance" this notification is meant to show
              // (the full scrollable history is the debug panel's Transcript
              // section, not this transient toast).
              if (window.isRecording) {
                let miniNotification = document.getElementById('transcript-mini-notification');
                if (!miniNotification) {
                  miniNotification = document.createElement('div');
                  miniNotification.id = 'transcript-mini-notification';
                  miniNotification.className = 'debug-notification transcript-notification';
                  document.body.appendChild(miniNotification);
                }
                miniNotification.classList.remove('fade-out');
                // Real XSS gap found via CodeRabbit review: this used to
                // interpolate transcript text (speech-recognition output,
                // not fully trusted) directly into innerHTML. DOM
                // construction + textContent instead, same as the other
                // transcript renderers already fixed this session.
                const excerptText = latestEntry.text.length > 40 ? `${latestEntry.text.slice(0, 40)}...` : latestEntry.text;
                const speakerSpan = document.createElement('span');
                speakerSpan.className = 'debug-notification-speaker';
                speakerSpan.textContent = latestEntry.speaker || 'Unknown';
                const textSpan = document.createElement('span');
                textSpan.className = 'debug-notification-text';
                textSpan.textContent = excerptText;
                miniNotification.replaceChildren(speakerSpan, document.createTextNode(': '), textSpan);

                // Remove after a short time of no further updates
                clearTimeout(window.__transcriptNotificationTimeout);
                window.__transcriptNotificationTimeout = setTimeout(() => {
                  miniNotification.classList.add('fade-out');
                  setTimeout(() => {
                    miniNotification.remove();
                  }, 500);
                }, 5000);
              }
            }
          }
        }
      });
    }
  });

  // Listen for meeting title updates
  window.electronAPI.onMeetingTitleUpdated((data) => {
    console.log('Meeting title updated:', data);
    
    const { meetingId, newTitle } = data;
    
    // Reload the meetings data
    loadMeetingsDataFromFile().then(() => {
      // Re-render the meetings list to show the updated title
      renderMeetings();
      
      // If this is the currently open meeting, update the editor title too
      if (currentEditingMeetingId === meetingId) {
        const noteTitleElement = document.getElementById('noteTitle');
        if (noteTitleElement) {
          noteTitleElement.textContent = newTitle;
          console.log('Updated editor title to:', newTitle);
        }
      }
    });
  });

  // Listen for summary generation events (Gemini fields live on meeting, not content)
  window.electronAPI.onSummaryGenerated((meetingId) => {
    console.log('Summary generated for meeting:', meetingId);
    if (currentEditingMeetingId !== meetingId) return;
    loadMeetingsDataFromFile().then(() => {
      const meeting = [...upcomingMeetings, ...pastMeetings].find((m) => m.id === meetingId);
      if (!meeting) return;
      if (isPostCallOpen()) {
        openPostCallView(meeting);
        return;
      }
      // Classic editor: leave My Notes alone; summary is in aiSummary*
    });
  });

  // Listen for streaming summary updates (Gemini — never clobbers My Notes)
  window.electronAPI.onSummaryUpdate((data) => {
    const { meetingId, content, aiSummaryStatus } = data;
    if (currentEditingMeetingId !== meetingId) return;

    // Prefer post-call TL;DR surface when Screen 08 is open
    if (isPostCallOpen()) {
      const m = pastMeetings.find((x) => x.id === meetingId);
      if (m) {
        m.aiSummaryStatus = aiSummaryStatus || m.aiSummaryStatus || 'writing';
        if (content && (aiSummaryStatus === 'writing' || !aiSummaryStatus)) {
          // progress text only
        }
        renderSummary(m);
      }
      const body = document.getElementById('pcTldrBody');
      const label = document.getElementById('pcTldrLabel');
      if (body && content) body.textContent = content;
      if (label) label.textContent = '✦ Writing notes…';
      return;
    }

    // Classic editor: do not overwrite notes content with AI status strings
  });

  // Add event listeners for buttons
  document.querySelector('.new-note-btn').addEventListener('click', async () => {
    console.log('New note button clicked');
    await createNewMeeting();
  });

  // Join Meeting button handler
  document.getElementById('joinMeetingBtn').addEventListener('click', async () => {
    console.log('Join Meeting button clicked');

    // Get the button element
    const joinButton = document.getElementById('joinMeetingBtn');

    // Show loading state
    const originalText = joinButton.textContent;
    joinButton.disabled = true;
    joinButton.innerHTML = `
      <svg class="spinner" width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" style="margin-right: 8px;">
        <path d="M12 2C6.48 2 2 6.48 2 12C2 17.52 6.48 22 12 22C17.52 22 22 17.52 22 12" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
      </svg>
      Joining...
    `;

    // First check if there's a detected meeting
    if (window.electronAPI.checkForDetectedMeeting) {
      try {
        const hasDetectedMeeting = await window.electronAPI.checkForDetectedMeeting();
        if (hasDetectedMeeting) {
          console.log('Found detected meeting, joining...');
          await window.electronAPI.joinDetectedMeeting();
          // Keep button disabled as we're navigating to a different view
        } else {
          console.log('No active meeting detected');

          // Reset button state
          joinButton.disabled = false;
          joinButton.textContent = originalText;

          // Show a little toast message
          const toast = document.createElement('div');
          toast.className = 'toast';
          toast.textContent = 'No active meeting detected';
          document.body.appendChild(toast);

          // Remove toast after 3 seconds
          setTimeout(() => {
            toast.style.opacity = '0';
            setTimeout(() => {
              document.body.removeChild(toast);
            }, 300);
          }, 3000);
        }
      } catch (error) {
        console.error('Error joining meeting:', error);

        // Reset button state
        joinButton.disabled = false;
        joinButton.textContent = originalText;

        // Show error toast
        const toast = document.createElement('div');
        toast.className = 'toast';
        toast.textContent = 'Error joining meeting';
        document.body.appendChild(toast);

        // Remove toast after 3 seconds
        setTimeout(() => {
          toast.style.opacity = '0';
          setTimeout(() => {
            document.body.removeChild(toast);
          }, 300);
        }, 3000);
      }
    } else {
      // Fallback for direct call
      try {
        await window.electronAPI.joinDetectedMeeting();
        // Keep button disabled as we're navigating to a different view
      } catch (error) {
        console.error('Error joining meeting:', error);

        // Reset button state
        joinButton.disabled = false;
        joinButton.textContent = originalText;
      }
    }
  });

  const debouncedSearch = debounce((query) => {
    const notesContainer = document.getElementById('notes-list');
    if (notesContainer) {
      renderNotesInto(notesContainer, query);
    }
  }, 150);

  document.querySelector('.search-input').addEventListener('input', (e) => {
    debouncedSearch(e.target.value);
  });

  // Add click event delegation for meeting cards and their actions
  document.querySelector('.main-content').addEventListener('click', (e) => {
    // Check if delete button was clicked
    if (e.target.closest('.delete-meeting-btn')) {
      e.stopPropagation(); // Prevent opening the note
      const deleteBtn = e.target.closest('.delete-meeting-btn');
      const meetingId = deleteBtn.dataset.id;

      if (confirm('Are you sure you want to delete this note? This cannot be undone.')) {
        console.log('Deleting meeting:', meetingId);

        // Show loading state
        deleteBtn.disabled = true;
        deleteBtn.innerHTML = `<svg class="spinner" width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path d="M12 2C6.48 2 2 6.48 2 12C2 17.52 6.48 22 12 22C17.52 22 22 17.52 22 12" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
        </svg>`;

        // Use the main process deletion via IPC
        window.electronAPI.deleteMeeting(meetingId)
          .then(result => {
            if (result.success) {
              console.log('Meeting deleted successfully on server');

              // After successful server deletion, update local data
              // Remove from local pastMeetings array
              const pastMeetingIndex = pastMeetings.findIndex(meeting => meeting.id === meetingId);
              if (pastMeetingIndex !== -1) {
                pastMeetings.splice(pastMeetingIndex, 1);
              }

              // Remove from meetingsData as well
              const pastDataIndex = meetingsData.pastMeetings.findIndex(meeting => meeting.id === meetingId);
              if (pastDataIndex !== -1) {
                meetingsData.pastMeetings.splice(pastDataIndex, 1);
              }

              // Also check upcomingMeetings
              const upcomingMeetingIndex = upcomingMeetings.findIndex(meeting => meeting.id === meetingId);
              if (upcomingMeetingIndex !== -1) {
                upcomingMeetings.splice(upcomingMeetingIndex, 1);
              }

              const upcomingDataIndex = meetingsData.upcomingMeetings.findIndex(meeting => meeting.id === meetingId);
              if (upcomingDataIndex !== -1) {
                meetingsData.upcomingMeetings.splice(upcomingDataIndex, 1);
              }

              // Update the grouped meetings
              pastMeetingsByDate = {};
              meetingsData.pastMeetings.forEach(meeting => {
                const dateKey = formatDateHeader(meeting.date);
                if (!pastMeetingsByDate[dateKey]) {
                  pastMeetingsByDate[dateKey] = [];
                }
                pastMeetingsByDate[dateKey].push(meeting);
              });

              // Re-render the meetings list
              renderMeetings();
            } else {
              // Server side deletion failed
              console.error('Server deletion failed:', result.error);
              alert('Failed to delete note: ' + (result.error || 'Unknown error'));
            }
          })
          .catch(error => {
            console.error('Error deleting meeting:', error);
            alert('Failed to delete note: ' + (error.message || 'Unknown error'));
          })
          .finally(() => {
            // Reset button state whether success or failure
            deleteBtn.disabled = false;
            deleteBtn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z" fill="currentColor"/>
            </svg>`;
          });
      }
      return;
    }

    // Find the meeting card that was clicked (for opening)
    const card = e.target.closest('.meeting-card');
    if (card) {
      const meetingId = card.dataset.id;
      showEditorView(meetingId);
    }
  });

  // Back button event listener
  document.getElementById('backButton').addEventListener('click', async () => {
    // Save content before going back to home
    await saveCurrentNote();
    showHomeView();
    renderMeetings(); // Refresh the meeting list
  });

  // Set up the initial auto-save handler
  setupAutoSaveHandler();

  // Toggle sidebar button with initial state
  const toggleSidebarBtn = document.getElementById('toggleSidebar');
  const sidebar = document.getElementById('sidebar');
  const editorContent = document.querySelector('.editor-content');
  const chatInputContainer = document.querySelector('.chat-input-container');

  // Start with sidebar hidden
  sidebar.classList.add('hidden');
  editorContent.classList.add('full-width');
  chatInputContainer.style.display = 'none';

  toggleSidebarBtn.addEventListener('click', () => {
    sidebar.classList.toggle('hidden');
    editorContent.classList.toggle('full-width');

    // Show/hide chat input with sidebar
    if (sidebar.classList.contains('hidden')) {
      chatInputContainer.style.display = 'none';
    } else {
      chatInputContainer.style.display = 'block';
    }
  });

  // Chat input handling
  const chatInput = document.getElementById('chatInput');
  const sendButton = document.getElementById('sendButton');

  // When send button is clicked
  sendButton.addEventListener('click', () => {
    const message = chatInput.value.trim();
    if (message) {
      console.log('Sending message:', message);
      // Here you would handle the AI chat functionality
      // For now, just clear the input
      chatInput.value = '';
    }
  });

  // Send message on Enter key
  chatInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
      sendButton.click();
    }
  });

  // Handle share buttons
  const shareButtons = document.querySelectorAll('.share-btn');
  shareButtons.forEach(button => {
    button.addEventListener('click', () => {
      const action = button.textContent.trim();
      console.log(`Share action: ${action}`);
      // Implement actual sharing functionality here
    });
  });

  // Handle AI option buttons
  const aiButtons = document.querySelectorAll('.ai-btn');
  aiButtons.forEach(button => {
    button.addEventListener('click', async () => {
      const action = button.textContent.trim();
      console.log(`AI action: ${action}`);

      // Handle different AI actions
      if (action === 'Generate meeting summary') {
        if (!currentEditingMeetingId) {
          alert('No meeting is currently open');
          return;
        }

        // Show loading state
        const originalText = button.textContent;
        button.textContent = 'Generating summary...';
        button.disabled = true;

        try {
          // Use streaming version instead of standard version
          console.log('Starting streaming summary generation');

          // Log the summary generation request to the SDK logger
          sdkLogger.log('Requesting AI summary generation for meeting: ' + currentEditingMeetingId);

          window.electronAPI.generateMeetingSummaryStreaming(currentEditingMeetingId)
            .then(result => {
              if (result.success) {
                console.log('Summary generated successfully (streaming)');
              } else {
                console.error('Failed to generate summary:', result.error);
                alert('Failed to generate summary: ' + result.error);
              }
            })
            .catch(error => {
              console.error('Error generating summary:', error);
              alert('Error generating summary: ' + (error.message || error));
            })
            .finally(() => {
              // Reset button state
              button.textContent = originalText;
              button.disabled = false;
            });
        } catch (error) {
          console.error('Error starting streaming summary generation:', error);
          alert('Error starting summary generation: ' + (error.message || error));

          // Reset button state
          button.textContent = originalText;
          button.disabled = false;
        }
      } else if (action === 'List action items') {
        alert('List action items functionality coming soon');
      } else if (action === 'Write follow-up email') {
        alert('Write follow-up email functionality coming soon');
      } else if (action === 'List Q&A') {
        alert('List Q&A functionality coming soon');
      }
    });
  });

  // UI variables will be initialized when the recording button is set up

  // Listen for recording state change events
  window.electronAPI.onRecordingStateChange((data) => {
    console.log('Recording state change received:', data);

    // If this state change is for the current note, update the UI
    if (data.noteId === currentEditingMeetingId) {
      console.log('Updating recording button for current note');
      const isActive = data.state === 'recording' || data.state === 'paused';
      updateRecordingButtonUI(isActive, isActive ? data.recordingId : null);
    }

    // Screen 02b (Home while recording) - drives the live strip regardless
    // of which note is currently open in the editor, since Home is browsable
    // during an active capture (spec §3).
    if (data.state === 'recording') {
      homeLiveRecording = { noteId: data.noteId, recordingId: data.recordingId, startedAt: data.startedAt, title: data.title };
      if (homeTickInterval) clearInterval(homeTickInterval);
      homeTickInterval = setInterval(homeTickLiveTimer, 1000);
      homeTickLiveTimer();
    } else if (data.state === 'ended') {
      homeLiveRecording = null;
      if (homeTickInterval) {
        clearInterval(homeTickInterval);
        homeTickInterval = null;
      }
    }
    renderHomeDashboard();
  });

  // Setup record/stop button toggle
  const recordButton = document.getElementById('recordButton');
  if (recordButton) {

    recordButton.addEventListener('click', async () => {
      // Only allow recording if we're in a note
      if (!currentEditingMeetingId) {
        alert('You need to be in a note to start recording');
        return;
      }

      window.isRecording = !window.isRecording;
      if (!window.isRecording) {
        // Recording just ended - refreshAuthUi()'s gate guard keeps the
        // sign-in wall hidden for the whole time isRecording is true (never
        // yank stop/status controls out from under an active capture), so
        // if auth actually dropped mid-recording, re-check now instead of
        // leaving the gate hidden until some unrelated event triggers it.
        refreshAuthUi();
      }

      // Get the elements inside the button
      const recordIcon = recordButton.querySelector('.record-icon');
      const stopIcon = recordButton.querySelector('.stop-icon');

      if (window.isRecording) {
        try {
          // Start recording
          console.log('Starting manual recording for meeting:', currentEditingMeetingId);
          recordButton.disabled = true; // Temporarily disable to prevent double-clicks

          // Change to stop mode immediately for better feedback
          recordButton.classList.add('recording');
          recordIcon.style.display = 'none';
          stopIcon.style.display = 'block';

          // Call the API to start recording
          const result = await window.electronAPI.startManualRecording(currentEditingMeetingId);
          recordButton.disabled = false;

          if (result.success) {
            console.log('Manual recording started with ID:', result.recordingId);
            window.currentRecordingId = result.recordingId;

            // Show a little toast message
            const toast = document.createElement('div');
            toast.className = 'toast';
            toast.textContent = 'Recording started...';
            document.body.appendChild(toast);

            // Remove toast after 3 seconds
            setTimeout(() => {
              toast.style.opacity = '0';
              setTimeout(() => {
                document.body.removeChild(toast);
              }, 300);
            }, 3000);
          } else {
            // If starting failed, revert UI
            console.error('Failed to start recording:', result.error);
            showToast('Failed to start recording: ' + result.error);
            window.isRecording = false;
            recordButton.classList.remove('recording');
            recordIcon.style.display = 'block';
            stopIcon.style.display = 'none';
          }
        } catch (error) {
          // Handle errors
          console.error('Error starting recording:', error);
          alert('Error starting recording: ' + (error.message || error));

          // Reset UI state
          window.isRecording = false;
          recordButton.classList.remove('recording');
          recordIcon.style.display = 'block';
          stopIcon.style.display = 'none';
          recordButton.disabled = false;
        }
      } else {
        // Stop recording
        if (window.currentRecordingId) {
          try {
            console.log('Stopping manual recording:', window.currentRecordingId);
            recordButton.disabled = true; // Temporarily disable

            // Call the API to stop recording
            const result = await window.electronAPI.stopManualRecording(window.currentRecordingId);

            // Change to record mode
            recordButton.classList.remove('recording');
            recordIcon.style.display = 'block';
            stopIcon.style.display = 'none';
            recordButton.disabled = false;

            if (result.success) {
              console.log('Manual recording stopped successfully');

              // Show a little toast message
              const toast = document.createElement('div');
              toast.className = 'toast';
              toast.textContent = 'Recording stopped. Generating summary...';
              document.body.appendChild(toast);

              // Remove toast after 3 seconds
              setTimeout(() => {
                toast.style.opacity = '0';
                setTimeout(() => {
                  document.body.removeChild(toast);
                }, 300);
              }, 3000);

              // The recording-completed event handler will take care of refreshing the content
              // and generating the summary when the recording finishes processing

            } else {
              console.error('Failed to stop recording:', result.error);
              alert('Failed to stop recording: ' + result.error);
            }

            // Reset recording ID
            window.currentRecordingId = null;
          } catch (error) {
            console.error('Error stopping recording:', error);
            alert('Error stopping recording: ' + (error.message || error));
            recordButton.disabled = false;
          }
        } else {
          console.warn('No active recording ID found');
          // Reset UI anyway
          recordButton.classList.remove('recording');
          recordIcon.style.display = 'block';
          stopIcon.style.display = 'none';
        }
      }
    });
  }

  // Handle generate notes button (Auto button)
  const generateButton = document.querySelector('.generate-btn');
  if (generateButton) {
    generateButton.addEventListener('click', async () => {
      console.log('Generating AI summary from transcript...');

      // Check if we have an active meeting
      if (!currentEditingMeetingId) {
        alert('No meeting is currently open');
        return;
      }

      // Store the original HTML content (including the sparkle icon)
      const originalHTML = generateButton.innerHTML;

      // Show loading state - but keep the same structure
      generateButton.innerHTML = `
        <svg width="16" height="16" viewBox="0 0 512 512" fill="none" xmlns="http://www.w3.org/2000/svg" style="margin-right: 4px;">
          <path d="M208,512a24.84,24.84,0,0,1-23.34-16l-39.84-103.6a16.06,16.06,0,0,0-9.19-9.19L32,343.34a25,25,0,0,1,0-46.68l103.6-39.84a16.06,16.06,0,0,0,9.19-9.19L184.66,144a25,25,0,0,1,46.68,0l39.84,103.6a16.06,16.06,0,0,0,9.19,9.19l103,39.63A25.49,25.49,0,0,1,400,320.52a24.82,24.82,0,0,1-16,22.82l-103.6,39.84a16.06,16.06,0,0,0-9.19,9.19L231.34,496A24.84,24.84,0,0,1,208,512Z" fill="currentColor"/>
          <path d="M88,176a14.67,14.67,0,0,1-13.69-9.4L57.45,122.76a7.28,7.28,0,0,0-4.21-4.21L9.4,101.69a14.67,14.67,0,0,1,0-27.38L53.24,57.45a7.31,7.31,0,0,0,4.21-4.21L74.16,9.79A15,15,0,0,1,86.23.11,14.67,14.67,0,0,1,101.69,9.4l16.86,43.84a7.31,7.31,0,0,0,4.21,4.21L166.6,74.31a14.67,14.67,0,0,1,0,27.38l-43.84,16.86a7.28,7.28,0,0,0-4.21,4.21L101.69,166.6A14.67,14.67,0,0,1,88,176Z" fill="currentColor"/>
          <path d="M400,256a16,16,0,0,1-14.93-10.26l-22.84-59.37a8,8,0,0,0-4.6-4.6l-59.37-22.84a16,16,0,0,1,0-29.86l59.37-22.84a8,8,0,0,0,4.6-4.6L384.9,42.68a16.45,16.45,0,0,1,13.17-10.57,16,16,0,0,1,16.86,10.15l22.84,59.37a8,8,0,0,0,4.6,4.6l59.37,22.84a16,16,0,0,1,0,29.86l-59.37,22.84a8,8,0,0,0-4.6,4.6l-22.84,59.37A16,16,0,0,1,400,256Z" fill="currentColor"/>
        </svg>
        Generating...
      `;
      generateButton.disabled = true;

      try {
        // Use streaming version for better user experience
        console.log('Starting streaming summary generation');

        // Log the Auto button summary generation to the SDK logger
        sdkLogger.log('Auto button: Requesting AI summary generation for meeting: ' + currentEditingMeetingId);

        const result = await window.electronAPI.generateMeetingSummaryStreaming(currentEditingMeetingId);

        if (result.success) {
          console.log('Summary generated successfully (streaming)');
          // Show a little toast message
          const toast = document.createElement('div');
          toast.className = 'toast';
          toast.textContent = 'Summary generated successfully!';
          document.body.appendChild(toast);

          // Remove toast after 3 seconds
          setTimeout(() => {
            toast.style.opacity = '0';
            setTimeout(() => {
              document.body.removeChild(toast);
            }, 300);
          }, 3000);
        } else {
          console.error('Failed to generate summary:', result.error);
          alert('Failed to generate summary: ' + result.error);
        }
      } catch (error) {
        console.error('Error generating summary:', error);
        alert('Error generating summary: ' + (error.message || error));
      } finally {
        // Reset button state with the original HTML (including sparkle icon)
        generateButton.innerHTML = originalHTML;
        generateButton.disabled = false;
      }
    });
  }



  // Listen for recording completed events
  window.electronAPI.onRecordingCompleted((meetingId) => {
    console.log('Recording completed for meeting:', meetingId);
    if (currentEditingMeetingId === meetingId) {
      // Reload the meeting data first
      loadMeetingsDataFromFile().then(() => {
        // Refresh the editor with the updated content
        const meeting = [...upcomingMeetings, ...pastMeetings].find(m => m.id === meetingId);
        if (meeting) {
          document.getElementById('simple-editor').value = meeting.content;
          syncEditorPreview(meeting.content);
        }
      });
    }
  });

});
