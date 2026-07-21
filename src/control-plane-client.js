// Control-plane HTTP client. Replaces the fork's original local Express
// server (src/server.js, deleted) which held the Recall API key directly on
// the desktop with no auth. All Recall/AAI/SF credentials now live only in
// the control plane (gcp/control-plane in the Recall delivery repo) -
// handoff §7: "no local TCP port" on the desktop, and the key never leaves
// the server.
const axios = require('axios');
const authStore = require('./auth-store');

const CONTROL_PLANE_URL = process.env.CONTROL_PLANE_URL || 'https://control-plane-912609211955.us-east1.run.app';

/**
 * F9 (Spec B, Upload Paths): mint a Recall upload token via the control
 * plane instead of a local server holding the API key.
 *
 * Returns { status: 'success', upload_token } on success (same shape the
 * pre-fork local server returned, so call sites don't need to change), or
 * { status: 'error', message } on failure.
 */
async function createDesktopSdkUpload(decisionToken, interviewId = null) {
  const accessToken = authStore.getAccessToken();
  if (!accessToken) {
    // [UNVERIFIED - blocked] F7-R11 per-user SF OAuth login isn't built yet
    // (needs a real Salesforce Connected App, see docs/BLOCKERS.md in the
    // Recall delivery repo). There is no way to obtain a real Asymbl access
    // token from the desktop until that exists. Surfacing a clear error
    // instead of silently no-op-ing or faking a token.
    return { status: 'error', message: 'Not signed in - Salesforce login is not yet wired up (blocked on Connected App credentials)' };
  }

  try {
    const response = await axios.post(
      `${CONTROL_PLANE_URL}/api/ti/desktop/sessions/start`,
      { decision_token: decisionToken, interview_id: interviewId },
      { headers: { Authorization: `Bearer ${accessToken}` }, timeout: 10000 }
    );
    return { status: 'success', upload_token: response.data.upload_token, session: response.data };
  } catch (error) {
    console.error('Error creating upload token via control plane:', error.message);
    return { status: 'error', message: error.response?.data?.error || error.message };
  }
}

/**
 * Spec B F3: token refresh + heartbeat. F7-R2's access token is a 15-min
 * TTL, so this needs to run periodically (see main.js's setInterval) as long
 * as a refresh token exists - not just once at startup.
 */
async function refreshSession() {
  const refreshToken = authStore.loadPersistedRefreshToken();
  if (!refreshToken) {
    return { status: 'error', message: 'No persisted refresh token' };
  }

  try {
    const response = await axios.post(
      `${CONTROL_PLANE_URL}/auth/refresh`,
      { refresh_token: refreshToken },
      { timeout: 10000 }
    );
    authStore.setTokens({ access_token: response.data.access_token, refresh_token: response.data.refresh_token });
    return { status: 'success' };
  } catch (error) {
    // F13-R5/F7-R6: a 401 here can mean an inactive license or a revoked
    // token family - either way the session is dead, so clear local state
    // rather than silently keep offering a stale button.
    if (error.response?.status === 401) {
      authStore.clearTokens();
    }
    return { status: 'error', message: error.response?.data?.error || error.message };
  }
}

/**
 * Spec B F6: finalize closes a desktop recording session server-side and is
 * the only trigger for process_interview_capture on a desktop-only/
 * supplement capture (a bot capture is triggered by bot.recording_done
 * instead, in recall-webhook). Called once per recording, when it ends.
 */
async function finalizeDesktopSession(sessionId, { endedAt, finalSeconds, transcriptArtifacts }) {
  const accessToken = authStore.getAccessToken();
  if (!accessToken) {
    return { status: 'error', message: 'Not signed in' };
  }
  try {
    const response = await axios.post(
      `${CONTROL_PLANE_URL}/api/ti/desktop/sessions/${sessionId}/finalize`,
      { ended_at: endedAt, final_seconds: finalSeconds, transcript_artifacts: transcriptArtifacts },
      { headers: { Authorization: `Bearer ${accessToken}` }, timeout: 10000 }
    );
    return { status: 'success', result: response.data };
  } catch (error) {
    console.error('Error finalizing desktop session:', error.message);
    return { status: 'error', message: error.response?.data?.error || error.message };
  }
}

module.exports = { createDesktopSdkUpload, refreshSession, finalizeDesktopSession, CONTROL_PLANE_URL };
