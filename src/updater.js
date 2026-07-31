// Spec B F10 (Auto-Update and Telemetry) - F10-R1..R5.
// Uses Electron's built-in `autoUpdater`, not the separate `electron-updater`
// npm package - this fork already ships electron-squirrel-startup +
// maker-squirrel/maker-dmg (Squirrel.Windows / Squirrel.Mac), which is what
// Electron's native module targets; adding a second, different updater
// library for the same job would be redundant.
//
// [UNVERIFIED - real gap, not faked] `https://updates.asymbl-intelligence.com`
// doesn't exist - no update feed server has been stood up anywhere in this
// build. Electron's autoUpdater also requires signed builds on macOS/Windows
// to actually apply an update, and code-signing is explicitly DEFERRED
// (handoff §9). This wiring is real and will start working the moment both
// exist; until then `checkForUpdates()` will fail (network error reaching a
// nonexistent host), logged rather than silently swallowed.
const { autoUpdater } = require('electron');

let mainWindowRef = null;
let recordingActive = false;
let updatePending = false;

function initUpdater(mainWindow, channel = process.env.UPDATE_CHANNEL || 'staging') {
  mainWindowRef = mainWindow;

  if (process.platform === 'linux') {
    // Electron's autoUpdater has no Linux support at all (Squirrel is
    // Windows/Mac only) - the maker-deb/maker-rpm builds this fork already
    // produces have no update mechanism through this module.
    console.log('Auto-update not available on Linux - skipping autoUpdater setup.');
    return;
  }

  const feedUrl = `https://updates.asymbl-intelligence.com/desktop/${channel}`;
  try {
    autoUpdater.setFeedURL({ url: feedUrl });
  } catch (error) {
    console.error('Failed to set update feed URL:', error.message);
    return;
  }

  autoUpdater.on('update-available', () => {
    updatePending = true;
    maybeApplyOrNotify();
  });

  autoUpdater.on('error', (error) => {
    console.error('Updater error:', error.message);
  });

  checkForUpdates();
  setInterval(checkForUpdates, 4 * 60 * 60 * 1000); // F10-R2: every 4 hours
}

function checkForUpdates() {
  try {
    autoUpdater.checkForUpdates();
  } catch (error) {
    console.error('checkForUpdates failed:', error.message);
  }
}

/** Call this whenever a recording starts/ends (main.js) - F10-R4: never force-restart mid-recording. */
function setRecordingActive(active) {
  recordingActive = active;
  if (!active) {
    maybeApplyOrNotify();
  }
}

function maybeApplyOrNotify() {
  if (!updatePending || !mainWindowRef || mainWindowRef.isDestroyed()) {
    return;
  }
  // F10-R3: non-blocking banner either way - this build doesn't force
  // quitAndInstall() itself (that's a user/OS-level restart action with its
  // own risk), just surfaces the state change to the renderer.
  mainWindowRef.webContents.send('update-available', { queued: recordingActive });
}

module.exports = { initUpdater, setRecordingActive };
