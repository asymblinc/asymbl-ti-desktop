import { describe, it, expect, vi } from 'vitest';
import sdkLogger from '../src/sdk-logger.js';

describe('sdk-logger', () => {
  it('logApiCall emits a log event with method and params', () => {
    const received = [];
    const onLog = (entry) => received.push(entry);
    sdkLogger.onLog(onLog);

    sdkLogger.logApiCall('startRecording', { windowId: 'w1' });

    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      type: 'api-call',
      method: 'startRecording',
      params: { windowId: 'w1' },
    });
    expect(received[0].timestamp).toBeInstanceOf(Date);

    sdkLogger.removeLogListener(onLog);
  });

  it('logError emits a log event with errorType and message', () => {
    const onLog = vi.fn();
    sdkLogger.onLog(onLog);

    sdkLogger.logError('sdk-timeout', 'Recording did not start in time');

    expect(onLog).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'error', errorType: 'sdk-timeout', message: 'Recording did not start in time' })
    );

    sdkLogger.removeLogListener(onLog);
  });

  it('removeLogListener stops further events reaching a removed listener', () => {
    const onLog = vi.fn();
    sdkLogger.onLog(onLog);
    sdkLogger.removeLogListener(onLog);

    sdkLogger.log('should not be received');

    expect(onLog).not.toHaveBeenCalled();
  });
});
