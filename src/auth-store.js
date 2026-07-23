// Asymbl session storage. Spec: contracts/asymbl-jwt-claims.yaml,
// handoff §7 ("15-min access in-memory only; 7-day rolling refresh in
// keytar/safeStorage"). Access token NEVER touches disk - only refresh
// token is persisted, and only encrypted via Electron's safeStorage.
//
// [UNVERIFIED - blocked] Nothing calls setTokens() yet - the SF OAuth login
// flow (F7-R11 /auth/sf/start + /auth/sf/callback) that would populate this
// isn't built (blocked on a real Salesforce Connected App, see
// docs/BLOCKERS.md in the Recall delivery repo). This module exists so the
// rest of the app (control-plane-client.js) has a real seam to call once
// login exists, instead of every call site inventing its own token handling.
const { safeStorage } = require('electron');
const fs = require('fs');
const path = require('path');
const { app } = require('electron');

// T13 (eng review finding #2/#6): each OAuth provider gets its own in-memory
// slot and its own encrypted refresh-token file, keyed by `provider`. Before
// this, a single accessToken/refreshToken pair and one fixed file meant a
// second provider (Calendar, #21) reusing this module as-is would silently
// overwrite the SF session's tokens. Every existing call site omits
// `provider`, so it defaults to 'sf' - zero behavior change for SF login.
const tokens = {}; // provider -> { accessToken, refreshToken }
let photoDataUri = null;

function refreshTokenPath(provider) {
  return path.join(app.getPath('userData'), `refresh-token-${provider}.enc`);
}

// Pre-T13 builds stored the (only) provider's refresh token at this
// unnamespaced path. Only ever read as a one-time migration fallback below,
// never written to again.
function legacySfRefreshTokenPath() {
  return path.join(app.getPath('userData'), 'refresh-token.enc');
}

// Not a credential (a profile picture, already fetched fresh on every real
// login per control-plane's sf-oauth.ts), so a plain file is fine - no
// safeStorage encryption needed, unlike the refresh token above. Tied to the
// SF identity specifically (Calendar OAuth has no profile-photo concept), so
// this stays unnamespaced rather than keyed by provider.
function photoPath() {
  return path.join(app.getPath('userData'), 'profile-photo.txt');
}

function setTokens({ access_token, refresh_token, photo_data_uri }, provider = 'sf') {
  tokens[provider] = { accessToken: access_token, refreshToken: refresh_token };
  if (refresh_token && safeStorage.isEncryptionAvailable()) {
    const encrypted = safeStorage.encryptString(refresh_token);
    fs.writeFileSync(refreshTokenPath(provider), encrypted);
  }
  if (photo_data_uri) {
    photoDataUri = photo_data_uri;
    fs.writeFileSync(photoPath(), photo_data_uri, 'utf8');
  }
}

function getAccessToken(provider = 'sf') {
  return tokens[provider]?.accessToken ?? null;
}

function getPhotoDataUri() {
  if (photoDataUri) {
    return photoDataUri;
  }
  try {
    if (fs.existsSync(photoPath())) {
      photoDataUri = fs.readFileSync(photoPath(), 'utf8');
    }
  } catch (error) {
    console.error('Failed to load persisted profile photo:', error.message);
  }
  return photoDataUri;
}

function loadPersistedRefreshToken(provider = 'sf') {
  try {
    if (!safeStorage.isEncryptionAvailable()) {
      return null;
    }
    let tokenFilePath = refreshTokenPath(provider);
    if (!fs.existsSync(tokenFilePath) && provider === 'sf' && fs.existsSync(legacySfRefreshTokenPath())) {
      // One-time migration: move the pre-T13 unnamespaced file to the
      // namespaced path so this fallback is never needed again.
      const encrypted = fs.readFileSync(legacySfRefreshTokenPath());
      fs.writeFileSync(tokenFilePath, encrypted);
      fs.unlinkSync(legacySfRefreshTokenPath());
    }
    if (!fs.existsSync(tokenFilePath)) {
      return null;
    }
    const encrypted = fs.readFileSync(tokenFilePath);
    const refreshToken = safeStorage.decryptString(encrypted);
    tokens[provider] = { ...tokens[provider], refreshToken };
    return refreshToken;
  } catch (error) {
    console.error(`Failed to load persisted refresh token (${provider}):`, error.message);
    return null;
  }
}

function clearTokens(provider = 'sf') {
  delete tokens[provider];
  try {
    fs.unlinkSync(refreshTokenPath(provider));
  } catch {
    // no-op: file may not exist
  }
  if (provider === 'sf') {
    photoDataUri = null;
    try {
      fs.unlinkSync(photoPath());
    } catch (error) {
      if (error.code !== 'ENOENT') {
        console.error('Failed to remove persisted profile photo:', error.message);
      }
    }
  }
}

module.exports = { setTokens, getAccessToken, getPhotoDataUri, loadPersistedRefreshToken, clearTokens };
