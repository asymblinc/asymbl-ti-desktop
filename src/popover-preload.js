// Preload for the menu-bar tray popover window (screen 01). Deliberately a
// narrower surface than src/preload.js's electronAPI - the popover only
// needs to receive state and dispatch a handful of actions, not the full
// main-window IPC surface (notes/meetings/transcript etc.).
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('popoverAPI', {
  onState: (callback) => ipcRenderer.on('tray-state-update', (_, state) => callback(state)),
  openPreBrief: () => ipcRenderer.invoke('popover:openPreBrief'),
  skip: () => ipcRenderer.invoke('popover:skip'),
  startUnscheduledCall: () => ipcRenderer.invoke('popover:startUnscheduledCall'),
  openLibrary: () => ipcRenderer.invoke('popover:openLibrary'),
  openSettings: () => ipcRenderer.invoke('popover:openSettings'),
  signIn: () => ipcRenderer.invoke('popover:signIn'),
  stopRecording: () => ipcRenderer.invoke('popover:stopRecording'),
  openWindow: () => ipcRenderer.invoke('popover:openWindow'),
  joinDetected: () => ipcRenderer.invoke('popover:joinDetected'),
});
