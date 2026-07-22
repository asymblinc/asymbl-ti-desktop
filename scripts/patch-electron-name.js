#!/usr/bin/env node
// Dev-mode Dock/menu-bar tooltip shows "Electron" because electron-forge
// start runs the raw node_modules/electron binary, whose bundle identity
// (CFBundleName/CFBundleDisplayName in Info.plist) is baked in before any
// app.setName() call runs. Patching the plist directly is the standard fix -
// runs post-install since node_modules isn't committed. macOS-only; a no-op
// (not an error) on other platforms or if the path doesn't exist yet.
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

if (process.platform !== 'darwin') {
  process.exit(0);
}

const plistPath = path.join(__dirname, '..', 'node_modules', 'electron', 'dist', 'Electron.app', 'Contents', 'Info.plist');
if (!fs.existsSync(plistPath)) {
  process.exit(0);
}

const NAME = 'Asymbl Recall';
for (const key of ['CFBundleName', 'CFBundleDisplayName']) {
  execFileSync('/usr/libexec/PlistBuddy', ['-c', `Set :${key} ${NAME}`, plistPath]);
}
console.log(`[patch-electron-name] Set ${plistPath}'s bundle name to "${NAME}"`);
