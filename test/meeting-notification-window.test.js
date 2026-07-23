import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRequire } from 'node:module';

// meeting-notification-window.js loads 'electron' via Node's native
// require() (see test/setup-electron-mock.cjs for why), which uses Node's
// own require.cache - a separate cache from vite-node's module graph. If
// this test file used a plain ESM `import` for the mock, it would get a
// SEPARATE, independently-stateful copy of electron.cjs. Using Node's own
// createRequire here guarantees both loads hit the same cached instance.
const electronMock = createRequire(import.meta.url)('./mocks/electron.cjs');

vi.stubGlobal('NOTIFICATION_WINDOW_PRELOAD_WEBPACK_ENTRY', '/preload.js');
vi.stubGlobal('NOTIFICATION_WINDOW_WEBPACK_ENTRY', '/index.html');

const {
  showMeetingNotification,
  hideMeetingNotification,
  suppressMeeting,
  registerNotificationActionHandlers,
} = await import('../src/meeting-notification-window.js');

function makeMockWindow() {
  return {
    loadURL: vi.fn(),
    setAlwaysOnTop: vi.fn(),
    setVisibleOnAllWorkspaces: vi.fn(),
    setBounds: vi.fn(),
    setPosition: vi.fn(),
    getBounds: vi.fn(() => ({ x: 0, y: 0, width: 430, height: 58 })),
    // once('did-finish-load', cb) fires synchronously (queued as a
    // microtask via Promise.resolve()) so tests don't need to fake timers -
    // ensureNotificationWindow's windowReadyPromise resolves on the next
    // microtask, same as a real (instant, in-test) page load would.
    webContents: { send: vi.fn(), once: vi.fn((_event, cb) => Promise.resolve().then(cb)) },
    showInactive: vi.fn(),
    hide: vi.fn(),
    isDestroyed: vi.fn(() => false),
  };
}

// meeting-notification-window.js keeps its BrowserWindow instance as
// module-scope singleton state (by design - one real OS window, reused
// across shows). Each test gets its OWN mock window object by making the
// *previous* test's window report isDestroyed()=true, so
// ensureNotificationWindow() discards it and constructs a fresh one. Each
// test also uses a distinct meetingUrl so suppressMeeting's module-level
// Set can't leak between tests.
let mockWindow;

beforeEach(() => {
  if (mockWindow) mockWindow.isDestroyed.mockReturnValue(true);
  mockWindow = makeMockWindow();
  electronMock.__reset();
  electronMock.__setWindowImpl(() => mockWindow);
});

describe('meeting-notification-window', () => {
  it('hideMeetingNotification does not throw before any window has ever been created', () => {
    expect(() => hideMeetingNotification()).not.toThrow();
  });

  it('creates the window, positions it, and shows it without stealing focus', async () => {
    await showMeetingNotification({ meetingUrl: 'https://zoom.us/j/test1', title: 'Standup' });

    expect(electronMock.__state.browserWindowCalls).toHaveLength(1);
    expect(mockWindow.setPosition).toHaveBeenCalledTimes(1);
    expect(mockWindow.webContents.send).toHaveBeenCalledWith('notification:meeting', {
      meetingUrl: 'https://zoom.us/j/test1',
      title: 'Standup',
    });
    expect(mockWindow.showInactive).toHaveBeenCalledTimes(1);
  });

  it('reuses the existing window on a second call instead of creating another one', async () => {
    await showMeetingNotification({ meetingUrl: 'https://zoom.us/j/test2a' });
    await showMeetingNotification({ meetingUrl: 'https://zoom.us/j/test2b' });

    expect(electronMock.__state.browserWindowCalls).toHaveLength(1);
  });

  it('suppressMeeting prevents that meeting URL from ever showing again', async () => {
    suppressMeeting('https://zoom.us/j/test3');
    await showMeetingNotification({ meetingUrl: 'https://zoom.us/j/test3' });

    expect(electronMock.__state.browserWindowCalls).toHaveLength(0);
    expect(mockWindow.showInactive).not.toHaveBeenCalled();
  });

  it('suppressMeeting does not affect a different meeting URL', async () => {
    suppressMeeting('https://zoom.us/j/test4-other');
    await showMeetingNotification({ meetingUrl: 'https://zoom.us/j/test4' });

    expect(mockWindow.showInactive).toHaveBeenCalledTimes(1);
  });

  it('suppressMeeting is a no-op (does not throw) when given a falsy meetingUrl', () => {
    expect(() => suppressMeeting(null)).not.toThrow();
    expect(() => suppressMeeting(undefined)).not.toThrow();
  });

  it('hideMeetingNotification hides the window when one exists and is not destroyed', async () => {
    await showMeetingNotification({ meetingUrl: 'https://zoom.us/j/test6' });
    hideMeetingNotification();

    expect(mockWindow.hide).toHaveBeenCalledTimes(1);
  });

  it('hideMeetingNotification does not call hide() on an already-destroyed window', async () => {
    await showMeetingNotification({ meetingUrl: 'https://zoom.us/j/test7' });
    mockWindow.isDestroyed.mockReturnValue(true);
    hideMeetingNotification();

    expect(mockWindow.hide).not.toHaveBeenCalled();
  });

  it('registerNotificationActionHandlers wires each action to its handler and hides the panel afterward', async () => {
    const startCapture = vi.fn().mockResolvedValue('started');
    registerNotificationActionHandlers({ startCapture });

    const handler = electronMock.__state.ipcHandlers.get('notification:startCapture');
    expect(handler).toBeTruthy();

    await showMeetingNotification({ meetingUrl: 'https://zoom.us/j/test8' });
    const result = await handler(/* event */ {});

    expect(startCapture).toHaveBeenCalledTimes(1);
    expect(result).toBe('started');
    expect(mockWindow.hide).toHaveBeenCalledTimes(1);
  });

  it('registerNotificationActionHandlers wires the resize channel to update the window height', async () => {
    registerNotificationActionHandlers({});
    await showMeetingNotification({ meetingUrl: 'https://zoom.us/j/test9' });

    const resizeHandler = electronMock.__state.ipcOnHandlers.get('notification:resize');
    expect(resizeHandler).toBeTruthy();
    resizeHandler({}, 220);

    expect(mockWindow.setBounds).toHaveBeenCalledWith(expect.objectContaining({ height: 220 }), false);
  });
});
