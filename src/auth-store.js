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

let accessToken = null; // in-memory only, never written to disk
let refreshToken = null;
let photoDataUri = null;

function refreshTokenPath() {
  return path.join(app.getPath('userData'), 'refresh-token.enc');
}

// Not a credential (a profile picture, already fetched fresh on every real
// login per control-plane's sf-oauth.ts), so a plain file is fine - no
// safeStorage encryption needed, unlike the refresh token above.
function photoPath() {
  return path.join(app.getPath('userData'), 'profile-photo.txt');
}

function setTokens({ access_token, refresh_token, photo_data_uri }) {
  accessToken = access_token;
  refreshToken = refresh_token;
  if (refresh_token && safeStorage.isEncryptionAvailable()) {
    const encrypted = safeStorage.encryptString(refresh_token);
    fs.writeFileSync(refreshTokenPath(), encrypted);
  }
  if (photo_data_uri) {
    photoDataUri = photo_data_uri;
    fs.writeFileSync(photoPath(), photo_data_uri, 'utf8');
  }
}

function getAccessToken() {
  return accessToken;
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

function loadPersistedRefreshToken() {
  try {
    if (!safeStorage.isEncryptionAvailable() || !fs.existsSync(refreshTokenPath())) {
      return null;
    }
    const encrypted = fs.readFileSync(refreshTokenPath());
    refreshToken = safeStorage.decryptString(encrypted);
    return refreshToken;
  } catch (error) {
    console.error('Failed to load persisted refresh token:', error.message);
    return null;
  }
}

function clearTokens() {
  accessToken = null;
  refreshToken = null;
  photoDataUri = null;
  try {
    fs.unlinkSync(refreshTokenPath());
  } catch {
    // no-op: file may not exist
  }
  try {
    fs.unlinkSync(photoPath());
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.error('Failed to remove persisted profile photo:', error.message);
    }
  }
}

module.exports = { setTokens, getAccessToken, getPhotoDataUri, loadPersistedRefreshToken, clearTokens };
