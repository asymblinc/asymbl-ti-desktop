// Menu-bar tray, popover, and 9-state machine (screen 01 redesign, task
// #20 - docs/screen-specs/01-menu-bar-tray.md). Successor to the shipped
// recording-only tray: the tray is now always present while signed in
// (Granola pattern), not just during recording.
//
// Migration note (per spec §6): setRecordingActive(active) is kept as the
// exact input shape main.js already calls on recording-started/-ended -
// only its internal behavior changed (updates state machine + re-renders,
// instead of creating/destroying the Tray object).
//
// Popover is a real BrowserWindow, not a native Tray context menu - macOS's
// native menu can't render custom cards/gradients/buttons the design needs.
// This means the popover's renderer CAN crash independently of the tray
// itself; the right-click "Stop Recording" native context-menu item exists
// specifically so stopping a recording never depends on that renderer being
// alive (spec N3 - "Stop must work even if all windows are dead"; the tray
// and its native context menu are owned by the main process).
const path = require('node:path');
const { app, Tray, Menu, BrowserWindow, screen, nativeImage, ipcMain, shell } = require('electron');
const { version } = require('../package.json');

// __dirname resolves inside the webpack bundle (.webpack/main/), which
// doesn't copy static assets - app.getAppPath() (the project root in dev
// mode) is needed to find the real source file, same reasoning as the
// shipped tray.js this replaces.
const ASSETS_DIR = path.join(app.getAppPath(), 'src', 'assets');

let tray = null;
let popoverWindow = null;
let mainWindowRef = null;
let onActionCallback = null; // set by initTray; main.js supplies the real handlers

const state = {
  signedIn: false,
  user: null, // { name, org }
  lockedMessage: null,
  nextEvent: null, // { id, subject, startTime, location, whoName }
  meetingDetected: null, // { platform }
  recording: null, // { platform, startedAt (ms epoch) }
  uploadProgress: null, // 0-100, or null when not uploading
};

/** Precedence order per spec §2: red (recording) always wins as the
 * strongest trust signal; everything else falls back toward "nothing to
 * report" (idle-ready). paused/attention are deferred (TODOS.md #10/#11) -
 * not reachable here since nothing ever sets a paused/attention flag. */
function computeState() {
  if (!state.signedIn) return 'signed-out';
  if (state.recording) return 'recording';
  if (state.uploadProgress != null && state.uploadProgress < 100) return 'uploading';
  if (state.meetingDetected) return 'meeting-detected';
  if (state.lockedMessage) return 'locked';
  if (state.nextEvent) {
    const diffMin = (new Date(state.nextEvent.startTime).getTime() - Date.now()) / 60000;
    if (diffMin >= 0 && diffMin <= 15) return 'pre-meeting';
  }
  return 'idle-ready';
}

function pillText(current) {
  switch (current) {
    case 'recording': {
      const elapsed = Math.max(0, Math.floor((Date.now() - state.recording.startedAt) / 1000));
      const m = String(Math.floor(elapsed / 60)).padStart(2, '0');
      const s = String(elapsed % 60).padStart(2, '0');
      return `● ${m}:${s}`;
    }
    case 'uploading': return 'Syncing…';
    case 'meeting-detected': return 'Meeting detected';
    case 'locked': return 'Recall · locked';
    case 'pre-meeting': {
      const diffMin = Math.max(0, Math.round((new Date(state.nextEvent.startTime).getTime() - Date.now()) / 60000));
      const who = state.nextEvent.whoName ? state.nextEvent.whoName.split(' ')[0] : 'Next';
      return `${who} · in ${diffMin}m`;
    }
    case 'idle-ready': return 'Recall · ready';
    default: return '';
  }
}

function iconFor(current) {
  const suffix = process.env.NODE_ENV === 'development' ? '' : ''; // reserved for @2x/@3x selection if scaleFactor matters later
  const file = current === 'recording' ? 'tray-icon-recording.png' : 'tray-icon-template.png';
  const image = nativeImage.createFromPath(path.join(ASSETS_DIR, file));
  // Template images get OS-tinted for light/dark menu bars automatically;
  // the recording variant is intentionally NOT a template (red is the
  // point - §12 "red belongs to recording only").
  image.setTemplateImage(current !== 'recording');
  return image;
}

function render() {
  if (!tray) return;
  const current = computeState();
  tray.setImage(iconFor(current));
  if (process.platform === 'darwin') {
    tray.setTitle(pillText(current));
  }
  tray.setToolTip(current === 'recording' ? 'Asymbl Recall - Recording in progress' : 'Asymbl Recall');
  pushStateToPopover(current);
  rebuildContextMenu(current);
}

function pushStateToPopover(current) {
  if (!popoverWindow || popoverWindow.isDestroyed()) return;
  popoverWindow.webContents.send('tray-state-update', {
    state: current,
    signedIn: state.signedIn,
    user: state.user,
    version,
    nextEvent: state.nextEvent,
    meetingDetected: state.meetingDetected,
    recording: state.recording ? { platform: state.recording.platform, startedAt: state.recording.startedAt, elapsedSeconds: (Date.now() - state.recording.startedAt) / 1000 } : null,
    uploadProgress: state.uploadProgress,
    lockedMessage: state.lockedMessage,
  });
}

/** Native, main-process-owned context menu (right-click) - the crash-safe
 * fallback for Stop (spec N3). Only a plain-text Menu; no custom styling
 * possible here, which is fine, this menu exists for reliability, not
 * pixel-matching. */
function rebuildContextMenu(current) {
  if (!tray) return;
  const template = [];
  if (current === 'recording') {
    template.push({ label: 'Stop & Save', click: () => onActionCallback?.('stopRecording') });
  }
  template.push({ label: 'Open Recall', click: () => focusMainWindow() });
  template.push({ type: 'separator' });
  template.push({ label: 'Quit Recall', click: () => app.quit() });
  tray.setContextMenu(Menu.buildFromTemplate(template));
}

function focusMainWindow() {
  if (!mainWindowRef || mainWindowRef.isDestroyed()) return;
  if (mainWindowRef.isMinimized()) mainWindowRef.restore();
  mainWindowRef.show();
  mainWindowRef.focus();
}

function ensurePopoverWindow() {
  if (popoverWindow && !popoverWindow.isDestroyed()) return popoverWindow;
  popoverWindow = new BrowserWindow({
    width: 320,
    height: 480,
    show: false,
    frame: false,
    resizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    backgroundColor: '#00000000',
    transparent: true,
    webPreferences: {
      preload: POPOVER_WINDOW_PRELOAD_WEBPACK_ENTRY,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  popoverWindow.loadURL(POPOVER_WINDOW_WEBPACK_ENTRY);
  // Dismiss on outside click (spec §3 "Popover dismisses on outside
  // click/Esc") - blur is the standard signal for a focusable frameless
  // popover losing focus to anywhere else.
  popoverWindow.on('blur', () => {
    if (popoverWindow && !popoverWindow.isDestroyed()) popoverWindow.hide();
  });
  popoverWindow.webContents.on('did-finish-load', () => pushStateToPopover(computeState()));
  return popoverWindow;
}

function togglePopover() {
  const win = ensurePopoverWindow();
  if (win.isVisible()) {
    win.hide();
    return;
  }
  positionPopover(win);
  win.show();
  win.focus();
  pushStateToPopover(computeState());
}

/** N5: opens on the display where the menu bar was clicked, not always the
 * primary display - screen.getDisplayNearestPoint anchors to the tray
 * icon's own bounds, not the app's current window. */
function positionPopover(win) {
  const trayBounds = tray.getBounds();
  const display = screen.getDisplayNearestPoint({ x: trayBounds.x, y: trayBounds.y });
  const [winWidth, winHeight] = win.getSize();
  let x = Math.round(trayBounds.x + trayBounds.width / 2 - winWidth / 2);
  x = Math.min(Math.max(x, display.workArea.x + 4), display.workArea.x + display.workArea.width - winWidth - 4);
  const y = process.platform === 'darwin' ? Math.round(trayBounds.y + trayBounds.height) : Math.round(trayBounds.y - winHeight);
  win.setPosition(x, y, false);
}

function registerPopoverActionHandlers(handlers) {
  onActionCallback = (action, ...args) => handlers[action]?.(...args);
  const wire = (channel, action) => {
    ipcMain.handle(channel, async (_event, ...args) => {
      popoverWindow?.hide();
      return handlers[action]?.(...args);
    });
  };
  wire('popover:signIn', 'signIn');
  wire('popover:openPreBrief', 'openPreBrief');
  wire('popover:skip', 'skip');
  wire('popover:stopRecording', 'stopRecording');
  wire('popover:startUnscheduledCall', 'startUnscheduledCall');
  wire('popover:openLibrary', 'openLibrary');
  wire('popover:openSettings', 'openSettings');
}

function ensureTray() {
  if (tray) return;
  tray = new Tray(iconFor('idle-ready'));
  tray.on('click', () => {
    if (computeState() === 'recording') {
      // Matches shipped tray.js: while recording, a click focuses the main
      // window (the popover's live-session card is one right-click away,
      // or a second click per spec - kept as a single, unambiguous
      // behavior here rather than a fragile double-click timer).
      focusMainWindow();
      return;
    }
    if (computeState() === 'signed-out') {
      onActionCallback?.('signIn');
      return;
    }
    togglePopover();
  });
  rebuildContextMenu(computeState());
}

function destroyTrayIfSignedOutIdle() {
  // Tray stays present whenever signed in (always-present, per spec) - only
  // torn down here if genuinely never signed in AND no popover is open, to
  // avoid an orphaned icon for a user who never completes onboarding.
  // In practice ensureTray() is idempotent and cheap, so this is a no-op
  // placeholder kept for symmetry with the shipped hideTray() this replaces.
}

function initTray(mainWindow, handlers) {
  mainWindowRef = mainWindow;
  registerPopoverActionHandlers(handlers || {});
  ensureTray();
  render();
}

/** Kept for main.js's existing call sites (recording-started/-ended) -
 * spec §6 migration note: don't break this input shape. */
function setRecordingActive(active, info = {}) {
  state.recording = active ? { platform: info.platform || 'unknown', startedAt: Date.now() } : null;
  render();
}

function setSignedIn(signedIn, user = null) {
  state.signedIn = signedIn;
  state.user = user;
  if (!signedIn) {
    state.lockedMessage = null;
  }
  ensureTray();
  render();
}

function setMeetingDetected(detected, platform = null) {
  state.meetingDetected = detected ? { platform } : null;
  render();
}

function setUploadProgress(progress) {
  // 100 or null both mean "not uploading" - render()'s computeState()
  // already treats >=100 as done via the < 100 check.
  state.uploadProgress = progress;
  render();
}

function setLocked(message) {
  state.lockedMessage = message;
  render();
}

function setNextEvent(nextEvent) {
  state.nextEvent = nextEvent;
  render();
}

module.exports = {
  initTray,
  setRecordingActive,
  setSignedIn,
  setMeetingDetected,
  setUploadProgress,
  setLocked,
  setNextEvent,
};
