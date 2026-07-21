// Spec B F2: Salesforce SSO login via the system browser (handoff §7 - the
// desktop never sees SF or Asymbl credentials directly, only the tokens the
// control plane mints after a real SF OAuth exchange).
//
// Flow: shell.openExternal to control-plane's /auth/sf/start, which redirects
// to Salesforce, which redirects back to the control plane's fixed callback
// (F7-R11), which 302s the system browser to this app's custom protocol
// (asymbl-recall://auth-callback?access_token=...) - handled by 'open-url'
// (macOS) or the second-instance argv (Windows/Linux, since a custom-protocol
// launch on those platforms starts a new process that Electron's single-
// instance lock redirects into the existing one).
const { app, shell } = require('electron');
const authStore = require('./auth-store');
const { CONTROL_PLANE_URL } = require('./control-plane-client');

const PROTOCOL = 'asymbl-recall';
const CALLBACK_HOST = 'auth-callback';

let pendingLoginResolvers = [];

function registerProtocolHandler() {
  if (process.defaultApp && process.argv.length >= 2) {
    app.setAsDefaultProtocolClient(PROTOCOL, process.execPath, [require('path').resolve(process.argv[1])]);
  } else {
    app.setAsDefaultProtocolClient(PROTOCOL);
  }
}

function handleCallbackUrl(callbackUrl) {
  let parsed;
  try {
    parsed = new URL(callbackUrl);
  } catch {
    return;
  }
  if (parsed.protocol !== `${PROTOCOL}:` || parsed.hostname !== CALLBACK_HOST) {
    return;
  }

  const error = parsed.searchParams.get('error');
  if (error) {
    settlePendingLogins({ status: 'error', error, lockedReason: parsed.searchParams.get('locked_reason') });
    return;
  }

  const accessToken = parsed.searchParams.get('access_token');
  const refreshToken = parsed.searchParams.get('refresh_token');
  if (!accessToken || !refreshToken) {
    settlePendingLogins({ status: 'error', error: 'missing_tokens' });
    return;
  }

  authStore.setTokens({ access_token: accessToken, refresh_token: refreshToken });
  settlePendingLogins({ status: 'success' });
}

function settlePendingLogins(result) {
  const resolvers = pendingLoginResolvers;
  pendingLoginResolvers = [];
  resolvers.forEach((resolve) => resolve(result));
}

/** Opens the system browser to start login. Resolves once the OS redirects back via the custom protocol, or after a timeout. */
function startLogin({ timeoutMs = 5 * 60 * 1000 } = {}) {
  const result = new Promise((resolve) => {
    pendingLoginResolvers.push(resolve);
    setTimeout(() => {
      if (pendingLoginResolvers.includes(resolve)) {
        pendingLoginResolvers = pendingLoginResolvers.filter((r) => r !== resolve);
        resolve({ status: 'error', error: 'timeout' });
      }
    }, timeoutMs);
  });

  const startUrl = `${CONTROL_PLANE_URL}/auth/sf/start?redirect_uri=${encodeURIComponent(`${PROTOCOL}://${CALLBACK_HOST}`)}`;
  shell.openExternal(startUrl);
  return result;
}

module.exports = { registerProtocolHandler, handleCallbackUrl, startLogin, PROTOCOL };
