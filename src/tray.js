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
  if (current === 'recording') {
    // Red is never a template image on any platform - §12 "red belongs to
    // recording only", the color itself is the signal.
    const image = nativeImage.createFromPath(path.join(ASSETS_DIR, 'tray-icon-recording.png'));
    image.setTemplateImage(false);
    return image;
  }
  if (process.platform === 'darwin') {
    // Template images get OS-tinted for light/dark menu bars automatically.
    const image = nativeImage.createFromPath(path.join(ASSETS_DIR, 'tray-icon-template.png'));
    image.setTemplateImage(true);
    return image;
  }
  // Windows/Linux: no template-image auto-tinting exists, so the macOS
  // pure-black glyph is invisible on a dark taskbar (confirmed via review +
  // OpenWhispr's real Windows icon, which is a separate colored .ico/.png,
  // never the macOS template asset). Use the colored, haloed variant.
  const image = nativeImage.createFromPath(path.join(ASSETS_DIR, 'tray-icon-win.png'));
  image.setTemplateImage(false);
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
    // Cross-platform rendering hints (review, 2026-07-23): the renderer
    // can't call process.platform or know popover placement itself.
    platform: process.platform,
    popoverPosition: lastPopoverPosition,
  });
}

// Built fresh on every render() so it always reflects the current state
// (Stop & Save only while recording); popped up manually on right-click
// only (see ensureTray) - never passed to tray.setContextMenu(). Confirmed
// by actually running the app (2026-07-23): setContextMenu() makes macOS
// show that menu on ANY click, left or right, regardless of a separate
// 'click' listener - it was firing alongside the custom popover on every
// left-click, not instead of it.
let contextMenu = null;

/** Native, main-process-owned context menu (right-click) - the crash-safe
 * fallback for Stop (spec N3). Only a plain-text Menu; no custom styling
 * possible here, which is fine, this menu exists for reliability, not
 * pixel-matching. */
function rebuildContextMenu(current) {
  const template = [];
  if (current === 'recording') {
    template.push({ label: 'Stop & Save', click: () => onActionCallback?.('stopRecording') });
  }
  template.push({ label: 'Open Recall', click: () => focusMainWindow() });
  template.push({ type: 'separator' });
  template.push({ label: 'Quit Recall', click: () => app.quit() });
  contextMenu = Menu.buildFromTemplate(template);
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
    // alwaysOnTop is load-bearing, not decorative: without it the popover
    // is an ordinary window that other app windows can cover, breaking the
    // "floats above everything, attached to the tray icon" illusion every
    // tray-popover pattern (menubar, Slack, Dropbox) depends on - confirmed
    // via research (2026-07-23) rather than assumed.
    alwaysOnTop: true,
    backgroundColor: '#00000000',
    transparent: true,
    webPreferences: {
      preload: POPOVER_WINDOW_PRELOAD_WEBPACK_ENTRY,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  popoverWindow.loadURL(POPOVER_WINDOW_WEBPACK_ENTRY);
  // setAlwaysOnTop's level param (beyond the constructor option) is what
  // actually keeps a tray popover above other topmost windows (Zoom/Teams
  // in a call, other tray flyouts) on both platforms - confirmed via
  // review, 2026-07-23. 'pop-up-menu' is the level Electron docs recommend
  // for exactly this kind of transient attached UI.
  popoverWindow.setAlwaysOnTop(true, 'pop-up-menu');
  // Dismiss on outside click (spec §3 "Popover dismisses on outside
  // click/Esc") - blur is the standard signal for a focusable frameless
  // popover losing focus to anywhere else. Grace period guards against the
  // show()+focus() sequence itself firing an immediate blur before the user
  // has done anything (a real race on Windows per review, 2026-07-23).
  let blurArmedAt = 0;
  popoverWindow.on('blur', () => {
    if (Date.now() < blurArmedAt) return;
    if (popoverWindow && !popoverWindow.isDestroyed()) popoverWindow.hide();
  });
  popoverWindow.on('show', () => {
    blurArmedAt = Date.now() + 200;
  });
  // Windows gotcha (not yet testable on this dev machine - no Windows box
  // available): mixing `transparent: true` with `backgroundColor` can
  // produce GPU rendering artifacts on some Windows driver/GPU combos
  // (research, 2026-07-23). macOS's transparent+shadow rendering is solid,
  // so this is left as-is; re-test this exact config on real Windows
  // hardware and prefer backgroundColor-only if artifacts appear.
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

// Set by positionPopover(), read by pushStateToPopover() so the renderer
// can flip the popover's arrow to point at the icon rather than into empty
// space - 'below'/'above' describe the popover's placement RELATIVE TO THE
// TRAY ICON (below = arrow at the popover's own top edge, pointing up at
// the icon above it; above = arrow at the bottom edge, pointing down).
let lastPopoverPosition = 'below';

/** N5 + real cross-platform tray placement: opens on the display where the
 * menu bar/tray was clicked (not always the primary display), and places
 * the popover below or above the icon depending on which edge of the
 * screen the tray actually sits on (macOS: top menu bar, popover below;
 * Windows: taskbar is commonly bottom but can be top/left/right) - decided
 * by comparing the tray's own bounds to the display's work area rather
 * than hardcoding by platform, so a Windows box with a top-docked taskbar
 * still gets "popover below" placement the same way macOS always does. */
function positionPopover(win) {
  let trayBounds = tray.getBounds();
  const display = trayBounds.width > 0
    ? screen.getDisplayNearestPoint({ x: trayBounds.x, y: trayBounds.y })
    : screen.getPrimaryDisplay();
  // Zero/empty bounds happen when the icon is in the Windows overflow
  // ("^") tray, before first paint, or on some DPI/virtual-desktop setups
  // (review finding, 2026-07-23) - fall back to a corner near where a tray
  // icon conventionally lives (top-right on macOS, bottom-right on
  // Windows/Linux) rather than anchoring to a nonsense {0,0,0,0} rect.
  if (trayBounds.width === 0 && trayBounds.height === 0) {
    trayBounds = process.platform === 'darwin'
      ? { x: display.workArea.x + display.workArea.width - 40, y: display.workArea.y, width: 24, height: 24 }
      : { x: display.workArea.x + display.workArea.width - 40, y: display.workArea.y + display.workArea.height, width: 24, height: 0 };
  }
  const [winWidth, winHeight] = win.getSize();
  let x = Math.round(trayBounds.x + trayBounds.width / 2 - winWidth / 2);
  x = Math.min(Math.max(x, display.workArea.x + 4), display.workArea.x + display.workArea.width - winWidth - 4);

  // Is there more room below the icon than above it? Below-icon placement
  // needs headroom under the icon (macOS menu bar case); above-icon
  // placement needs headroom above it (Windows bottom-taskbar case).
  const spaceBelow = display.workArea.y + display.workArea.height - (trayBounds.y + trayBounds.height);
  const spaceAbove = trayBounds.y - display.workArea.y;
  const popoverPosition = spaceBelow >= winHeight || spaceBelow >= spaceAbove ? 'below' : 'above';
  let y = popoverPosition === 'below' ? Math.round(trayBounds.y + trayBounds.height) : Math.round(trayBounds.y - winHeight);
  y = Math.min(Math.max(y, display.workArea.y + 4), display.workArea.y + display.workArea.height - winHeight - 4);

  win.setPosition(x, y, false);
  lastPopoverPosition = popoverPosition;
}

function registerPopoverActionHandlers(handlers) {
  onActionCallback = (action, ...args) => handlers[action]?.(...args);
  const wire = (channel, action) => {
    // removeHandler before handle makes this idempotent - ipcMain.handle
    // throws "Attempted to register a second handler" if initTray is ever
    // called more than once (review finding, 2026-07-23); removeHandler is
    // a documented no-op when nothing is registered yet, so this is safe
    // on the very first call too.
    ipcMain.removeHandler(channel);
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
  // These two actions existed in the popover's UI (Open window on the
  // recording card, Start capture on the meeting-detected card) but had no
  // dispatch case at all in popover-renderer.js - dead buttons on every
  // platform, not just Windows (review finding, 2026-07-23).
  wire('popover:openWindow', 'openWindow');
  wire('popover:joinDetected', 'joinDetected');
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
  // Manual popUpContextMenu on right-click only - see contextMenu's comment
  // above for why setContextMenu() is never used.
  tray.on('right-click', () => {
    if (contextMenu) tray.popUpContextMenu(contextMenu);
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

// render() only runs on discrete state-change events (meeting detected,
// upload progress, the 5-min next-event refresh, etc.) - with no periodic
// tick of its own, the OS tray pill's elapsed time ("● 12:41") would only
// update whenever some UNRELATED event happened to fire next, which during
// a quiet call could mean it never updates again after the initial
// "00:00" - a real desync bug (found via direct question, 2026-07-23), not
// hypothetical: the popover's own elapsed timer already ticks correctly
// (popover-renderer.js has its own local setInterval reading the same
// startedAt timestamp), but the native pill had no equivalent. This
// interval is the pill's equivalent tick, scoped to only run while
// recording so it doesn't burn CPU/battery the rest of the time.
let pillTickInterval = null;

/** Kept for main.js's existing call sites (recording-started/-ended) -
 * spec §6 migration note: don't break this input shape. */
function setRecordingActive(active, info = {}) {
  // startedAt is optional (falls back to capturing our own Date.now()) so
  // this doesn't break if some future call site doesn't have one to pass -
  // main.js's 'recording-started' handler does pass it, sharing the exact
  // same timestamp activeRecordings.addRecording() gets, instead of each
  // capturing an independent one a few ticks apart (TODOS.md #13, fixed
  // 2026-07-23).
  state.recording = active ? { platform: info.platform || 'unknown', startedAt: info.startedAt || Date.now() } : null;
  if (pillTickInterval) {
    clearInterval(pillTickInterval);
    pillTickInterval = null;
  }
  if (active) {
    // Only the pill (tray.setTitle, darwin-only) needs to re-render on this
    // tick - full render() also rebuilds the context menu and re-sends the
    // popover state, which pushStateToPopover already recomputes
    // elapsedSeconds fresh from startedAt on its own whenever it IS called,
    // so a lighter per-second tick here is enough for the pill specifically.
    pillTickInterval = setInterval(() => {
      if (tray && process.platform === 'darwin' && computeState() === 'recording') {
        tray.setTitle(pillText('recording'));
      }
    }, 1000);
  }
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
