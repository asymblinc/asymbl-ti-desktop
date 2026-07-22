#!/usr/bin/env node
// Dev-mode Dock hover-tooltip and the "System Events" process name still
// showed "Electron" even after app.setName('Asymbl Recall') (fixes the menu
// bar text) and after this script previously only patched Info.plist's
// CFBundleName/CFBundleDisplayName. Verified via:
//   osascript -e 'tell application "System Events" to get name of every process whose unix id is <pid>'
// That surface reflects the actual bundle directory/executable name, not the
// Info.plist display keys, so the fix is to rename the bundle directory and
// its executable, update CFBundleExecutable to match, and update electron's
// own path.txt (which electron-forge's `npm start` reads via
// require('electron')) so the renamed binary can still be found and
// launched. macOS-only; a no-op (not an error) on other platforms or if the
// path doesn't exist yet. Runs post-install since node_modules isn't
// committed. Idempotent - safe to run again if the bundle is already renamed.
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

if (process.platform !== 'darwin') {
  process.exit(0);
}

const NAME = 'Asymbl Recall';
const distDir = path.join(__dirname, '..', 'node_modules', 'electron', 'dist');
const oldAppPath = path.join(distDir, 'Electron.app');
const newAppPath = path.join(distDir, `${NAME}.app`);

if (!fs.existsSync(oldAppPath) && !fs.existsSync(newAppPath)) {
  process.exit(0);
}

if (fs.existsSync(oldAppPath)) {
  fs.renameSync(oldAppPath, newAppPath);
}

const oldExecPath = path.join(newAppPath, 'Contents', 'MacOS', 'Electron');
const newExecPath = path.join(newAppPath, 'Contents', 'MacOS', NAME);
if (fs.existsSync(oldExecPath)) {
  fs.renameSync(oldExecPath, newExecPath);
}

const plistPath = path.join(newAppPath, 'Contents', 'Info.plist');
for (const key of ['CFBundleName', 'CFBundleDisplayName', 'CFBundleExecutable']) {
  execFileSync('/usr/libexec/PlistBuddy', ['-c', `Set :${key} ${NAME}`, plistPath]);
}

// electron-forge's `npm start` locates the binary through node_modules/electron's
// own index.js, which reads this relative path - it must match the renamed bundle.
const pathTxt = path.join(__dirname, '..', 'node_modules', 'electron', 'path.txt');
fs.writeFileSync(pathTxt, `${NAME}.app/Contents/MacOS/${NAME}`);

console.log(`[patch-electron-name] Renamed Electron.app bundle/executable to "${NAME}"`);
