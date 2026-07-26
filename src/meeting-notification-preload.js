// Preload for the meeting-notification panel window (screens 01b/01c, task
// #37). Same narrow-surface pattern as popover-preload.js - only what this
// window needs, not the full main-window electronAPI surface.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('notificationAPI', {
  onMeeting: (callback) => ipcRenderer.on('notification:meeting', (_, data) => callback(data)),
  startCapture: () => ipcRenderer.invoke('notification:startCapture'),
  sendBot: () => ipcRenderer.invoke('notification:sendBot'),
  openPreBrief: () => ipcRenderer.invoke('notification:openPreBrief'),
  remindLater: () => ipcRenderer.invoke('notification:remindLater'),
  dontCapture: () => ipcRenderer.invoke('notification:dontCapture'),
  dismiss: () => ipcRenderer.invoke('notification:dismiss'),
  requestResize: (height) => ipcRenderer.send('notification:resize', height),
});
