// Screen 01b/01c - the meeting-notification panel (task #37). Replaces the
// generic native Electron Notification main.js used to show on
// RecallAiSdk's 'meeting-detected' event with the real designed pill/
// dropdown. Same module-boundary pattern as tray.js: this file owns the
// window, main.js registers action handlers (registerNotificationActionHandlers)
// the same way it already does for the popover (registerPopoverActionHandlers).
const { BrowserWindow, screen, ipcMain } = require('electron');

let notificationWindow = null;
// Resolves once the current notificationWindow's renderer has actually
// registered its IPC listener - see showMeetingNotification for why this
// matters (real race found via code review, 2026-07-23).
let windowReadyPromise = null;
let onActionCallback = null;
// Session-lifetime only (not persisted to disk/DB) - matches the spec's
// "re-arms once" scope for suppression, which doesn't need to survive an
// app restart. A real per-tenant audit row for declines is a separate,
// currently-unbuilt backend path (see docs/implementation-01b-meeting-
// notification.md section 2 - logged as deferred, not silently dropped).
const suppressedMeetingUrls = new Set();

const COLLAPSED_HEIGHT = 58;
const PANEL_WIDTH = 430;
const TOP_MARGIN = 40; // 16px below a 24px menu-bar-ish margin, matches design's `top: 40` in meeting-notification.jsx
const RIGHT_MARGIN = 16;

function ensureNotificationWindow() {
  if (notificationWindow && !notificationWindow.isDestroyed()) return notificationWindow;
  notificationWindow = new BrowserWindow({
    width: PANEL_WIDTH,
    height: COLLAPSED_HEIGHT,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    // focusable defaults to true (real bug found via code review,
    // 2026-07-23): the original `focusable: false` here was based on a
    // misreading of its actual effect - it calls macOS's
    // setDisableKeyOrMainWindow, which blocks the window from EVER becoming
    // key and receiving ANY keyboard events, not just "activation". That
    // silently broke the R/D keyboard shortcuts wired in
    // meeting-notification-renderer.js's keydown listener - they could
    // never fire. showInactive() below is what actually satisfies "don't
    // steal focus on appear" (it shows without activating); focusable only
    // controls whether the window CAN later become key on click/interaction,
    // which the shortcuts require.
    backgroundColor: '#00000000',
    webPreferences: {
      preload: NOTIFICATION_WINDOW_PRELOAD_WEBPACK_ENTRY,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });
  const win = notificationWindow;
  windowReadyPromise = new Promise((resolve, reject) => {
    win.webContents.once('did-finish-load', resolve);
    win.webContents.once('did-fail-load', (_event, errorCode, errorDescription) => {
      reject(new Error(`notification window failed to load: ${errorDescription} (${errorCode})`));
    });
  });
  notificationWindow.loadURL(NOTIFICATION_WINDOW_WEBPACK_ENTRY);
  // 'screen-saver' level + visibleOnFullScreen: true is the researched
  // combination for appearing over a fullscreen Zoom/Meet window - the
  // panel's primary habitat per the spec ("this is its primary habitat").
  notificationWindow.setAlwaysOnTop(true, 'screen-saver');
  notificationWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  return notificationWindow;
}

function positionWindow(win) {
  // Display nearest the user's current cursor (their attention), not
  // primary - re-evaluated at each show, never tracked live while visible
  // (spec N5: "never chases the cursor live").
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const x = Math.round(display.workArea.x + display.workArea.width - PANEL_WIDTH - RIGHT_MARGIN);
  const y = Math.round(display.workArea.y + TOP_MARGIN);
  win.setPosition(x, y, false);
}

// [NOT IMPLEMENTED] macOS Focus/DND suppression (spec section 3 "DND / Focus
// modes"). Researched via Perplexity in two passes (2026-07-23), the second
// specifically checking whether newer APIs close this gap before concluding
// it's a real blocker: no official Electron/Node API exists for reading
// Focus/DND state. Explicitly checked and ruled out: (1) AppleScript - no
// public dictionary exposes it; (2) ActivityKit - iOS/Live-Activities only,
// unavailable on macOS entirely; (3) NSFocusStatusCenter (macOS 15+) - most
// likely scoped to apps already participating via a Focus Filter App
// Extension (or gated behind a special entitlement), not a plain global
// "is Focus on?" flag a generic Electron app could call - this couldn't be
// confirmed with 100% certainty (post-training-cutoff API), but the
// pattern matches every other Focus-related API Apple has shipped. Only
// remaining real options are the private, undocumented
// ~/Library/DoNotDisturb assertions file or a compiled native module, both
// out of scope here. A stub that always returns "not in DND" would be
// indistinguishable from not checking at all, so this is left genuinely
// unimplemented rather than faked - logged in TODOS.md, not silently dropped.

async function showMeetingNotification(meetingData) {
  if (suppressedMeetingUrls.has(meetingData.meetingUrl)) return;
  const win = ensureNotificationWindow();
  positionWindow(win);
  win.setBounds({ ...win.getBounds(), height: COLLAPSED_HEIGHT }, false);
  // Real race found via code review, 2026-07-23: on a freshly-created
  // window, loadURL() hasn't finished by the time this runs, so the
  // renderer's IPC listener (meeting-notification-renderer.js's onMeeting)
  // isn't registered yet - webContents.send() doesn't queue for a listener
  // that arrives later, it's just dropped, leaving the panel blank on the
  // very first notification after app launch. Awaiting did-finish-load
  // (already resolved for a reused window - see ensureNotificationWindow)
  // closes that gap without affecting the reused-window path.
  try {
    await windowReadyPromise;
  } catch (error) {
    console.error('meeting-notification-window: failed to load', error);
    if (notificationWindow === win) {
      notificationWindow = null;
      windowReadyPromise = null;
    }
    if (!win.isDestroyed()) win.destroy();
    return;
  }
  if (win.isDestroyed()) return;
  win.webContents.send('notification:meeting', meetingData);
  // showInactive(), never show() - the whole point is not stealing focus
  // from the meeting app the user is joining.
  win.showInactive();
}

function hideMeetingNotification() {
  if (notificationWindow && !notificationWindow.isDestroyed()) {
    notificationWindow.hide();
  }
}

function suppressMeeting(meetingUrl) {
  if (meetingUrl) suppressedMeetingUrls.add(meetingUrl);
}

function registerNotificationActionHandlers(handlers) {
  onActionCallback = (action, ...args) => handlers[action]?.(...args);
  const wire = (channel, action) => {
    ipcMain.removeHandler(channel);
    ipcMain.handle(channel, async (_event, ...args) => {
      const result = await onActionCallback(action, ...args);
      hideMeetingNotification();
      return result;
    });
  };
  wire('notification:startCapture', 'startCapture');
  wire('notification:sendBot', 'sendBot');
  wire('notification:openPreBrief', 'openPreBrief');
  wire('notification:remindLater', 'remindLater');
  wire('notification:dontCapture', 'dontCapture');

  // Plain dismiss - closes this notification only, no capture-policy side
  // effect (unlike dontCapture, which suppresses the meeting for the
  // session). Doesn't go through wire()/onActionCallback since there's no
  // business action to run, just hide the window.
  ipcMain.removeHandler('notification:dismiss');
  ipcMain.handle('notification:dismiss', () => {
    hideMeetingNotification();
  });

  ipcMain.removeHandler('notification:resize');
  ipcMain.on('notification:resize', (_event, height) => {
    if (notificationWindow && !notificationWindow.isDestroyed()) {
      const bounds = notificationWindow.getBounds();
      notificationWindow.setBounds({ ...bounds, height }, false);
    }
  });
}

module.exports = {
  showMeetingNotification,
  hideMeetingNotification,
  suppressMeeting,
  registerNotificationActionHandlers,
};
