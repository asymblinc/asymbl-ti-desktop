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

module.exports = { createDesktopSdkUpload, CONTROL_PLANE_URL };
