require('dotenv').config();
// F10-R10: must run before other requires so startup crashes are captured too.
require('./crash-reporter').initCrashReporter();

const { app, BrowserWindow, ipcMain, protocol, Notification, globalShortcut, systemPreferences } = require('electron');
// electron-forge start (dev mode) runs the actual node_modules/electron
// binary, whose bundle identity is baked in as "Electron" before any of our
// code runs - the Dock hover-tooltip name comes from that, not from the
// window title. setName() must run as early as possible to have any chance
// of overriding it.
app.setName('Asymbl Recall');
const path = require('node:path');
const url = require('url');
const fs = require('fs');
const RecallAiSdk = require('@recallai/desktop-sdk');
const sdkLogger = require('./sdk-logger');
const controlPlaneClient = require('./control-plane-client');
const authStore = require('./auth-store');
const desktopAuth = require('./auth');
const capturePolicyClient = require('./capture-policy-client');
const notesSync = require('./notes-sync');
const updater = require('./updater');
const telemetry = require('./telemetry');
const tray = require('./tray');

let cachedTenantId = null; // set once fetchBootstrap succeeds (Spec B F10-R9's telemetry events carry tenant_id)

// Handle creating/removing shortcuts on Windows when installing/uninstalling.
if (require('electron-squirrel-startup')) {
  app.quit();
}

// Spec B F2: SF SSO login redirects back via a custom protocol
// (asymbl-recall://auth-callback). On Windows/Linux that launch is a new OS
// process; the single-instance lock hands its argv to the already-running
// instance instead of opening a second window.
desktopAuth.registerProtocolHandler();

const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    const callbackArg = argv.find((arg) => arg.startsWith(`${desktopAuth.PROTOCOL}://`));
    if (callbackArg) {
      desktopAuth.handleCallbackUrl(callbackArg);
    }
    if (mainWindow) {
      if (mainWindow.isMinimized()) {
        mainWindow.restore();
      }
      mainWindow.focus();
    }
  });
}

// macOS delivers the custom-protocol URL via 'open-url', not process.argv.
app.on('open-url', (event, receivedUrl) => {
  event.preventDefault();
  desktopAuth.handleCallbackUrl(receivedUrl);
});

// Store detected meeting information
let detectedMeeting = null;
// Screen 01: the tray's Stop-recording actions (popover button + native
// right-click menu item) need a windowId to call RecallAiSdk.stopRecording
// with, same as the renderer-driven stopManualRecording IPC handler - this
// app only ever has one active recording at a time, so a single tracked id
// (not a list) matches the existing activeRecordings model.
let currentRecordingWindowId = null;

const TRAY_LOCKED_MESSAGES = {
  package_not_installed: 'Your Salesforce org doesn’t have Recall installed. Contact your admin.',
  license_not_assigned: 'You don’t have a Recall license assigned yet. Contact your admin.',
  license_revoked: 'Your Recall license has been revoked. Contact your admin.',
};

let mainWindow;

const createWindow = () => {
  // Create the browser window.
  mainWindow = new BrowserWindow({
    width: 1024,
    height: 768,
    webPreferences: {
      preload: MAIN_WINDOW_PRELOAD_WEBPACK_ENTRY,
      contextIsolation: true,
      nodeIntegration: false,
      // Electron 36 already defaults both to these values - explicit here
      // per the electron-development skill's checklist (sickn33/
      // agentic-awesome-skills), so the security posture is self-documenting
      // rather than relying on an implicit default a future Electron
      // upgrade could silently change.
      sandbox: true,
      webSecurity: true,
    },
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#f9f9f9',
    title: 'Asymbl Recall',
  });

  // Allow the debug panel header to act as a drag region
  mainWindow.on('ready-to-show', () => {
    try {
      // Set regions that can be used to drag the window
      if (process.platform === 'darwin') {
        // Only needed on macOS
        mainWindow.setWindowButtonVisibility(true);
      }
    } catch (error) {
      console.error('Error setting drag regions:', error);
    }
  });

  // and load the index.html of the app.
  mainWindow.loadURL(MAIN_WINDOW_WEBPACK_ENTRY);

  // Open the DevTools in development
  if (process.env.NODE_ENV === 'development') {
    // mainWindow.webContents.openDevTools();
  }

  // Listen for navigation events
  ipcMain.on('navigate', (event, page) => {
    if (page === 'note-editor') {
      mainWindow.loadURL(MAIN_WINDOW_WEBPACK_ENTRY + '/../note-editor/index.html');
    } else if (page === 'home') {
      mainWindow.loadURL(MAIN_WINDOW_WEBPACK_ENTRY);
    }
  });
};

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.whenReady().then(() => {
  // electron-forge start (dev mode) doesn't apply forge.config.js's packaged
  // icon - that only takes effect on `make`/`package` builds. Set it
  // explicitly here too so the Dock shows real branding in dev, not the
  // stock Electron icon. __dirname resolves inside the webpack bundle
  // (.webpack/main/), which doesn't copy static assets - app.getAppPath()
  // (the project root in dev mode) is needed to find the real source file.
  if (process.platform === 'darwin' && app.dock) {
    try {
      // asymbl-icon.png is a flat square (used as-is for the in-app header
      // logo, where that's correct) - the Dock needs the macOS Big Sur+
      // squircle treatment (rounded shape + padding) or it renders as a hard
      // square next to every other app's rounded icon (real bug found via a
      // live screenshot, 2026-07-23). asymbl-icon-macos.png is that same
      // mark pre-shaped into the squircle, generated once via
      // scripts/gen-macos-icon.py - same asset asymbl.icns is built from.
      app.dock.setIcon(path.join(app.getAppPath(), 'src', 'assets', 'asymbl-icon-macos.png'));
    } catch (error) {
      console.error('Failed to set dock icon:', error.message);
    }
  }

  console.log("Registering IPC handlers...");
  // Log all registered IPC handlers
  console.log("IPC handlers:", Object.keys(ipcMain._invokeHandlers));

  // Spec B F2: SF SSO login
  ipcMain.handle('startLogin', async () => {
    const result = await desktopAuth.startLogin();
    if (result.status === 'error' && result.error === 'license_inactive') {
      tray.setLocked(TRAY_LOCKED_MESSAGES[result.lockedReason] || 'Your Recall license needs attention. Contact your admin.');
    }
    refreshTrayAuthState();
    return result;
  });
  ipcMain.handle('getAuthStatus', async () => {
    const signedIn = !!authStore.getAccessToken() || !!authStore.loadPersistedRefreshToken();
    // The JWT contract (contracts/asymbl-jwt-claims.yaml) only carries
    // `email`, no display name or photo - decoding client-side is fine here
    // since this is display-only, not a trust boundary (every real API call
    // is verified server-side regardless of what the UI shows).
    let email = null;
    // sf_org (18-char org ID) is always present; sf_org_name is best-effort
    // (control-plane's fetchOrganizationName) - most recruiter profiles lack
    // "View Setup and Configuration", so this is commonly null. Renderer
    // falls back to showing just the org ID when it is.
    let orgId = null;
    let orgName = null;
    const accessToken = authStore.getAccessToken();
    if (accessToken) {
      try {
        const payload = JSON.parse(Buffer.from(accessToken.split('.')[1], 'base64url').toString('utf-8'));
        email = payload.email ?? null;
        orgId = payload.sf_org ?? null;
        orgName = payload.sf_org_name ?? null;
      } catch (error) {
        console.error('Failed to decode access token for display:', error.message);
      }
    }
    // Real SF profile photo (task: was initials-only) - fetched fresh on
    // every login by control-plane (sf-oauth.ts), persisted here, falls
    // back to null (renderer shows initials) if the SF user has none set.
    const photoDataUri = authStore.getPhotoDataUri();
    return { signedIn, email, photoDataUri, orgId, orgName };
  });
  ipcMain.handle('signOut', async () => {
    authStore.clearTokens();
    refreshTrayAuthState();
  });

  // Spec B F3: token refresh + heartbeat. Access tokens are a 15-min TTL
  // (F7-R2) - refresh well before that so a call mid-meeting never hits an
  // expired token. Also runs once at startup so a persisted refresh token
  // from a previous session becomes a live access token again immediately.
  const runSessionRefresh = () => {
    if (!authStore.loadPersistedRefreshToken()) {
      return;
    }
    controlPlaneClient.refreshSession().then((result) => {
      if (result.status !== 'success') {
        console.error('Session refresh failed:', result.message);
        return;
      }
      // Spec B F10-R11: telemetry_enabled is a bootstrap field, not baked in
      // at build time like the API key - only known once signed in.
      controlPlaneClient.fetchBootstrap().then((bootstrapResult) => {
        if (bootstrapResult.status !== 'success') {
          return;
        }
        cachedTenantId = bootstrapResult.bootstrap.user.tenant_id;
        telemetry.initTelemetry(process.env.POSTHOG_API_KEY, bootstrapResult.bootstrap.tenant.features.telemetry_enabled);
      });

      // Real bug found via live testing, 2026-07-23: refreshNextEvent() and
      // refreshTodaySchedule() below both fire immediately at startup, in
      // the same tick as this function's own call - but this refresh is
      // async, so on every fresh app launch (persisted refresh token, no
      // live in-memory access token yet) their authStore.getAccessToken()
      // check loses the race and sees null, silently no-opping. Schedule
      // data then only ever arrived on the next 5-min interval tick, making
      // a freshly-launched, genuinely-signed-in app show "Nothing
      // scheduled" for up to 5 minutes even with real events waiting.
      // Calling them here too - once the token is confirmed fresh - closes
      // that gap; the pre-existing immediate calls + intervals are unaffected.
      refreshNextEvent();
      refreshTodaySchedule();
      // Same race as above, for the account-menu email: preload.js already
      // declared 'auth-status-changed' and renderer.js already listens for
      // it (calls refreshAuthUi()), but nothing ever fired it - the email
      // decode in getAuthStatus() only has a token to read once this
      // resolves, so a fresh launch's earlier DOMContentLoaded call to
      // refreshAuthUi() always saw signedIn=true (persisted refresh token)
      // but email=null, and nothing re-asked. Real gap found via user
      // testing 2026-07-23 (account dropdown showed a blank row above
      // "Sign out").
      mainWindow.webContents.send('auth-status-changed');
    });
  };
  runSessionRefresh();
  setInterval(runSessionRefresh, 10 * 60 * 1000);

  // Screen 01: tray reflects real sign-in state (isSignedIn signal, same as
  // the header toggle screen 00 uses) - no display name exists in the JWT
  // contract (bootstrap.ts's BootstrapResult.user has no `name` field),
  // so email is the identity string shown in the popover footer, same
  // fallback the main window's user-avatar tooltip already uses.
  function refreshTrayAuthState() {
    const signedIn = !!authStore.getAccessToken() || !!authStore.loadPersistedRefreshToken();
    if (!signedIn) {
      tray.setSignedIn(false, null);
      return;
    }
    const accessToken = authStore.getAccessToken();
    let email = null;
    if (accessToken) {
      try {
        email = JSON.parse(Buffer.from(accessToken.split('.')[1], 'base64url').toString('utf-8')).email ?? null;
      } catch {
        // display-only, same non-fatal handling as getAuthStatus above
      }
    }
    tray.setSignedIn(true, { name: email || 'Signed in', org: '' });
  }
  refreshTrayAuthState();

  // Screen 01: "Next on calendar" card - polls the control plane's real SF
  // Event feed (next-event.ts) rather than push, since there's no existing
  // push channel for calendar data. 5 min cadence balances freshness against
  // the pre-meeting state's 15-min countdown window (spec §2) - a 5 min-old
  // read is never off by more than one bucket of that window.
  function refreshNextEvent() {
    if (!authStore.getAccessToken()) {
      return;
    }
    controlPlaneClient.fetchNextEvent().then((result) => {
      if (result.status === 'success') {
        tray.setNextEvent(result.nextEvent);
      }
    });
  }
  refreshNextEvent();
  setInterval(refreshNextEvent, 5 * 60 * 1000);

  // Screen 02 (Home/Today, docs/screen-specs/02-home-today.md §2.4) -
  // "Today's schedule" list, same real SF Event source and 5-min cadence as
  // the tray's next-event poll above, just bounded to the rest of today
  // instead of a single row. Pushed to the renderer (not polled from there)
  // since main already holds the access token and the polling interval.
  function refreshTodaySchedule() {
    if (!authStore.getAccessToken()) {
      return;
    }
    controlPlaneClient.fetchTodaySchedule().then((result) => {
      if (result.status === 'success' && mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('today-schedule-updated', result.schedule);
      }
    });
  }
  refreshTodaySchedule();
  setInterval(refreshTodaySchedule, 5 * 60 * 1000);

  // Set up SDK logger IPC handlers
  ipcMain.on('sdk-log', (event, logEntry) => {
    // Forward logs from renderer to any open windows
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('sdk-log', logEntry);
    }
  });

  // Set up logger event listener to send logs from main to renderer
  sdkLogger.onLog((logEntry) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('sdk-log', logEntry);
    }
  });

  // Create meetings file if it doesn't exist
  try {
    if (!fs.existsSync(meetingsFilePath)) {
      const initialData = { upcomingMeetings: [], pastMeetings: [] };
      fs.writeFileSync(meetingsFilePath, JSON.stringify(initialData, null, 2));
    }
  } catch (e) {
    console.error("Couldn't create the meetings file:", e);
  }

  // Initialize the Recall.ai SDK
  initSDK();

  createWindow();
  updater.initUpdater(mainWindow);

  // Named so both the tray popover's click handlers AND the real global
  // keyboard shortcuts below call the exact same function - spec §5 lists
  // "P3 unscheduled call via ⌘N" as a real scenario, not decorative hint
  // text, and until now no shortcut was actually registered (found via
  // direct question, 2026-07-23: the popover only ever showed "⌘N" as a
  // <span>, Cmd+N did nothing anywhere in the OS).
  //
  // createNewMeeting() (renderer.js) already both creates the note AND
  // auto-starts manual recording on it (renderer.js:790-821) - re-verified
  // this directly rather than assuming, since the label ("start a call")
  // implies both steps.
  const startUnscheduledCallAction = () => {
    focusMainWindowFromTray();
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('trigger-new-note');
    }
  };
  const openLibraryAction = () => focusMainWindowFromTray();
  const openSettingsAction = () => focusMainWindowFromTray();

  tray.initTray(mainWindow, {
    signIn: async () => {
      const result = await desktopAuth.startLogin();
      if (result.status === 'error' && result.error === 'license_inactive') {
        tray.setLocked(TRAY_LOCKED_MESSAGES[result.lockedReason] || 'Your Recall license needs attention. Contact your admin.');
      }
      refreshTrayAuthState();
      refreshNextEvent();
      refreshTodaySchedule();
    },
    stopRecording: async () => {
      if (!currentRecordingWindowId) return;
      try {
        await stopActiveRecording(currentRecordingWindowId);
      } catch (error) {
        console.error('Error stopping recording from tray:', error);
      }
    },
    // openPreBrief/skip: the design's "Open Pre-Brief" implies the
    // contracted Pre-Brief API (prebrief-api.yaml) - full LLM generation is
    // separately-tracked scope (#22/#23), not built here. Both actions
    // focus the main window rather than open a dead/fake control, since
    // no Pre-Brief window exists yet to route to.
    openPreBrief: () => focusMainWindowFromTray(),
    skip: () => {},
    startUnscheduledCall: startUnscheduledCallAction,
    openLibrary: openLibraryAction,
    openSettings: openSettingsAction,
    // Recording card's "Open window" - same action as clicking the tray
    // icon itself while recording (focus the main window with the live
    // note/transcript, not a separate window that doesn't exist).
    openWindow: () => focusMainWindowFromTray(),
    // Meeting-detected card's "Start capture" - reuses the exact same
    // main-process function the existing desktop-notification "Record"
    // action already calls (main.js's notification.on('action', ...)),
    // rather than duplicating that join logic a third time.
    joinDetected: () => joinDetectedMeeting(),
  });

  function focusMainWindowFromTray() {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }

  // Real OS-level global shortcuts (spec §3/§5: "P3 unscheduled call via
  // ⌘N" is a stated scenario, not decorative hint text) - registered once
  // at startup, unregistered on quit (app.on('will-quit') below). These
  // call the exact same functions the popover's rows call, so behavior
  // never diverges between clicking and pressing the key.
  // register() fails SILENTLY (returns false, doesn't throw) if another
  // app already holds that combo - Cmd+, in particular is an extremely
  // common OS-wide "Preferences" binding other native Mac apps grab first,
  // so silently trusting registration here would be a real, invisible gap.
  [
    ['CommandOrControl+N', startUnscheduledCallAction],
    ['CommandOrControl+L', openLibraryAction],
    ['CommandOrControl+,', openSettingsAction],
  ].forEach(([accelerator, action]) => {
    const ok = globalShortcut.register(accelerator, action);
    if (!ok) {
      console.error(`Failed to register global shortcut ${accelerator} - likely already claimed by another app`);
    }
  });

  // When the window is ready, send the initial meeting detection status
  mainWindow.webContents.on('did-finish-load', () => {
    // Send the initial meeting detection status
    mainWindow.webContents.send('meeting-detection-status', { detected: detectedMeeting !== null, platformName: detectedMeeting?.window?.platform || null });
  });

  // On OS X it's common to re-create a window in the app when the
  // dock icon is clicked and there are no other windows open.
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  telemetry.shutdownTelemetry().catch(() => {});
});

app.on('will-quit', () => {
  // Electron's own documented pattern - global shortcuts are OS-level and
  // outlive the app otherwise.
  globalShortcut.unregisterAll();
});

// In this file you can include the rest of your app's specific main process
// code. You can also put them in separate files and import them here.

// Path to meetings data file in the user's Application Support directory
const meetingsFilePath = path.join(app.getPath('userData'), 'meetings.json');

// Global state to track active recordings
const activeRecordings = {
  // Map of recordingId -> {noteId, platform, state}
  recordings: {},

  // Register a new recording. startTime is optional (defaults to now) so
  // the two other call sites (main.js:1222,1429) are unaffected - only the
  // 'recording-started' SDK handler passes one explicitly, to share the
  // exact same timestamp it also gives tray.js rather than each capturing
  // its own Date.now() a few ticks apart (TODOS.md #13, fixed 2026-07-23).
  addRecording: function (recordingId, noteId, platform = 'unknown', startTime = new Date()) {
    this.recordings[recordingId] = {
      noteId,
      platform,
      state: 'recording',
      startTime
    };
    console.log(`Recording registered in global state: ${recordingId} for note ${noteId}`);
  },

  // Update a recording's state
  updateState: function (recordingId, state) {
    if (this.recordings[recordingId]) {
      this.recordings[recordingId].state = state;
      console.log(`Recording ${recordingId} state updated to: ${state}`);
      return true;
    }
    return false;
  },

  // Remove a recording
  removeRecording: function (recordingId) {
    if (this.recordings[recordingId]) {
      delete this.recordings[recordingId];
      console.log(`Recording ${recordingId} removed from global state`);
      return true;
    }
    return false;
  },

  // Get active recording for a note
  getForNote: function (noteId) {
    for (const [recordingId, info] of Object.entries(this.recordings)) {
      if (info.noteId === noteId) {
        return { recordingId, ...info };
      }
    }
    return null;
  },

  // Get all active recordings
  getAll: function () {
    return { ...this.recordings };
  }
};

// File operation manager to prevent race conditions on both reads and writes
const fileOperationManager = {
  isProcessing: false,
  pendingOperations: [],
  cachedData: null,
  lastReadTime: 0,

  // Read the meetings data with caching to reduce file I/O
  readMeetingsData: async function () {
    // If we have cached data that's recent (less than 500ms old), use it
    const now = Date.now();
    if (this.cachedData && (now - this.lastReadTime < 500)) {
      return JSON.parse(JSON.stringify(this.cachedData)); // Deep clone
    }

    try {
      // Read from file
      const fileData = await fs.promises.readFile(meetingsFilePath, 'utf8');
      const data = JSON.parse(fileData);

      // Update cache
      this.cachedData = data;
      this.lastReadTime = now;

      return data;
    } catch (error) {
      console.error('Error reading meetings data:', error);
      // If file doesn't exist or is invalid, return empty structure
      return { upcomingMeetings: [], pastMeetings: [] };
    }
  },

  // Schedule an operation that needs to update the meetings data
  scheduleOperation: async function (operationFn) {
    return new Promise((resolve, reject) => {
      // Add this operation to the queue
      this.pendingOperations.push({
        operationFn, // This function will receive the current data and return updated data
        resolve,
        reject
      });

      // Process the queue if not already processing
      if (!this.isProcessing) {
        this.processQueue();
      }
    });
  },

  // Process the operation queue sequentially
  processQueue: async function () {
    if (this.pendingOperations.length === 0 || this.isProcessing) {
      return;
    }

    this.isProcessing = true;

    try {
      // Get the next operation
      const nextOp = this.pendingOperations.shift();

      // Read the latest data
      const currentData = await this.readMeetingsData();

      try {
        // Execute the operation function with the current data
        const updatedData = await nextOp.operationFn(currentData);

        // If the operation returned data, write it
        if (updatedData) {
          // Update cache immediately
          this.cachedData = updatedData;
          this.lastReadTime = Date.now();

          // Write to file
          await fs.promises.writeFile(meetingsFilePath, JSON.stringify(updatedData, null, 2));
        }

        // Resolve the operation's promise
        nextOp.resolve({ success: true });
      } catch (opError) {
        console.error('Error in file operation:', opError);
        nextOp.reject(opError);
      }
    } catch (error) {
      console.error('Error in file operation manager:', error);

      // If there was an operation that failed, reject its promise
      if (this.pendingOperations.length > 0) {
        const failedOp = this.pendingOperations.shift();
        failedOp.reject(error);
      }
    } finally {
      this.isProcessing = false;

      // Check if more operations were added while we were processing
      if (this.pendingOperations.length > 0) {
        setImmediate(() => this.processQueue());
      }
    }
  }
};

// Real bug found via live testing (2026-07-22): writeData(data) unconditionally
// overwrites the file with whatever blob the caller already had in memory -
// callers that read the file once at the top of a long-running handler
// (SDK calls, network requests in between) and write much later can silently
// clobber any other write (autosave, transcript processing) that landed in
// the gap, since writeData never looks at what's actually on disk/cached.
// This routes the read-mutate-write through the queue's own fresh read
// instead, so a mutation is always applied to the latest state, not a stale
// snapshot - confirmed live: meeting.recordingId was set and "saved" via
// writeData(), but ended up null on disk because another write landed first.
async function updateMeetingById(meetingId, mutatorFn) {
  // scheduleOperation's own promise resolves to {success: true} regardless
  // of whether a meeting was found (it's reporting "the write happened",
  // not "the meeting existed") - callers need to know the latter, so track
  // it via a closure variable set inside the operation instead.
  let found = null;
  await fileOperationManager.scheduleOperation(async (currentData) => {
    const meeting = currentData.pastMeetings.find((m) => m.id === meetingId);
    if (meeting) {
      await mutatorFn(meeting, currentData);
      found = meeting;
    } else {
      console.log(`updateMeetingById: no meeting found with ID ${meetingId}`);
    }
    return currentData;
  });
  return found;
}

// Create a desktop SDK upload token via the control plane (F9). Previously
// called a local Express server (deleted, src/server.js) that held the
// Recall API key directly on the desktop.
//
// decisionToken/interviewId come from the F5 capture-policy check
// (createMeetingNoteAndRecord) when one was run; callers with no detected
// meeting (post-recording upload refresh, manual in-person recording) pass
// nothing, same as before this was wired up.
async function createDesktopSdkUpload(decisionToken = null, interviewId = null) {
  const result = await controlPlaneClient.createDesktopSdkUpload(decisionToken, interviewId);
  if (result.status !== 'success') {
    console.error("Failed to create upload token:", result.message);
    // Real bug found via live use: this used to return null on any failure,
    // discarding the real reason (e.g. "Not signed in..." from a stale
    // persisted refresh token that *looked* signed-in in the UI until this
    // actual API call ran) - callers had no way to show anything but a
    // generic "Failed to create recording token".
    return { error: result.message };
  }
  console.log("Upload token created successfully:", result.upload_token);
  return result;
}

// Spec B F6: finalize the session tracked for this window (see the
// sessionId/recordingStartedAt stored in createMeetingNoteAndRecord). No-ops
// if this window's recording never got a session_id - e.g. capture-policy
// blocked it, or the upload-token call failed and recording proceeded
// without one (see createMeetingNoteAndRecord's fallback path).
async function finalizeDesktopRecordingSession(windowId) {
  const tracked = global.activeMeetingIds?.[windowId];
  if (!tracked?.sessionId) {
    return;
  }

  // meeting.transcript entries only carry an absolute ISO timestamp (see
  // processTranscriptData) - approximated to relative ms here since that's
  // all extraction's merge/offset logic needs a coarse ordering for, not
  // millisecond-accurate sync with the bot's transcript.
  let utterances = [];
  try {
    const fileData = await fs.promises.readFile(meetingsFilePath, 'utf8');
    const meetingsData = JSON.parse(fileData);
    const meeting = meetingsData.pastMeetings.find((m) => m.id === tracked.noteId);
    const startedAt = tracked.recordingStartedAt || Date.now();
    utterances = (meeting?.transcript || []).map((t) => ({
      speaker: t.speaker,
      start_ms: Math.max(0, new Date(t.timestamp).getTime() - startedAt),
      end_ms: Math.max(0, new Date(t.timestamp).getTime() - startedAt),
      text: t.text
    }));
  } catch (error) {
    console.error('Error reading transcript for session finalize:', error.message);
  }

  const durationS = tracked.recordingStartedAt ? Math.round((Date.now() - tracked.recordingStartedAt) / 1000) : 0;

  // Screen 02 (Home/Today §2.5/§2.7) needs a real per-meeting duration for
  // "Recent captures" and the "hours recorded" stat - durationS above was
  // previously only sent to telemetry, never persisted onto the meeting
  // record itself. Uses the same scheduleOperation queue as every other
  // meetings.json write (T14's race fix), not a direct fs write.
  fileOperationManager.scheduleOperation((data) => {
    const meeting = data.pastMeetings.find((m) => m.id === tracked.noteId);
    if (meeting) {
      meeting.duration_s = durationS;
    }
    return data;
  }).catch((error) => console.error('Error persisting duration_s onto meeting record:', error.message));

  const result = await controlPlaneClient.finalizeDesktopSession(tracked.sessionId, {
    endedAt: new Date().toISOString(),
    finalSeconds: durationS,
    transcriptArtifacts: utterances.length ? [{ type: 'utterances', url_or_payload: utterances }] : []
  });
  if (result.status !== 'success') {
    console.error('Failed to finalize desktop session:', result.message);
  } else {
    console.log('Finalized desktop session:', tracked.sessionId, result.result);
  }

  // F10-R9: PII-free usage event - exactly the allowed field set, nothing else.
  telemetry.captureEvent('desktop_recording_finalized', cachedTenantId, {
    session_id: tracked.sessionId,
    decision: tracked.policyDecision,
    platform: tracked.platformName,
    duration_s: durationS,
  });
}

// Initialize the Recall.ai SDK
function initSDK() {
  console.log("Initializing Recall.ai SDK");

  // Real bug found via a live test run: with no .env file present (only
  // .env.example is committed), process.env.RECALLAI_API_URL was undefined,
  // so the SDK fell back to its own default (api.recall.ai) - a different
  // region than control-plane's RECALL_REGION_BASE (us-west-2.recall.ai)
  // used to mint upload tokens. A token minted in one region is rejected
  // as "invalid upload token" when the SDK tries to start recording against
  // a different one. Same fallback pattern control-plane-client.js already
  // uses for CONTROL_PLANE_URL, so this can't silently regress if .env is
  // ever missing again.
  const recallApiUrl = process.env.RECALLAI_API_URL || 'https://us-west-2.recall.ai';

  // Log the SDK initialization
  sdkLogger.logApiCall('init', {
    dev: process.env.NODE_ENV === 'development',
    api_url: recallApiUrl
  });

  RecallAiSdk.init({
    // dev: true,
    api_url: recallApiUrl
  });

  // Listen for meeting detected events
  RecallAiSdk.addEventListener('meeting-detected', (evt) => {
    console.log("Meeting detected:", evt);

    // Log the meeting detected event
    sdkLogger.logEvent('meeting-detected', {
      platform: evt.window.platform,
      windowId: evt.window.id
    });

    detectedMeeting = evt;
    tray.setMeetingDetected(true, evt.window.platform);

    // Map platform codes to readable names
    const platformNames = {
      'zoom': 'Zoom',
      'google-meet': 'Google Meet',
      'slack': 'Slack',
      'teams': 'Microsoft Teams'
    };

    // Get a user-friendly platform name, or use the raw platform name if not in our map
    const platformName = platformNames[evt.window.platform] || evt.window.platform;

    // Granola-style prompt: click the notification (or its Record action,
    // macOS-only - Electron doesn't render notification action buttons on
    // Windows/Linux, so the click-anywhere handler below is the reliable
    // cross-platform path either way) to open the app and start recording
    // immediately, same as clicking the "Record Meeting" button by hand.
    let notification = new Notification({
      title: 'Start recording this meeting?',
      body: `${platformName} meeting detected — click to record`,
      actions: [{ type: 'button', text: 'Record' }]
    });

    notification.on('click', () => {
      console.log("Notification clicked for platform:", platformName);
      joinDetectedMeeting();
    });
    notification.on('action', () => {
      console.log("Notification 'Record' action clicked for platform:", platformName);
      joinDetectedMeeting();
    });

    notification.show();

    // Send the meeting detected status to the renderer process
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('meeting-detection-status', { detected: true, platformName });
    }
  });

  // Listen for meeting updated events (to capture title and URL)
  // NOTE: meeting-detected events do NOT guarantee title and URL will be populated.
  // The meeting title and URL are only reliably available in meeting-updated events,
  // which fire as the meeting metadata becomes available after initial detection.
  RecallAiSdk.addEventListener('meeting-updated', async (evt) => {
    console.log("Meeting updated:", evt);

    const { window } = evt;

    // Log the meeting updated event with the URL for tracking purposes
    sdkLogger.logEvent('meeting-updated', {
      platform: window.platform,
      windowId: window.id,
      title: window.title,
      url: window.url
    });

    // Update the detectedMeeting object with the new information
    if (detectedMeeting && detectedMeeting.window.id === window.id) {
      detectedMeeting = {
        ...detectedMeeting,
        window: {
          ...detectedMeeting.window,
          title: window.title,
          url: window.url
        }
      };

      console.log("Updated meeting title:", window.title);

      // If a note has already been created for this meeting, update its title retroactively
      if (window.title && global.activeMeetingIds && global.activeMeetingIds[window.id]) {
        const noteId = global.activeMeetingIds[window.id].noteId;

        if (noteId) {
          console.log("Updating existing note title for:", noteId);

          try {
            let oldTitle;
            const meeting = await updateMeetingById(noteId, (m) => {
              oldTitle = m.title;
              m.title = window.title;
            });

            if (meeting) {
              console.log(`Successfully updated meeting title from "${oldTitle}" to "${window.title}"`);

              // Notify the renderer to update the UI
              if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('meeting-title-updated', {
                  meetingId: noteId,
                  newTitle: window.title
                });
              }
            } else {
              console.error("Meeting not found in pastMeetings with ID:", noteId);
            }
          } catch (error) {
            console.error("Error updating meeting title:", error);
          }
        }
      }
    }
  });

  // Listen for meeting closed events
  RecallAiSdk.addEventListener('meeting-closed', (evt) => {
    console.log("Meeting closed:", evt);

    // Log the SDK meeting-closed event
    sdkLogger.logEvent('meeting-closed', {
      windowId: evt.window.id
    });

    // Clean up the global tracking when a meeting ends
    if (evt.window && evt.window.id && global.activeMeetingIds && global.activeMeetingIds[evt.window.id]) {
      console.log(`Cleaning up meeting tracking for: ${evt.window.id}`);
      delete global.activeMeetingIds[evt.window.id];
    }

    detectedMeeting = null;
    tray.setMeetingDetected(false);

    // Send the meeting closed status to the renderer process
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('meeting-detection-status', { detected: false, platformName: null });
    }
  });

  // Listen for recording ended events
  RecallAiSdk.addEventListener('recording-ended', async (evt) => {
    console.log("Recording ended:", evt);

    // Log the SDK recording-ended event
    sdkLogger.logEvent('recording-ended', {
      windowId: evt.window.id
    });

    try {
      // Update the note with recording information
      await updateNoteWithRecordingInfo(evt.window.id);

      // Add a small delay before uploading (good practice for file system operations)
      setTimeout(async () => {
        try {
          // Try to get a new upload token for the upload if needed
          const uploadData = await createDesktopSdkUpload();

          if (uploadData && uploadData.upload_token) {
            console.log('Uploading recording with new upload token:', uploadData.upload_token);

            // Log the uploadRecording API call
            sdkLogger.logApiCall('uploadRecording', {
              windowId: evt.window.id,
              uploadToken: `${uploadData.upload_token.substring(0, 8)}...` // Log truncated token for security
            });

            await RecallAiSdk.uploadRecording({
              windowId: evt.window.id,
              uploadToken: uploadData.upload_token
            });
          } else {
            // Fallback to regular upload
            console.log('Uploading recording without new token');

            // Log the uploadRecording API call (fallback)
            sdkLogger.logApiCall('uploadRecording', {
              windowId: evt.window.id
            });

            await RecallAiSdk.uploadRecording({ windowId: evt.window.id });
          }
        } catch (uploadError) {
          console.error('Error during upload:', uploadError);
          // Fallback to regular upload

          // Log the uploadRecording API call (error fallback)
          sdkLogger.logApiCall('uploadRecording', {
            windowId: evt.window.id,
            error: 'Fallback after error'
          });

          await RecallAiSdk.uploadRecording({ windowId: evt.window.id });
        }
      }, 3000); // Wait 3 seconds before uploading

      await finalizeDesktopRecordingSession(evt.window.id);
    } catch (error) {
      console.error("Error handling recording ended:", error);
    }
  });

  RecallAiSdk.addEventListener('permissions-granted', async (evt) => {
    console.log("PERMISSIONS GRANTED");
  });

  // Track upload progress
  RecallAiSdk.addEventListener('upload-progress', async (evt) => {
    const { progress, window } = evt;
    console.log(`Upload progress: ${progress}%`);

    // Log the SDK upload-progress event
    // sdkLogger.logEvent('upload-progress', {
    //   windowId: window.id,
    //   progress
    // });

    tray.setUploadProgress(progress);
    // Update the note with upload progress if needed
    if (progress === 100) {
      console.log(`Upload completed for recording: ${window.id}`);
      // Could update the note here with upload completion status
    }
  });

  RecallAiSdk.addEventListener('recording-started', async evt => {
    const { window } = evt;
    if (!window || !window.id) {
      return;
    }

    let noteId = null;
    if (global.activeMeetingIds && global.activeMeetingIds[window.id]) {
      noteId = global.activeMeetingIds[window.id].noteId;
    }

    console.log("Recording started for window:", window.id);
    // One timestamp, shared - not two independent Date.now() captures a
    // few JS ticks apart (TODOS.md #13, fixed 2026-07-23).
    const startedAtMs = Date.now();
    if (noteId) {
      activeRecordings.addRecording(window.id, noteId, window.platform || 'unknown', new Date(startedAtMs));
    }
    updater.setRecordingActive(true); // F10-R4: never force-restart mid-recording
    currentRecordingWindowId = window.id;
    tray.setRecordingActive(true, { platform: window.platform || 'unknown', startedAt: startedAtMs });

    // Screen 02b (Home while recording, docs/screen-specs/02-home-today.md
    // §3) - 'recording-state-change' was already declared in preload.js and
    // listened for in renderer.js, but main.js never actually sent it (dead
    // channel). Home's live strip needs the meeting title too, not just
    // noteId/state, so this is a real payload rather than reusing the
    // existing note-editor-only shape as-is.
    if (mainWindow && !mainWindow.isDestroyed()) {
      const data = await fileOperationManager.readMeetingsData();
      const meeting = noteId ? data.pastMeetings.find((m) => m.id === noteId) : null;
      mainWindow.webContents.send('recording-state-change', {
        noteId,
        state: 'recording',
        recordingId: window.id,
        startedAt: startedAtMs,
        title: meeting?.title || 'Recording',
      });
    }
  });

  RecallAiSdk.addEventListener('recording-ended', async evt => {
    const { window } = evt;
    if (!window || !window.id) {
      return;
    }

    console.log("Recording stopped for window:", window.id);
    const noteId = global.activeMeetingIds?.[window.id]?.noteId || null;
    activeRecordings.removeRecording(window.id);
    updater.setRecordingActive(false);
    currentRecordingWindowId = null;
    tray.setRecordingActive(false);

    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('recording-state-change', { noteId, state: 'ended', recordingId: window.id });
    }
  });

  // Listen for real-time transcript events
  RecallAiSdk.addEventListener('realtime-event', async (evt) => {
    // Only log non-video frame events to prevent flooding the logger
    if (evt.event !== 'video_separate_png.data') {
      console.log("Received realtime event:", evt.event);

      // Log the SDK realtime-event event
      sdkLogger.logEvent('realtime-event', {
        eventType: evt.event,
        windowId: evt.window?.id
      });
    }

    // Handle different event types
    if (evt.event === 'transcript.data' && evt.data && evt.data.data) {
      await processTranscriptData(evt);
    }
    else if (evt.event === 'transcript.provider_data' && evt.data && evt.data.data) {
      await processTranscriptProviderData(evt);
    }
    else if (evt.event === 'participant_events.join' && evt.data && evt.data.data) {
      await processParticipantJoin(evt);
    }
    else if (evt.event === 'video_separate_png.data' && evt.data && evt.data.data) {
      await processVideoFrame(evt);
    }
  });

  // Handle errors
  RecallAiSdk.addEventListener('error', async (evt) => {
    console.error("RecallAI SDK Error:", evt);
    const { type, message } = evt;

    // Log the SDK error event
    sdkLogger.logEvent('error', {
      errorType: type,
      errorMessage: message
    });

    // Show notification for errors
    let notification = new Notification({
      title: 'Recording Error',
      body: `Error: ${type} - ${message}`
    });
    notification.show();
  });
}

// Handle saving meetings data
ipcMain.handle('saveMeetingsData', async (event, data) => {
  try {
    // Merge by explicit field ownership against the freshest disk state,
    // rather than overwriting the whole file with the renderer's copy.
    // CodeRabbit caught a real flaw in the first version of this fix:
    // Object.assign(fresh, incoming) copies EVERY key incoming has,
    // including stale-but-present ones (e.g. the renderer's local
    // `transcript` array, loaded before a concurrent main-process
    // transcript update landed) - silently regressing data the renderer
    // never intended to touch. The renderer's own save flows
    // (saveCurrentNote, new-note creation) only ever set `title`/`content`
    // - everything else (transcript, recordingId, notesSessionId,
    // recallRecordingId, hasSummary, recordingComplete, ...) is
    // main-process-owned and must survive untouched. Deletion goes through
    // the dedicated deleteMeeting handler, not this one, so a fresh-only
    // meeting (created concurrently, e.g. by an auto-detected-meeting
    // handler, after the renderer's snapshot) is preserved rather than
    // dropped for not appearing in the renderer's list.
    await fileOperationManager.scheduleOperation(async (currentData) => {
      for (const listKey of ['pastMeetings', 'upcomingMeetings']) {
        const incomingList = data[listKey] || [];
        const freshList = currentData[listKey] || [];
        const freshById = new Map(freshList.map((m) => [m.id, m]));

        for (const incoming of incomingList) {
          const fresh = freshById.get(incoming.id);
          if (fresh) {
            if (incoming.title !== undefined) fresh.title = incoming.title;
            if (incoming.content !== undefined) fresh.content = incoming.content;
          } else {
            freshList.push(incoming);
          }
        }
        currentData[listKey] = freshList;
      }
      return currentData;
    });

    // Spec B F8: fire-and-forget sync of every meeting with a
    // notesSessionId, on every save. Not diffed against the last-synced
    // content (this handler gets the whole meetings list, not just what
    // changed) - the server's append is idempotent by block_id, so a
    // redundant re-sync of unchanged notes is harmless, just an extra call.
    for (const meeting of data.pastMeetings || []) {
      if (meeting.notesSessionId && meeting.content) {
        notesSync.syncNote(meeting.id, meeting.notesSessionId, meeting.content).catch((error) => {
          console.error('Note sync failed for', meeting.id, ':', error.message);
        });
      }
    }

    return { success: true };
  } catch (error) {
    console.error('Failed to save meetings data:', error);
    return { success: false, error: error.message };
  }
});

// Debug handler to check if IPC handlers are registered
ipcMain.handle('debugGetHandlers', async () => {
  console.log("Checking registered IPC handlers...");
  const handlers = Object.keys(ipcMain._invokeHandlers);
  console.log("Registered handlers:", handlers);
  return handlers;
});

// Handler to get active recording ID for a note
ipcMain.handle('getActiveRecordingId', async (event, noteId) => {
  console.log(`getActiveRecordingId called for note: ${noteId}`);

  try {
    // If noteId is provided, get recording for that specific note
    if (noteId) {
      const recordingInfo = activeRecordings.getForNote(noteId);
      return {
        success: true,
        data: recordingInfo
      };
    }

    // Otherwise return all active recordings
    return {
      success: true,
      data: activeRecordings.getAll()
    };
  } catch (error) {
    console.error('Error getting active recording ID:', error);
    return { success: false, error: error.message };
  }
});

// Handle deleting a meeting
ipcMain.handle('deleteMeeting', async (event, meetingId) => {
  try {
    console.log(`Deleting meeting with ID: ${meetingId}`);

    let meetingDeleted = false;
    let recordingId = null;

    // Routed through scheduleOperation (not a raw read + writeData) so the
    // deletion is applied to the freshest state, not a snapshot that could
    // be missing a concurrent write (see updateMeetingById's comment).
    await fileOperationManager.scheduleOperation(async (currentData) => {
      const pastMeetingIndex = currentData.pastMeetings.findIndex(meeting => meeting.id === meetingId);
      const upcomingMeetingIndex = currentData.upcomingMeetings.findIndex(meeting => meeting.id === meetingId);

      // Remove from past meetings if found
      if (pastMeetingIndex !== -1) {
        // Store the recording ID for later cleanup if needed
        recordingId = currentData.pastMeetings[pastMeetingIndex].recordingId;

        // Remove the meeting
        currentData.pastMeetings.splice(pastMeetingIndex, 1);
        meetingDeleted = true;
      }

      // Remove from upcoming meetings if found
      if (upcomingMeetingIndex !== -1) {
        // Store the recording ID for later cleanup if needed
        recordingId = currentData.upcomingMeetings[upcomingMeetingIndex].recordingId;

        // Remove the meeting
        currentData.upcomingMeetings.splice(upcomingMeetingIndex, 1);
        meetingDeleted = true;
      }

      return currentData;
    });

    if (!meetingDeleted) {
      return { success: false, error: 'Meeting not found' };
    }

    // If the meeting had a recording, cleanup the reference in the global tracking
    if (recordingId && global.activeMeetingIds && global.activeMeetingIds[recordingId]) {
      console.log(`Cleaning up tracking for deleted meeting with recording ID: ${recordingId}`);
      delete global.activeMeetingIds[recordingId];
    }

    console.log(`Successfully deleted meeting: ${meetingId}`);
    return { success: true };
  } catch (error) {
    console.error('Error deleting meeting:', error);
    return { success: false, error: error.message };
  }
});

// Handle generating AI summary for a meeting (non-streaming)
ipcMain.handle('generateMeetingSummary', async (event, meetingId) => {
  try {
    console.log(`Manual summary generation requested for meeting: ${meetingId}`);

    // A read-only lookup to check transcript presence and pass the meeting
    // into generateMeetingSummary - the actual mutation happens later via
    // updateMeetingById against fresh data, not this snapshot, since
    // generateMeetingSummary is an await boundary a concurrent write could
    // land during.
    const initialData = await fileOperationManager.readMeetingsData();
    const meeting = initialData.pastMeetings.find(m => m.id === meetingId);

    if (!meeting) {
      return { success: false, error: 'Meeting not found' };
    }

    // Check if there's a transcript to summarize
    if (!meeting.transcript || meeting.transcript.length === 0) {
      return {
        success: false,
        error: 'No transcript available for this meeting'
      };
    }

    // Log summary generation to console instead of showing a notification
    console.log('Generating AI summary for meeting: ' + meetingId);

    // Generate the summary
    const summary = await generateMeetingSummary(meeting);

    // Save the updated data with summary
    await updateMeetingById(meetingId, (m) => {
      m.content = summary;
      m.hasSummary = true;
    });

    console.log('Updated meeting note with AI summary');

    // Notify the renderer to refresh the note if it's open
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('summary-generated', meetingId);
    }

    return {
      success: true,
      summary
    };
  } catch (error) {
    console.error('Error generating meeting summary:', error);
    return { success: false, error: error.message };
  }
});

// Handle starting a manual desktop recording
ipcMain.handle('startManualRecording', async (event, meetingId) => {
  try {
    console.log(`Starting manual desktop recording for meeting: ${meetingId}`);

    const initialData = await fileOperationManager.readMeetingsData();
    if (!initialData.pastMeetings.some(meeting => meeting.id === meetingId)) {
      return { success: false, error: 'Meeting not found' };
    }

    try {
      // Prepare desktop audio recording - this is the key difference from our previous implementation
      // It returns a key that we use as the window ID

      // Log the prepareDesktopAudioRecording API call
      sdkLogger.logApiCall('prepareDesktopAudioRecording');

      const key = await RecallAiSdk.prepareDesktopAudioRecording();
      console.log('Prepared desktop audio recording with key:', key);

      // Create a recording token
      const uploadData = await createDesktopSdkUpload();
      if (!uploadData || !uploadData.upload_token) {
        // getAuthStatus() can report "signed in" from a stale persisted
        // refresh token that's since expired/been revoked - this is the
        // first real API call that actually exercises it, so surface the
        // real reason instead of a generic string when that's the cause.
        const isAuthError = uploadData?.error?.includes('Not signed in');
        return {
          success: false,
          error: isAuthError ? 'Sign in with Asymbl to record a meeting' : (uploadData?.error || 'Failed to create recording token'),
        };
      }

      // Store the recording ID in the meeting - routed through
      // updateMeetingById (fresh-read-then-write) rather than writing the
      // stale meetingsData snapshot read at the top of this handler, since
      // prepareDesktopAudioRecording()/createDesktopSdkUpload() above are
      // real await boundaries a concurrent write (autosave, transcript
      // processing) could land during. This is the exact bug found live:
      // recordingId was set here but ended up null on disk.
      await updateMeetingById(meetingId, (meeting) => {
        meeting.recordingId = key;
        if (!meeting.transcript) {
          meeting.transcript = [];
        }
      });

      // Store tracking info for the recording
      global.activeMeetingIds = global.activeMeetingIds || {};
      global.activeMeetingIds[key] = {
        platformName: 'Desktop Recording',
        noteId: meetingId
      };

      // Register the recording in our active recordings tracker
      activeRecordings.addRecording(key, meetingId, 'Desktop Recording');

      // Start recording with the key from prepareDesktopAudioRecording
      console.log('Starting desktop recording with key:', key);

      // Log the startRecording API call
      sdkLogger.logApiCall('startRecording', {
        windowId: key,
        uploadToken: `${uploadData.upload_token.substring(0, 8)}...` // Log truncated token for security
      });

      await RecallAiSdk.startRecording({
        windowId: key,
        uploadToken: uploadData.upload_token
      });

      return {
        success: true,
        recordingId: key
      };
    } catch (sdkError) {
      console.error('RecallAI SDK error:', sdkError);
      return { success: false, error: 'Failed to prepare desktop recording: ' + sdkError.message };
    }
  } catch (error) {
    console.error('Error starting manual recording:', error);
    return { success: false, error: error.message };
  }
});

// Handle stopping a manual desktop recording
// Shared by the renderer-driven IPC handler below and the tray's Stop
// actions (popover button + native right-click menu, screen 01) - both need
// the exact same stopRecording+state-update sequence, just from different
// call sites (recordingId is known in the renderer's UI state; the tray
// only knows currentRecordingWindowId, tracked in main.js's own SDK
// listeners since the tray has no UI state of its own).
async function stopActiveRecording(windowId) {
  console.log(`Stopping desktop recording: ${windowId}`);
  sdkLogger.logApiCall('stopRecording', { windowId });
  activeRecordings.updateState(windowId, 'stopping');
  await RecallAiSdk.stopRecording({ windowId });
  // The recording-ended event fires automatically, handling upload/summary.
}

ipcMain.handle('stopManualRecording', async (event, recordingId) => {
  try {
    await stopActiveRecording(recordingId);
    return { success: true };
  } catch (error) {
    console.error('Error stopping manual recording:', error);
    return { success: false, error: error.message };
  }
});

// Handle generating AI summary with streaming
ipcMain.handle('generateMeetingSummaryStreaming', async (event, meetingId) => {
  try {
    console.log(`Streaming summary generation requested for meeting: ${meetingId}`);

    // Read-only snapshot for the transcript check and to pass into
    // generateMeetingSummary - the actual persisted mutation happens later
    // via updateMeetingById against fresh data, since generateMeetingSummary
    // is a real await boundary a concurrent write could land during.
    const initialData = await fileOperationManager.readMeetingsData();
    const meeting = initialData.pastMeetings.find(m => m.id === meetingId);

    if (!meeting) {
      return { success: false, error: 'Meeting not found' };
    }

    // Check if there's a transcript to summarize
    if (!meeting.transcript || meeting.transcript.length === 0) {
      return {
        success: false,
        error: 'No transcript available for this meeting'
      };
    }

    // Log summary generation to console instead of showing a notification
    console.log('Generating streaming summary for meeting: ' + meetingId);

    // Get meeting title for use in the new content
    const meetingTitle = meeting.title || "Meeting Notes";

    // Initial content with placeholders
    meeting.content = 'Generating summary...';

    // Update the note on the frontend right away
    mainWindow.webContents.send('summary-update', {
      meetingId,
      content: meeting.content
    });

    // Create progress callback for streaming updates
    const streamProgress = (currentText) => {
      // Update content with current streaming text
      meeting.content = `## AI-Generated Meeting Summary\n${currentText}`;

      // Send immediate update to renderer - don't debounce or delay this
      if (mainWindow && !mainWindow.isDestroyed()) {
        try {
          // Force immediate send of the update
          mainWindow.webContents.send('summary-update', {
            meetingId,
            content: meeting.content,
            timestamp: Date.now() // Add timestamp to ensure uniqueness
          });
        } catch (err) {
          console.error('Error sending streaming update to renderer:', err);
        }
      }
    };

    // Generate summary with streaming
    const summary = await generateMeetingSummary(meeting, streamProgress);

    // Save the updated data with summary
    await updateMeetingById(meetingId, (m) => {
      m.content = summary;
      m.hasSummary = true;
    });

    console.log('Updated meeting note with AI summary (streaming)');

    // Final notification to renderer
    mainWindow.webContents.send('summary-generated', meetingId);

    return {
      success: true,
      summary
    };
  } catch (error) {
    console.error('Error generating streaming summary:', error);
    return { success: false, error: error.message };
  }
});

// Handle loading meetings data
ipcMain.handle('loadMeetingsData', async () => {
  try {
    // Use our file operation manager to safely read the data
    const data = await fileOperationManager.readMeetingsData();

    // Return the data
    return {
      success: true,
      data: data
    };
  } catch (error) {
    console.error('Failed to load meetings data:', error);
    return { success: false, error: error.message };
  }
});

// Screen 02 (Home/Today §2.6) "Waiting to sync" queue - real pending-retry
// state from notes-sync.js, not fabricated.
ipcMain.handle('getPendingSyncMeetingIds', () => notesSync.getPendingSyncMeetingIds());

// "Waiting to sync" attention item's real click action - retry now, instead
// of only ever retrying opportunistically on the next unrelated successful
// sync (notes-sync.js's existing behavior).
ipcMain.handle('retryNoteSync', async (event, meetingId) => {
  const data = await fileOperationManager.readMeetingsData();
  const meeting = data.pastMeetings.find((m) => m.id === meetingId);
  if (!meeting || !meeting.notesSessionId) {
    return { success: false, error: 'No notes session for this meeting' };
  }
  const result = await notesSync.syncNote(meetingId, meeting.notesSessionId, meeting.content);
  return { success: result.status === 'success', error: result.message };
});

// Screen 02 (Home/Today §2.8) connection status card's real mic-permission
// check. getMediaAccessStatus is macOS/Windows only (Electron docs) - other
// platforms have no concept of a pre-flight permission prompt, so 'granted'
// there is the honest default rather than a fabricated check.
ipcMain.handle('getMicPermissionStatus', () => {
  if (process.platform === 'darwin' || process.platform === 'win32') {
    return systemPreferences.getMediaAccessStatus('microphone');
  }
  return 'granted';
});

// Function to create a new meeting note and start recording
async function createMeetingNoteAndRecord(platformName) {
  console.log("Creating meeting note for platform:", platformName);
  try {
    if (!detectedMeeting) {
      console.error('No active meeting detected');
      return;
    }
    console.log("Detected meeting info:", detectedMeeting.window.id, detectedMeeting.window.platform);

    // Store the meeting window ID for later reference with transcript events
    global.activeMeetingIds = global.activeMeetingIds || {};
    global.activeMeetingIds[detectedMeeting.window.id] = { platformName };

    // Generate a unique ID for the new meeting
    const id = 'meeting-' + Date.now();

    // Current date and time
    const now = new Date();

    // Use the actual meeting title if available, otherwise fall back to platform name + time
    // NOTE: meeting-updated may fire after the user clicks to join, so this might not be
    // populated yet. The meeting-updated handler will update the title retroactively if needed.
    const meetingTitle = detectedMeeting.window.title
      ? detectedMeeting.window.title
      : `${platformName} Meeting - ${now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;

    // Create a template for the note content
    const template = 'Recording: In Progress...';

    // Create a new meeting object
    const newMeeting = {
      id: id,
      type: 'document',
      title: meetingTitle,
      subtitle: now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      hasDemo: false,
      date: now.toISOString(),
      participants: [],
      content: template,
      recordingId: detectedMeeting.window.id,
      platform: platformName,
      transcript: [] // Initialize an empty array for transcript data
    };

    // Update the active meeting tracking with the note ID
    if (global.activeMeetingIds && global.activeMeetingIds[detectedMeeting.window.id]) {
      global.activeMeetingIds[detectedMeeting.window.id].noteId = id;
    }

    // Register this meeting in our active recordings tracker (even before starting)
    // This ensures the UI knows about it immediately
    activeRecordings.addRecording(detectedMeeting.window.id, id, platformName);

    // Add to pastMeetings - routed through scheduleOperation (fresh read,
    // not this function's own independent read) so a concurrent write to a
    // different meeting isn't overwritten by an earlier snapshot.
    console.log(`Saving meeting data to ${meetingsFilePath} with ID: ${id}`);
    await fileOperationManager.scheduleOperation(async (currentData) => {
      currentData.pastMeetings.unshift(newMeeting);
      return currentData;
    });

    // Verify the file was written by reading it back
    try {
      const verifyData = await fs.promises.readFile(meetingsFilePath, 'utf8');
      const parsedData = JSON.parse(verifyData);
      const verifyMeeting = parsedData.pastMeetings.find(m => m.id === id);

      if (verifyMeeting) {
        console.log(`Successfully verified meeting ${id} was saved`);

        // Tell the renderer to open the new note
        if (mainWindow && !mainWindow.isDestroyed()) {
          // We need a significant delay to make sure the file is fully processed and loaded
          // This ensures the renderer has time to process the file and recognize the new meeting
          setTimeout(async () => {
            try {
              // Force a file reload before sending the message
              await fs.promises.readFile(meetingsFilePath, 'utf8');

              console.log(`Sending IPC message to open meeting note: ${id}`);
              mainWindow.webContents.send('open-meeting-note', id);

              // Send another message after 2 seconds as a backup
              setTimeout(() => {
                console.log(`Sending backup IPC message to open meeting note: ${id}`);
                mainWindow.webContents.send('open-meeting-note', id);
              }, 2000);
            } catch (error) {
              console.error('Error before sending open-meeting-note message:', error);
            }
          }, 1500); // Increased delay for safety
        }
      } else {
        console.error(`Meeting ${id} not found in saved data!`);
      }
    } catch (verifyError) {
      console.error('Error verifying saved data:', verifyError);
    }

    // Spec B F5: meeting detected -> capture policy -> consent, before any
    // recording starts. meeting_url is only reliably known from
    // meeting-updated (see the comment on that listener above), so this can
    // legitimately come back with no policy match yet - that's not treated
    // as a hard block, see the fail-open note below.
    const policyCheck = await capturePolicyClient.checkCapturePolicy(detectedMeeting.window.url || null);
    let decisionToken = null;
    let interviewId = null;
    let blockReason = null;
    let policyDecision = null; // F10-R9 telemetry field - which arbitration decision this recording ran under

    if (policyCheck.status === 'success') {
      const policy = policyCheck.policy;
      policyDecision = policy.decision;
      if (policy.decision === 'NONE') {
        blockReason = policy.consent?.consent_required && !policy.consent?.consent_obtained
          ? 'Consent required for this meeting has not been obtained.'
          : 'Capture is not permitted for this meeting (Bot_Capture_Mode__c=None or no policy match).';
      } else if (policy.decision === 'BOT_ONLY') {
        blockReason = 'A Recall bot is already the authoritative capture for this meeting - desktop recording skipped.';
      } else {
        decisionToken = policy.decision_token;
        interviewId = policy.interview_id;
      }
    } else {
      // [UNVERIFIED default] fails OPEN to unmanaged desktop-only recording
      // rather than blocking every meeting outright - capture-policy can't
      // be checked at all yet in most real runs (F7-R11 login blocked,
      // meeting_url often not populated this early). Logged, not silent.
      console.warn('Capture policy check unavailable, recording without a policy decision:', policyCheck.message);
    }

    if (blockReason) {
      console.log('Recording blocked by capture policy:', blockReason);
      try {
        await updateMeetingById(id, (meeting) => {
          meeting.content = `Recording not started: ${blockReason}`;
        });
      } catch (writeError) {
        console.error('Error recording capture-policy block reason:', writeError);
      }
      return id;
    }

    // Start recording with upload token
    console.log('Starting recording for meeting:', detectedMeeting.window.id);

    try {
      // Get upload token
      const uploadData = await createDesktopSdkUpload(decisionToken, interviewId);

      // Spec B F6: track the session so recording-ended can finalize it.
      if (uploadData && uploadData.session && uploadData.session.session_id && global.activeMeetingIds?.[detectedMeeting.window.id]) {
        global.activeMeetingIds[detectedMeeting.window.id].sessionId = uploadData.session.session_id;
        global.activeMeetingIds[detectedMeeting.window.id].recordingStartedAt = Date.now();
        global.activeMeetingIds[detectedMeeting.window.id].policyDecision = policyDecision;
      }

      // Spec B F8: persist notes_session_id on the meeting record itself
      // (not just in-memory) so every future note save can sync, not just
      // ones made while this recording is still active. Recall's own
      // recording_id is captured the same way - needed later to trigger
      // post-meeting Perfect Diarization (real speaker names) via
      // /api/v1/recording/{id}/create_transcript/, separate from the live
      // You/Them fallback used during the recording itself. Not acted on
      // yet - just captured so it isn't lost once the recording finalizes.
      if (uploadData && uploadData.session && (uploadData.session.notes_session_id || uploadData.session.recall_recording_id)) {
        await updateMeetingById(id, (meeting) => {
          if (uploadData.session.notes_session_id) {
            meeting.notesSessionId = uploadData.session.notes_session_id;
          }
          if (uploadData.session.recall_recording_id) {
            meeting.recallRecordingId = uploadData.session.recall_recording_id;
          }
        });
      }

      if (!uploadData || !uploadData.upload_token) {
        console.error('Failed to get upload token. Recording without upload token.');

        // Log the startRecording API call (no token fallback)
        sdkLogger.logApiCall('startRecording', {
          windowId: detectedMeeting.window.id
        });

        await RecallAiSdk.startRecording({
          windowId: detectedMeeting.window.id
        });
      } else {
        console.log('Starting recording with upload token:', uploadData.upload_token);

        // Log the startRecording API call with upload token
        sdkLogger.logApiCall('startRecording', {
          windowId: detectedMeeting.window.id,
          uploadToken: `${uploadData.upload_token.substring(0, 8)}...` // Log truncated token for security
        });

        await RecallAiSdk.startRecording({
          windowId: detectedMeeting.window.id,
          uploadToken: uploadData.upload_token
        });
      }
    } catch (error) {
      console.error('Error starting recording with upload token:', error);

      // Fallback to recording without token

      // Log the startRecording API call (error fallback)
      sdkLogger.logApiCall('startRecording', {
        windowId: detectedMeeting.window.id,
        error: 'Fallback after error'
      });

      await RecallAiSdk.startRecording({
        windowId: detectedMeeting.window.id
      });
    }

    return id;
  } catch (error) {
    console.error('Error creating meeting note:', error);
    // Real bug found via a live test run: if RecallAiSdk.startRecording
    // fails in both the primary and no-token-fallback branches above (e.g.
    // "Failed to parse recording config" when there's no working Recall API
    // key), this outer catch used to return undefined even though the
    // meeting note itself was already created and saved to disk a few lines
    // earlier - the caller (joinDetectedMeeting) then reported a successful
    // join with no way to find the note it just made. The note exists
    // either way; recording failing to start shouldn't erase that.
    return typeof id !== 'undefined' ? id : null;
  }
}

// Function to process video frames
async function processVideoFrame(evt) {
  try {
    const windowId = evt.window?.id;
    if (!windowId) {
      console.error("Missing window ID in video frame event");
      return;
    }

    // Check if we have this meeting in our active meetings
    if (!global.activeMeetingIds || !global.activeMeetingIds[windowId]) {
      console.log(`No active meeting found for window ID: ${windowId}`);
      return;
    }

    const noteId = global.activeMeetingIds[windowId].noteId;
    if (!noteId) {
      console.log(`No note ID found for window ID: ${windowId}`);
      return;
    }

    // Extract the video data
    const frameData = evt.data.data;
    if (!frameData || !frameData.buffer) {
      console.log("No video frame data in event");
      return;
    }

    // Get data from the event
    const frameBuffer = frameData.buffer; // base64 encoded PNG
    const frameTimestamp = frameData.timestamp;
    const frameType = frameData.type; // 'webcam' or 'screenshare'
    const participantData = frameData.participant;

    // Extract participant info
    const participantId = participantData?.id;
    const participantName = participantData?.name || 'Unknown';

    // Log minimal info to avoid flooding the console
    // console.log(`Received ${frameType} frame from ${participantName} (ID: ${participantId}) at ${frameTimestamp.absolute}`);

    // Send the frame to the renderer
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('video-frame', {
        noteId,
        participantId,
        participantName,
        frameType,
        buffer: frameBuffer,
        timestamp: frameTimestamp
      });
    }
  } catch (error) {
    console.error('Error processing video frame:', error);
  }
}

// Function to process participant join events
async function processParticipantJoin(evt) {
  try {
    const windowId = evt.window?.id;
    if (!windowId) {
      console.error("Missing window ID in participant join event");
      return;
    }

    // Check if we have this meeting in our active meetings
    if (!global.activeMeetingIds || !global.activeMeetingIds[windowId]) {
      console.log(`No active meeting found for window ID: ${windowId}`);
      return;
    }

    const noteId = global.activeMeetingIds[windowId].noteId;
    if (!noteId) {
      console.log(`No note ID found for window ID: ${windowId}`);
      return;
    }

    // Extract the participant data
    const participantData = evt.data.data.participant;
    if (!participantData) {
      console.log("No participant data in event");
      return;
    }

    const participantName = participantData.name || "Unknown Participant";
    const participantId = participantData.id;
    const isHost = participantData.is_host;
    const platform = participantData.platform;

    console.log(`Participant joined: ${participantName} (ID: ${participantId}, Host: ${isHost})`);

    // Skip "Host" and "Guest" generic names
    if (participantName === "Host" || participantName === "Guest" || participantName.includes("others") || (participantName.split(" ").length > 3)) {
      console.log(`Skipping generic participant name: ${participantName}`);
      return;
    }

    // Use the file operation manager to safely update the meetings data
    await fileOperationManager.scheduleOperation(async (meetingsData) => {
      // Find the meeting note with this ID
      const noteIndex = meetingsData.pastMeetings.findIndex(meeting => meeting.id === noteId);
      if (noteIndex === -1) {
        console.log(`No meeting note found with ID: ${noteId}`);
        return null; // Return null to indicate no changes needed
      }

      // Get the meeting and initialize participants array if needed
      const meeting = meetingsData.pastMeetings[noteIndex];
      if (!meeting.participants) {
        meeting.participants = [];
      }

      // Check if participant already exists (based on ID)
      const existingParticipantIndex = meeting.participants.findIndex(p => p.id === participantId);

      if (existingParticipantIndex !== -1) {
        // Update existing participant
        meeting.participants[existingParticipantIndex] = {
          id: participantId,
          name: participantName,
          isHost: isHost,
          platform: platform,
          joinTime: new Date().toISOString(),
          status: 'active'
        };
      } else {
        // Add new participant
        meeting.participants.push({
          id: participantId,
          name: participantName,
          isHost: isHost,
          platform: platform,
          joinTime: new Date().toISOString(),
          status: 'active'
        });
      }

      console.log(`Added/updated participant data for meeting: ${noteId}`);

      // Notify the renderer if this note is currently being edited
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('participants-updated', noteId);
      }

      // Return the updated data to be written
      return meetingsData;
    });

    console.log(`Processed participant join event for meeting: ${noteId}`);
  } catch (error) {
    console.error('Error processing participant join event:', error);
  }
}

let currentUnknownSpeaker = -1;

async function processTranscriptProviderData(evt) {
  // let speakerId = evt.data.data.payload.
  try {
    if (evt.data.data.data.payload.channel.alternatives[0].words[0].speaker !== undefined) {
      currentUnknownSpeaker = evt.data.data.data.payload.channel.alternatives[0].words[0].speaker;
    }
  } catch (error) {
    // console.error("Error processing provider data:", error);
  }
}

// Function to process transcript data and store it with the meeting note
async function processTranscriptData(evt) {
  try {
    const windowId = evt.window?.id;
    if (!windowId) {
      console.error("Missing window ID in transcript event");
      return;
    }

    // Check if we have this meeting in our active meetings
    if (!global.activeMeetingIds || !global.activeMeetingIds[windowId]) {
      console.log(`No active meeting found for window ID: ${windowId}`);
      return;
    }

    const noteId = global.activeMeetingIds[windowId].noteId;
    if (!noteId) {
      console.log(`No note ID found for window ID: ${windowId}`);
      return;
    }

    // Extract the transcript data
    const words = evt.data.data.words || [];
    if (words.length === 0) {
      return; // No words to process
    }

    // Get speaker information. T17 (confirmed via live test 2026-07-22):
    // Recall's own streaming engine returns no transcript.provider_data for
    // this desktop-capture path, so real diarization/names aren't
    // available - participant.name is always the generic "Host"/"Guest"
    // placeholder. Per owner decision, fall back to a You/Them framing
    // using participant.is_host as the signal (the only real per-utterance
    // attribution this event actually carries) - "Host" is assumed to be
    // the local desktop-app user, which holds for the common 1:1-call case
    // this framing targets but isn't guaranteed for every meeting platform.
    let speaker;
    const isHostSpeaker = evt.data.data.participant?.is_host;
    if (isHostSpeaker === true) {
      speaker = "You";
    } else if (isHostSpeaker === false) {
      speaker = "Them";
    } else if (currentUnknownSpeaker !== -1) {
      speaker = `Speaker ${currentUnknownSpeaker}`;
    } else {
      speaker = "Unknown Speaker";
    }

    // Combine all words into a single text
    const text = words.map(word => word.text).join(" ");

    console.log(`Transcript from ${speaker}: "${text}"`);

    // Use the file operation manager to safely update the meetings data
    await fileOperationManager.scheduleOperation(async (meetingsData) => {
      // Find the meeting note with this ID
      const noteIndex = meetingsData.pastMeetings.findIndex(meeting => meeting.id === noteId);
      if (noteIndex === -1) {
        console.log(`No meeting note found with ID: ${noteId}`);
        return null; // Return null to indicate no changes needed
      }

      // Add the transcript data
      const meeting = meetingsData.pastMeetings[noteIndex];

      // Initialize transcript array if it doesn't exist
      if (!meeting.transcript) {
        meeting.transcript = [];
      }

      // Add the new transcript entry
      meeting.transcript.push({
        text,
        speaker,
        timestamp: new Date().toISOString()
      });

      console.log(`Added transcript data for meeting: ${noteId}`);

      // Notify the renderer if this note is currently being edited
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('transcript-updated', noteId);
      }

      // Return the updated data to be written
      return meetingsData;
    });

    console.log(`Processed transcript data for meeting: ${noteId}`);
  } catch (error) {
    console.error('Error processing transcript data:', error);
  }
}

// Function to generate AI summary from transcript with streaming support
// Local AI summarization (this function used to call OpenAI/OpenRouter/Claude
// directly from the desktop process) is removed per the TI Recall handoff:
// "NEVER: call LLMs from the desktop app." Structured signal extraction now
// happens server-side (Temporal C1) and lands on the Salesforce Job Applicant
// timeline instead. Signature kept so the existing IPC handlers/renderer
// calls degrade to a clear message rather than crashing.
async function generateMeetingSummary(_meeting, progressCallback = null) {
  const message = 'AI summary generation was removed from the desktop app. Interview signal extraction now happens server-side and appears on the Salesforce Job Applicant timeline.';
  if (progressCallback) {
    progressCallback(message);
  }
  return message;
}

// Function to update a note with recording information when recording ends
async function updateNoteWithRecordingInfo(recordingId) {
  try {
    // Read-only lookup for the transcript/title/id checks below - the
    // actual mutation happens via scheduleOperation against fresh data,
    // not this snapshot (same stale-write race as startManualRecording).
    const initialData = await fileOperationManager.readMeetingsData();
    const meeting = initialData.pastMeetings.find(m => m.recordingId === recordingId);

    if (!meeting) {
      console.log('No meeting note found for recording ID:', recordingId);
      return;
    }

    // Format current date
    const now = new Date();
    const formattedDate = now.toLocaleString();

    // Update the meeting object (mutating this local copy so the summary
    // logic below can keep reading meeting.content/.transcript/.id as
    // before - the persisted write is separate, against fresh data)
    meeting.content = meeting.content.replace(
      "Recording: In Progress...",
      `Recording: Completed at ${formattedDate}\n`
    );
    meeting.recordingComplete = true;
    meeting.recordingEndTime = now.toISOString();

    // Save the initial update
    await fileOperationManager.scheduleOperation(async (currentData) => {
      const freshMeeting = currentData.pastMeetings.find(m => m.recordingId === recordingId);
      if (freshMeeting) {
        freshMeeting.content = meeting.content;
        freshMeeting.recordingComplete = true;
        freshMeeting.recordingEndTime = meeting.recordingEndTime;
      }
      return currentData;
    });

    // Generate AI summary if there's a transcript
    if (meeting.transcript && meeting.transcript.length > 0) {
      console.log(`Generating AI summary for meeting ${meeting.id}...`);

      // Log summary generation to console instead of showing a notification
      console.log('Generating AI summary for meeting: ' + meeting.id);

      // Get meeting title for use in the new content
      const meetingTitle = meeting.title || "Meeting Notes";

      // Create initial content with placeholder
      meeting.content = 'Generating summary...';

      // Notify any open editors immediately
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('summary-update', {
          meetingId: meeting.id,
          content: meeting.content
        });
      }

      // Create progress callback for streaming updates
      const streamProgress = (currentText) => {
        // Update content with current streaming text
        meeting.content = currentText;

        // Send immediate update to renderer if note is open
        if (mainWindow && !mainWindow.isDestroyed()) {
          try {
            mainWindow.webContents.send('summary-update', {
              meetingId: meeting.id,
              content: meeting.content,
              timestamp: Date.now() // Add timestamp to ensure uniqueness
            });
          } catch (err) {
            console.error('Error sending streaming update to renderer:', err);
          }
        }
      };

      // Generate the summary with streaming updates
      const summary = await generateMeetingSummary(meeting, streamProgress);

      // Save the updated data with summary, against fresh data by id (not
      // this function's stale initial snapshot)
      await updateMeetingById(meeting.id, (m) => {
        m.content = `${summary}`;
        m.hasSummary = true;
      });

      console.log('Updated meeting note with AI summary');
    }

    // If the note is currently open, notify the renderer to refresh it
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('recording-completed', meeting.id);
    }
  } catch (error) {
    console.error('Error updating note with recording info:', error);
  }
}

// Function to check if there's a detected meeting available
ipcMain.handle('checkForDetectedMeeting', async () => {
  return detectedMeeting !== null;
});

// Function to join the detected meeting
ipcMain.handle('joinDetectedMeeting', async () => {
  return joinDetectedMeeting();
});

// Function to handle joining a detected meeting
async function joinDetectedMeeting() {
  try {
    console.log("Join detected meeting called");

    // Real gap found during end-to-end testing (2026-07-22): auto-join on
    // meeting detection (line ~531 below) bypasses the renderer's button
    // gating entirely - without this check, an unauthenticated user's app
    // would silently attempt to record (and fail deep inside the SDK) the
    // moment any meeting-like window was detected, with no clear message.
    if (!authStore.getAccessToken() && !authStore.loadPersistedRefreshToken()) {
      console.log("Not signed in - refusing to auto-join detected meeting");
      return { success: false, error: "Sign in with Asymbl to record a meeting" };
    }

    if (!detectedMeeting) {
      console.log("No detected meeting available");
      return { success: false, error: "No active meeting detected" };
    }

    // Map platform codes to readable names
    const platformNames = {
      'zoom': 'Zoom',
      'google-meet': 'Google Meet',
      'slack': 'Slack',
      'teams': 'Microsoft Teams'
    };

    // Get a user-friendly platform name, or use the raw platform name if not in our map
    const platformName = platformNames[detectedMeeting.window.platform] || detectedMeeting.window.platform;

    console.log("Joining detected meeting for platform:", platformName);

    // Ensure main window exists and is visible
    if (!mainWindow || mainWindow.isDestroyed()) {
      console.log("Creating new main window");
      createWindow();
    }

    // Bring window to front with focus
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();

    // Process with more reliable timing
    return new Promise((resolve) => {
      // Wait a moment for the window to be fully focused and ready
      setTimeout(async () => {
        console.log("Window is ready, creating new meeting note");

        try {
          // Create a new meeting note and start recording
          const id = await createMeetingNoteAndRecord(platformName);

          console.log("Created new meeting with ID:", id);
          resolve({ success: true, meetingId: id });
        } catch (err) {
          console.error("Error creating meeting note:", err);
          resolve({ success: false, error: err.message });
        }
      }, 800); // Increased timeout for more reliability
    });
  } catch (error) {
    console.error("Error in joinDetectedMeeting:", error);
    return { success: false, error: error.message };
  }
}
