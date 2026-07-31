// Spec B F8 (Recruiter Notes Editor) - syncs note content to the control
// plane so recruiter notes survive local-only loss and can be re-read by
// other surfaces (contracts/desktop-control-plane-api.yaml POST/GET
// /api/ti/desktop/notes/{notes_session_id}).
//
// [SIMPLIFICATION, flagged not hidden] the contract models notes as a
// block-level CRDT-lite append log (block_id, cursor position, per-edit
// timestamps - built for a structured block editor). This app's actual
// editor (easymde/CodeMirror over a single markdown textarea, see
// pages/note-editor) has no concept of blocks or cursor-level edit events -
// it saves the whole note as one markdown string. Rather than fabricate
// fake block/cursor data to look contract-compliant, this syncs the whole
// note as ONE block per meeting (block_id = meetingId, stable across saves
// so repeated syncs overwrite in place instead of duplicating - the same
// idempotent-by-block_id behavior the contract's append endpoint gives for
// free). True per-keystroke block sync would need restructuring the editor
// itself - out of scope here.
const axios = require('axios');
const authStore = require('./auth-store');
const { CONTROL_PLANE_URL } = require('./control-plane-client');

const pendingRetries = new Map(); // meetingId -> { notesSessionId, content } - last-failed sync, retried on the next successful call for ANY meeting

async function syncNote(meetingId, notesSessionId, content) {
  if (!notesSessionId) {
    return { status: 'error', message: 'No notes_session_id for this meeting' };
  }
  const accessToken = authStore.getAccessToken();
  if (!accessToken) {
    pendingRetries.set(meetingId, { notesSessionId, content });
    return { status: 'error', message: 'Not signed in' };
  }

  try {
    await axios.post(
      `${CONTROL_PLANE_URL}/api/ti/desktop/notes/${notesSessionId}/append`,
      { block_id: meetingId, timestamp: new Date().toISOString(), type: 'text', content, private: true },
      { headers: { Authorization: `Bearer ${accessToken}` }, timeout: 10000 }
    );
    pendingRetries.delete(meetingId);

    // Best-effort: flush one other pending retry per successful sync rather
    // than a dedicated timer - simplest thing that eventually catches up
    // after an offline period without adding a new background interval.
    const [otherId, other] = pendingRetries.entries().next().value ?? [];
    if (otherId && otherId !== meetingId) {
      pendingRetries.delete(otherId);
      syncNote(otherId, other.notesSessionId, other.content).catch(() => {});
    }
    return { status: 'success' };
  } catch (error) {
    pendingRetries.set(meetingId, { notesSessionId, content });
    return { status: 'error', message: error.response?.data?.error || error.message };
  }
}

// Screen 02 (Home/Today §2.6) "Waiting to sync" queue - the only real,
// already-tracked signal for that queue type (see docs/screen-specs/02-home-today.md
// §12: the other 4 needs-attention queue types have no backing data source yet).
function getPendingSyncMeetingIds() {
  return [...pendingRetries.keys()];
}

module.exports = { syncNote, getPendingSyncMeetingIds };
