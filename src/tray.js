// Menu-bar tray icon, shown only while a recording is active - real user
// testing found no menu-bar/floating presence at all while recording, so a
// backgrounded main window gave no indication a recording was in progress.
//
// Narrow scope (see docs/PLAN-desktop-redesign.md #20 for the full
// tray+popover redesign, which is a separate, larger task): just an icon
// that appears/disappears with recording state, click brings the main
// window to focus. No popover menu here.
//
// [UNVERIFIED - follow-up] tray-icon.png/@2x.png are resized copies of the
// existing full-color asymbl-icon.png, not a monochrome "template image".
// macOS renders template images correctly in both light and dark menu bars
// automatically; a plain color icon like this one may not look right on
// dark menu bars. Generating a proper template image needs real design
// work, not just a resize - tracked as a follow-up rather than done here.
const path = require('node:path');
const { app, Tray, nativeImage } = require('electron');

// __dirname resolves inside the webpack bundle (.webpack/main/), which
// doesn't copy static assets - app.getAppPath() (the project root in dev
// mode) is needed to find the real source file, same as main.js's dock icon.
const ICON_PATH = path.join(app.getAppPath(), 'src', 'assets', 'tray-icon.png');

let tray = null;
let mainWindowRef = null;

function setRecordingActive(active) {
  if (active) {
    showTray();
  } else {
    hideTray();
  }
}

function showTray() {
  if (tray) {
    return;
  }
  tray = new Tray(nativeImage.createFromPath(ICON_PATH));
  tray.setToolTip('Asymbl Recall - Recording in progress');
  tray.on('click', () => {
    if (!mainWindowRef || mainWindowRef.isDestroyed()) {
      return;
    }
    if (mainWindowRef.isMinimized()) {
      mainWindowRef.restore();
    }
    mainWindowRef.show();
    mainWindowRef.focus();
  });
}

function hideTray() {
  if (!tray) {
    return;
  }
  tray.destroy();
  tray = null;
}

function initTray(mainWindow) {
  mainWindowRef = mainWindow;
}

module.exports = { initTray, setRecordingActive };
