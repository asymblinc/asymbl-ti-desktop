// Control-plane HTTP client. Replaces the fork's original local Express
// server (src/server.js, deleted) which held the Recall API key directly on
// the desktop with no auth. All Recall/AAI/SF credentials now live only in
// the control plane (gcp/control-plane in the Recall delivery repo) -
// handoff §7: "no local TCP port" on the desktop, and the key never leaves
// the server.
const axios = require('axios');
const authStore = require('./auth-store');

// Routed through the MuleSoft CloudHub proxy (docs/mulesoft.md in the Recall
// repo) rather than directly at Cloud Run - dogfooding the integration while
// API Manager governance (rate limiting, client-ID enforcement) and the
// asymbl.app custom domain are still being wired up on the MuleSoft side.
// STT (/api/ti/desktop/stt/stream) is unaffected - the desktop app never
// calls it directly, real-time transcript comes through the Recall SDK's own
// desktop_sdk_callback mechanism, not a client-side WebSocket to this URL.
const CONTROL_PLANE_URL = process.env.CONTROL_PLANE_URL || 'https://control-plane-proxy-2ew73i.rajrd4-2.usa-e1.cloudhub.io';

/**
 * F9 (Spec B, Upload Paths): mint a Recall upload token via the control
 * plane instead of a local server holding the API key.
 *
 * Returns { status: 'success', upload_token } on success (same shape the
 * pre-fork local server returned, so call sites don't need to change), or
 * { status: 'error', message } on failure.
 */
// TEMPORARY, dev-only (docs/DECISIONS.md ADR-027): F7-R11 real SF OAuth login
// now works end-to-end, but requires clicking through a real Salesforce
// login/consent screen. While testing, fall back to the control-plane's
// dev-token route (also temporary, gated by ALLOW_DEV_TOKEN server-side) so
// recording/upload/transcript can be exercised without that manual step.
// Remove both sides once real login is the default tested path.
async function getDevTokenFallback() {
  try {
    const response = await axios.post(`${CONTROL_PLANE_URL}/api/ti/desktop/dev-token`, {}, { timeout: 10000 });
    authStore.setTokens({ access_token: response.data.access_token, refresh_token: null });
    return response.data.access_token;
  } catch (error) {
    console.error('Dev-token fallback failed:', error.message);
    return null;
  }
}

async function createDesktopSdkUpload(decisionToken, interviewId = null) {
  let accessToken = authStore.getAccessToken() || (await getDevTokenFallback());
  if (!accessToken) {
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

/**
 * Spec B F10-R11: "first call after login," used here just to read
 * tenant.features.telemetry_enabled before initializing PostHog. Other
 * bootstrap fields (runtime URLs, license_status) aren't consumed yet -
 * every other client in this file still hardcodes its own route, a
 * pre-existing simplification from before this endpoint existed.
 */
async function fetchBootstrap() {
  const accessToken = authStore.getAccessToken();
  if (!accessToken) {
    return { status: 'error', message: 'Not signed in' };
  }
  try {
    const response = await axios.get(`${CONTROL_PLANE_URL}/api/ti/desktop/bootstrap`, {
      headers: { Authorization: `Bearer ${accessToken}`, 'X-Asymbl-Desktop-Version': require('../package.json').version },
      timeout: 10000,
    });
    return { status: 'success', bootstrap: response.data };
  } catch (error) {
    return { status: 'error', message: error.response?.data?.error || error.message };
  }
}

/**
 * Screen 01 (menu-bar tray "Next on calendar" card) - the signed-in user's
 * next upcoming SF Event (Activity), not Interview__c: the design's "Open
 * Pre-Brief" button implies the Pre-Brief API's event_id, and Event is SF's
 * own native calendar object. Returns null next_event when nothing is
 * scheduled - a real, valid "nothing next" state, not an error.
 */
async function fetchNextEvent() {
  const accessToken = authStore.getAccessToken();
  if (!accessToken) {
    return { status: 'error', message: 'Not signed in' };
  }
  try {
    const response = await axios.get(`${CONTROL_PLANE_URL}/api/ti/desktop/next-event`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      timeout: 10000,
    });
    return { status: 'success', nextEvent: response.data.next_event };
  } catch (error) {
    return { status: 'error', message: error.response?.data?.error || error.message };
  }
}

/**
 * Screen 02 (Home/Today, docs/screen-specs/02-home-today.md §2.4) "Today's
 * schedule" list - same SF Event source as fetchNextEvent, just the rest of
 * today instead of a single next row.
 */
async function fetchTodaySchedule() {
  const accessToken = authStore.getAccessToken();
  if (!accessToken) {
    return { status: 'error', message: 'Not signed in' };
  }
  try {
    const response = await axios.get(`${CONTROL_PLANE_URL}/api/ti/desktop/today-schedule`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      timeout: 10000,
    });
    return { status: 'success', schedule: response.data.schedule };
  } catch (error) {
    return { status: 'error', message: error.response?.data?.error || error.message };
  }
}

module.exports = { createDesktopSdkUpload, refreshSession, finalizeDesktopSession, fetchBootstrap, fetchNextEvent, fetchTodaySchedule, CONTROL_PLANE_URL };
