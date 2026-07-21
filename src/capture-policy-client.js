// Spec B F5: meeting detection -> capture policy -> consent. Calls the
// control plane's GET /api/ti/capture-policy (F6) so the desktop knows
// whether it's allowed to record at all, and whether a bot is already
// authoritative for this meeting (Bot_Capture_Mode__c=Bot/Both) before it
// starts its own recording.
const axios = require('axios');
const authStore = require('./auth-store');
const { CONTROL_PLANE_URL } = require('./control-plane-client');

async function checkCapturePolicy(meetingUrl) {
  const accessToken = authStore.getAccessToken();
  if (!accessToken) {
    // [UNVERIFIED - blocked] same F7-R11 login gap as control-plane-client.js.
    return { status: 'error', message: 'Not signed in' };
  }
  if (!meetingUrl) {
    return { status: 'error', message: 'No meeting URL available yet' };
  }

  try {
    const response = await axios.get(`${CONTROL_PLANE_URL}/api/ti/capture-policy`, {
      params: { meeting_url: meetingUrl, detected_at: new Date().toISOString() },
      headers: { Authorization: `Bearer ${accessToken}` },
      timeout: 10000
    });
    return { status: 'success', policy: response.data };
  } catch (error) {
    return { status: 'error', message: error.response?.data?.error || error.message };
  }
}

module.exports = { checkCapturePolicy };
