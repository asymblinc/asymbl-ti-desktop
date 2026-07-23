// Plain manual mock (no vitest dependency) so it can be `require()`d
// directly by Node's native CJS loader - see test/setup-electron-mock.cjs
// for why that matters. Reset between tests via __reset().
let windowImpl = () => ({});
const state = {
  browserWindowCalls: [],
  ipcHandlers: new Map(),
  ipcOnHandlers: new Map(),
  removedHandlers: [],
};

function BrowserWindow(options) {
  state.browserWindowCalls.push(options);
  return windowImpl(options);
}

const screen = {
  getCursorScreenPoint: () => ({ x: 0, y: 0 }),
  getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }),
};

const ipcMain = {
  handle: (channel, fn) => state.ipcHandlers.set(channel, fn),
  on: (channel, fn) => state.ipcOnHandlers.set(channel, fn),
  removeHandler: (channel) => state.removedHandlers.push(channel),
};

module.exports = {
  BrowserWindow,
  screen,
  ipcMain,
  __setWindowImpl: (fn) => {
    windowImpl = fn;
  },
  __state: state,
  __reset: () => {
    windowImpl = () => ({});
    state.browserWindowCalls = [];
    state.ipcHandlers.clear();
    state.ipcOnHandlers.clear();
    state.removedHandlers = [];
    screen.getCursorScreenPoint = () => ({ x: 0, y: 0 });
    screen.getDisplayNearestPoint = () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } });
  },
};
