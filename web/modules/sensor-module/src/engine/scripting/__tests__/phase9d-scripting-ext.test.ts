/**
 * Tests for Phase 9D: Scripting API Extensions.
 *
 * Validates the four new sandbox API methods:
 * - $setProperty: Dynamic widget config changes from scripts
 * - $getProperty: Read widget config properties from snapshot
 * - $closeDialog: Close topmost overlay from scripts
 * - $setAlarm: Raise runtime alarms from scripts
 *
 * Test categories:
 * 1. $setProperty routing and validation
 * 2. $setProperty security (prototype pollution, rate limiting)
 * 3. $getProperty snapshot access
 * 4. $closeDialog event dispatch
 * 5. $setAlarm creation and validation
 * 6. Worker source includes all new API functions
 * 7. Property path safety validation
 * 8. Backward compatibility (no callbacks = no-ops)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type {
  ScadaScript,
  WorkerRequest,
  WorkerResponse,
  TagPrimitive,
  AlarmLevel,
} from '../types';
import { SANDBOX_LIMITS } from '../types';
import { ScriptExecutor, isPropertyPathSafe } from '../ScriptExecutor';
import type { ScriptExecutorCallbacks } from '../ScriptExecutor';
import { getWorkerSource } from '../workerScript';
import { TagValueBus } from '../../tags/TagValueBus';
import { WidgetEventBus } from '../../events/WidgetEventBus';

/* ================================================================== */
/*  Mock Worker                                                        */
/* ================================================================== */

/**
 * Mock Worker that simulates the Web Worker message-passing protocol.
 * Mirrors the MockWorker from the Phase 5A tests but supports custom
 * handlers for testing Phase 9D API call routing.
 */
class MockWorker {
  onmessage: ((event: MessageEvent<WorkerResponse>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;

  static nextBehavior: 'success' | 'custom' = 'success';
  static customHandler: ((request: WorkerRequest) => void) | null = null;
  static instances: MockWorker[] = [];

  terminated = false;

  constructor(_url: string | URL, _options?: WorkerOptions) {
    MockWorker.instances.push(this);
  }

  postMessage(data: WorkerRequest): void {
    if (this.terminated) return;
    if (data.type !== 'execute') return;

    const scriptId = data.scriptId;

    if (MockWorker.nextBehavior === 'custom' && MockWorker.customHandler) {
      const handler = MockWorker.customHandler;
      setTimeout(() => handler.call(this, data), 0);
      return;
    }

    // Default: immediate success
    setTimeout(() => {
      this.onmessage?.({
        data: { type: 'result', scriptId, returnValue: undefined },
      } as MessageEvent<WorkerResponse>);
    }, 0);
  }

  terminate(): void {
    this.terminated = true;
    this.onmessage = null;
    this.onerror = null;
  }

  addEventListener(): void {
    /* no-op */
  }
  removeEventListener(): void {
    /* no-op */
  }
}

// Install mock Worker globally
const OriginalWorker = globalThis.Worker;
beforeEach(() => {
  MockWorker.instances = [];
  MockWorker.nextBehavior = 'success';
  MockWorker.customHandler = null;
  Object.defineProperty(globalThis, 'Worker', {
    configurable: true,
    writable: true,
    value: MockWorker,
  });
});
afterEach(() => {
  Object.defineProperty(globalThis, 'Worker', {
    configurable: true,
    writable: true,
    value: OriginalWorker,
  });
});

/* ================================================================== */
/*  Mock URL.createObjectURL / revokeObjectURL                         */
/* ================================================================== */

const mockCreateObjectURL = vi.fn(() => 'blob:mock-url');
const mockRevokeObjectURL = vi.fn();

beforeEach(() => {
  globalThis.URL.createObjectURL = mockCreateObjectURL;
  globalThis.URL.revokeObjectURL = mockRevokeObjectURL;
  mockCreateObjectURL.mockClear();
  mockRevokeObjectURL.mockClear();
});

/* ================================================================== */
/*  Helper factories                                                   */
/* ================================================================== */

function createScript(overrides: Partial<ScadaScript> = {}): ScadaScript {
  return {
    id: 'test-script-9d',
    name: 'Phase 9D Test Script',
    code: '$log("9d");',
    trigger: 'event',
    enabled: true,
    ...overrides,
  };
}

function createExecutor(callbacks?: ScriptExecutorCallbacks): {
  executor: ScriptExecutor;
  tagBus: TagValueBus;
  eventBus: WidgetEventBus;
} {
  const tagBus = new TagValueBus();
  const eventBus = new WidgetEventBus();
  const executor = new ScriptExecutor(tagBus, eventBus, callbacks);
  return { executor, tagBus, eventBus };
}

/* ================================================================== */
/*  1. $setProperty routing and validation                             */
/* ================================================================== */

describe('$setProperty API routing', () => {
  it('dispatches widget config update to onSetProperty callback', async () => {
    const onSetProperty = vi.fn();
    const { executor } = createExecutor({ onSetProperty });

    MockWorker.nextBehavior = 'custom';
    MockWorker.customHandler = function (this: MockWorker, req: WorkerRequest) {
      this.onmessage?.({
        data: {
          type: 'api-call',
          scriptId: req.scriptId,
          apiMethod: '$setProperty',
          apiArgs: ['widget-1', 'fillColor', '#ff0000'],
        },
      } as MessageEvent<WorkerResponse>);
      this.onmessage?.({
        data: { type: 'result', scriptId: req.scriptId, returnValue: undefined },
      } as MessageEvent<WorkerResponse>);
    };

    const result = await executor.execute(createScript());

    expect(result.success).toBe(true);
    expect(onSetProperty).toHaveBeenCalledWith('widget-1', 'fillColor', '#ff0000');

    executor.dispose();
  });

  it('increments tagWriteCounter for $setProperty calls (shared rate limit)', async () => {
    const onSetProperty = vi.fn();
    const { executor } = createExecutor({ onSetProperty });

    MockWorker.nextBehavior = 'custom';
    MockWorker.customHandler = function (this: MockWorker, req: WorkerRequest) {
      // Send 2 $setProperty + 1 $setTag = 3 total writes
      this.onmessage?.({
        data: {
          type: 'api-call',
          scriptId: req.scriptId,
          apiMethod: '$setProperty',
          apiArgs: ['w1', 'color', 'red'],
        },
      } as MessageEvent<WorkerResponse>);
      this.onmessage?.({
        data: {
          type: 'api-call',
          scriptId: req.scriptId,
          apiMethod: '$setProperty',
          apiArgs: ['w2', 'opacity', 0.5],
        },
      } as MessageEvent<WorkerResponse>);
      this.onmessage?.({
        data: {
          type: 'api-call',
          scriptId: req.scriptId,
          apiMethod: '$setTag',
          apiArgs: ['temperature', 25],
        },
      } as MessageEvent<WorkerResponse>);
      this.onmessage?.({
        data: { type: 'result', scriptId: req.scriptId, returnValue: undefined },
      } as MessageEvent<WorkerResponse>);
    };

    const result = await executor.execute(createScript());

    // $setProperty counts toward tagWrites -- 2 property + 1 tag = 3
    expect(result.tagWrites).toBe(3);
    expect(onSetProperty).toHaveBeenCalledTimes(2);

    executor.dispose();
  });

  it('rejects non-primitive values for $setProperty', async () => {
    const onSetProperty = vi.fn();
    const { executor } = createExecutor({ onSetProperty });

    MockWorker.nextBehavior = 'custom';
    MockWorker.customHandler = function (this: MockWorker, req: WorkerRequest) {
      this.onmessage?.({
        data: {
          type: 'api-call',
          scriptId: req.scriptId,
          apiMethod: '$setProperty',
          // Object value should be rejected
          apiArgs: ['widget-1', 'config', { nested: true }],
        },
      } as MessageEvent<WorkerResponse>);
      this.onmessage?.({
        data: { type: 'result', scriptId: req.scriptId, returnValue: undefined },
      } as MessageEvent<WorkerResponse>);
    };

    const result = await executor.execute(createScript());

    expect(onSetProperty).not.toHaveBeenCalled();
    expect(result.logs).toEqual(expect.arrayContaining([expect.stringContaining('BLOCKED')]));

    executor.dispose();
  });

  it('accepts number, string, and boolean values', async () => {
    const onSetProperty = vi.fn();
    const { executor } = createExecutor({ onSetProperty });

    MockWorker.nextBehavior = 'custom';
    MockWorker.customHandler = function (this: MockWorker, req: WorkerRequest) {
      this.onmessage?.({
        data: {
          type: 'api-call',
          scriptId: req.scriptId,
          apiMethod: '$setProperty',
          apiArgs: ['w1', 'opacity', 0.75],
        },
      } as MessageEvent<WorkerResponse>);
      this.onmessage?.({
        data: {
          type: 'api-call',
          scriptId: req.scriptId,
          apiMethod: '$setProperty',
          apiArgs: ['w1', 'label', 'Tank A'],
        },
      } as MessageEvent<WorkerResponse>);
      this.onmessage?.({
        data: {
          type: 'api-call',
          scriptId: req.scriptId,
          apiMethod: '$setProperty',
          apiArgs: ['w1', 'visible', false],
        },
      } as MessageEvent<WorkerResponse>);
      this.onmessage?.({
        data: { type: 'result', scriptId: req.scriptId, returnValue: undefined },
      } as MessageEvent<WorkerResponse>);
    };

    await executor.execute(createScript());

    expect(onSetProperty).toHaveBeenCalledTimes(3);
    expect(onSetProperty).toHaveBeenCalledWith('w1', 'opacity', 0.75);
    expect(onSetProperty).toHaveBeenCalledWith('w1', 'label', 'Tank A');
    expect(onSetProperty).toHaveBeenCalledWith('w1', 'visible', false);

    executor.dispose();
  });
});

/* ================================================================== */
/*  2. $setProperty security (prototype pollution, path validation)    */
/* ================================================================== */

describe('$setProperty security', () => {
  it('rejects __proto__ property path (prototype pollution)', async () => {
    const onSetProperty = vi.fn();
    const { executor } = createExecutor({ onSetProperty });

    MockWorker.nextBehavior = 'custom';
    MockWorker.customHandler = function (this: MockWorker, req: WorkerRequest) {
      this.onmessage?.({
        data: {
          type: 'api-call',
          scriptId: req.scriptId,
          apiMethod: '$setProperty',
          apiArgs: ['widget-1', '__proto__', 'malicious'],
        },
      } as MessageEvent<WorkerResponse>);
      this.onmessage?.({
        data: { type: 'result', scriptId: req.scriptId, returnValue: undefined },
      } as MessageEvent<WorkerResponse>);
    };

    const result = await executor.execute(createScript());

    expect(onSetProperty).not.toHaveBeenCalled();
    expect(result.logs).toEqual(
      expect.arrayContaining([expect.stringContaining('unsafe property path')]),
    );

    executor.dispose();
  });

  it('rejects constructor property path (prototype pollution)', async () => {
    const onSetProperty = vi.fn();
    const { executor } = createExecutor({ onSetProperty });

    MockWorker.nextBehavior = 'custom';
    MockWorker.customHandler = function (this: MockWorker, req: WorkerRequest) {
      this.onmessage?.({
        data: {
          type: 'api-call',
          scriptId: req.scriptId,
          apiMethod: '$setProperty',
          apiArgs: ['widget-1', 'constructor', 'malicious'],
        },
      } as MessageEvent<WorkerResponse>);
      this.onmessage?.({
        data: { type: 'result', scriptId: req.scriptId, returnValue: undefined },
      } as MessageEvent<WorkerResponse>);
    };

    const result = await executor.execute(createScript());

    expect(onSetProperty).not.toHaveBeenCalled();
    expect(result.logs).toEqual(
      expect.arrayContaining([expect.stringContaining('unsafe property path')]),
    );

    executor.dispose();
  });

  it('rejects nested prototype pollution path (config.__proto__.polluted)', async () => {
    const onSetProperty = vi.fn();
    const { executor } = createExecutor({ onSetProperty });

    MockWorker.nextBehavior = 'custom';
    MockWorker.customHandler = function (this: MockWorker, req: WorkerRequest) {
      this.onmessage?.({
        data: {
          type: 'api-call',
          scriptId: req.scriptId,
          apiMethod: '$setProperty',
          apiArgs: ['widget-1', 'config.__proto__.polluted', 'yes'],
        },
      } as MessageEvent<WorkerResponse>);
      this.onmessage?.({
        data: { type: 'result', scriptId: req.scriptId, returnValue: undefined },
      } as MessageEvent<WorkerResponse>);
    };

    const result = await executor.execute(createScript());
    expect(onSetProperty).not.toHaveBeenCalled();

    executor.dispose();
  });

  it('rejects paths with bracket notation (potential injection)', async () => {
    const onSetProperty = vi.fn();
    const { executor } = createExecutor({ onSetProperty });

    MockWorker.nextBehavior = 'custom';
    MockWorker.customHandler = function (this: MockWorker, req: WorkerRequest) {
      this.onmessage?.({
        data: {
          type: 'api-call',
          scriptId: req.scriptId,
          apiMethod: '$setProperty',
          apiArgs: ['widget-1', 'items[0]', 'bad'],
        },
      } as MessageEvent<WorkerResponse>);
      this.onmessage?.({
        data: { type: 'result', scriptId: req.scriptId, returnValue: undefined },
      } as MessageEvent<WorkerResponse>);
    };

    const result = await executor.execute(createScript());
    expect(onSetProperty).not.toHaveBeenCalled();

    executor.dispose();
  });
});

/* ================================================================== */
/*  3. $getProperty snapshot access                                    */
/* ================================================================== */

describe('$getProperty snapshot access', () => {
  it('includes widgetProperties in the worker request', async () => {
    const widgetSnapshot: Record<string, Record<string, TagPrimitive>> = {
      'widget-1': { fillColor: '#00ff00', opacity: 0.8, label: 'Tank A' },
      'widget-2': { fillColor: '#ff0000', visible: true },
    };

    const { executor } = createExecutor({
      getWidgetPropertySnapshot: () => widgetSnapshot,
    });

    let capturedRequest: WorkerRequest | null = null;
    MockWorker.nextBehavior = 'custom';
    MockWorker.customHandler = function (this: MockWorker, req: WorkerRequest) {
      capturedRequest = req;
      this.onmessage?.({
        data: { type: 'result', scriptId: req.scriptId, returnValue: undefined },
      } as MessageEvent<WorkerResponse>);
    };

    await executor.execute(createScript());

    expect(capturedRequest).not.toBeNull();
    expect(capturedRequest!.widgetProperties).toEqual(widgetSnapshot);

    executor.dispose();
  });

  it('sends undefined widgetProperties when no snapshot callback is provided', async () => {
    const { executor } = createExecutor();

    let capturedRequest: WorkerRequest | null = null;
    MockWorker.nextBehavior = 'custom';
    MockWorker.customHandler = function (this: MockWorker, req: WorkerRequest) {
      capturedRequest = req;
      this.onmessage?.({
        data: { type: 'result', scriptId: req.scriptId, returnValue: undefined },
      } as MessageEvent<WorkerResponse>);
    };

    await executor.execute(createScript());

    expect(capturedRequest).not.toBeNull();
    expect(capturedRequest!.widgetProperties).toBeUndefined();

    executor.dispose();
  });
});

/* ================================================================== */
/*  4. $closeDialog event dispatch                                     */
/* ================================================================== */

describe('$closeDialog API routing', () => {
  it('dispatches closeDialog event to WidgetEventBus', async () => {
    const { executor, eventBus } = createExecutor();
    const dispatchSpy = vi.spyOn(eventBus, 'dispatch');

    MockWorker.nextBehavior = 'custom';
    MockWorker.customHandler = function (this: MockWorker, req: WorkerRequest) {
      this.onmessage?.(
        new MessageEvent<WorkerResponse>('message', {
          data: {
            type: 'api-call',
            scriptId: req.scriptId,
            apiMethod: '$closeDialog',
            apiArgs: [],
          },
        }),
      );
      this.onmessage?.({
        data: { type: 'result', scriptId: req.scriptId, returnValue: undefined },
      } as MessageEvent<WorkerResponse>);
    };

    const result = await executor.execute(createScript());

    expect(result.success).toBe(true);
    expect(dispatchSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        widgetId: '__script__',
        action: 'closeDialog',
        params: {},
      }),
    );

    executor.dispose();
  });

  it('is a no-op when no overlays are open (CloseDialogHandler handles this)', async () => {
    // This test verifies the executor dispatches the event regardless --
    // the no-op behavior is handled by CloseDialogHandler, not the executor.
    const { executor, eventBus } = createExecutor();
    const dispatchSpy = vi.spyOn(eventBus, 'dispatch');

    MockWorker.nextBehavior = 'custom';
    MockWorker.customHandler = function (this: MockWorker, req: WorkerRequest) {
      this.onmessage?.(
        new MessageEvent<WorkerResponse>('message', {
          data: {
            type: 'api-call',
            scriptId: req.scriptId,
            apiMethod: '$closeDialog',
            apiArgs: [],
          },
        }),
      );
      this.onmessage?.({
        data: { type: 'result', scriptId: req.scriptId, returnValue: undefined },
      } as MessageEvent<WorkerResponse>);
    };

    const result = await executor.execute(createScript());

    // Event was dispatched -- the handler determines no-op behavior
    expect(result.success).toBe(true);
    expect(dispatchSpy).toHaveBeenCalledTimes(1);

    executor.dispose();
  });
});

/* ================================================================== */
/*  5. $setAlarm creation and validation                               */
/* ================================================================== */

describe('$setAlarm API routing', () => {
  it('creates alarm entry with correct level via onAlarm callback', async () => {
    const onAlarm = vi.fn();
    const { executor } = createExecutor({ onAlarm });

    MockWorker.nextBehavior = 'custom';
    MockWorker.customHandler = function (this: MockWorker, req: WorkerRequest) {
      this.onmessage?.({
        data: {
          type: 'api-call',
          scriptId: req.scriptId,
          apiMethod: '$setAlarm',
          apiArgs: ['pH', 'critical', 'pH below safe threshold'],
        },
      } as MessageEvent<WorkerResponse>);
      this.onmessage?.({
        data: { type: 'result', scriptId: req.scriptId, returnValue: undefined },
      } as MessageEvent<WorkerResponse>);
    };

    const result = await executor.execute(createScript());

    expect(result.success).toBe(true);
    expect(onAlarm).toHaveBeenCalledWith('pH', 'critical', 'pH below safe threshold');

    executor.dispose();
  });

  it('accepts all valid alarm levels', async () => {
    const onAlarm = vi.fn();
    const { executor } = createExecutor({ onAlarm });

    const levels: AlarmLevel[] = ['info', 'warning', 'critical', 'emergency'];

    MockWorker.nextBehavior = 'custom';
    MockWorker.customHandler = function (this: MockWorker, req: WorkerRequest) {
      for (const level of levels) {
        this.onmessage?.({
          data: {
            type: 'api-call',
            scriptId: req.scriptId,
            apiMethod: '$setAlarm',
            apiArgs: ['tag1', level, `Test ${level}`],
          },
        } as MessageEvent<WorkerResponse>);
      }
      this.onmessage?.({
        data: { type: 'result', scriptId: req.scriptId, returnValue: undefined },
      } as MessageEvent<WorkerResponse>);
    };

    await executor.execute(createScript());

    expect(onAlarm).toHaveBeenCalledTimes(4);
    for (const level of levels) {
      expect(onAlarm).toHaveBeenCalledWith('tag1', level, `Test ${level}`);
    }

    executor.dispose();
  });

  it('rejects invalid alarm level', async () => {
    const onAlarm = vi.fn();
    const { executor } = createExecutor({ onAlarm });

    MockWorker.nextBehavior = 'custom';
    MockWorker.customHandler = function (this: MockWorker, req: WorkerRequest) {
      this.onmessage?.({
        data: {
          type: 'api-call',
          scriptId: req.scriptId,
          apiMethod: '$setAlarm',
          apiArgs: ['pH', 'severe', 'This is bad'],
        },
      } as MessageEvent<WorkerResponse>);
      this.onmessage?.({
        data: { type: 'result', scriptId: req.scriptId, returnValue: undefined },
      } as MessageEvent<WorkerResponse>);
    };

    const result = await executor.execute(createScript());

    expect(onAlarm).not.toHaveBeenCalled();
    expect(result.logs).toEqual(expect.arrayContaining([expect.stringContaining('invalid level')]));

    executor.dispose();
  });

  it('rejects alarm message exceeding 500 characters', async () => {
    const onAlarm = vi.fn();
    const { executor } = createExecutor({ onAlarm });

    const longMessage = 'x'.repeat(501);

    MockWorker.nextBehavior = 'custom';
    MockWorker.customHandler = function (this: MockWorker, req: WorkerRequest) {
      this.onmessage?.({
        data: {
          type: 'api-call',
          scriptId: req.scriptId,
          apiMethod: '$setAlarm',
          apiArgs: ['pH', 'warning', longMessage],
        },
      } as MessageEvent<WorkerResponse>);
      this.onmessage?.({
        data: { type: 'result', scriptId: req.scriptId, returnValue: undefined },
      } as MessageEvent<WorkerResponse>);
    };

    const result = await executor.execute(createScript());

    expect(onAlarm).not.toHaveBeenCalled();
    expect(result.logs).toEqual(
      expect.arrayContaining([expect.stringContaining('500 character limit')]),
    );

    executor.dispose();
  });

  it('accepts alarm message at exactly 500 characters', async () => {
    const onAlarm = vi.fn();
    const { executor } = createExecutor({ onAlarm });

    const exactMessage = 'x'.repeat(500);

    MockWorker.nextBehavior = 'custom';
    MockWorker.customHandler = function (this: MockWorker, req: WorkerRequest) {
      this.onmessage?.({
        data: {
          type: 'api-call',
          scriptId: req.scriptId,
          apiMethod: '$setAlarm',
          apiArgs: ['pH', 'info', exactMessage],
        },
      } as MessageEvent<WorkerResponse>);
      this.onmessage?.({
        data: { type: 'result', scriptId: req.scriptId, returnValue: undefined },
      } as MessageEvent<WorkerResponse>);
    };

    await executor.execute(createScript());

    expect(onAlarm).toHaveBeenCalledWith('pH', 'info', exactMessage);

    executor.dispose();
  });
});

/* ================================================================== */
/*  6. Worker source includes all new API functions                    */
/* ================================================================== */

describe('getWorkerSource includes Phase 9D API functions', () => {
  it('contains $setProperty function definition', () => {
    const source = getWorkerSource();
    expect(source).toContain('function $setProperty');
  });

  it('contains $getProperty function definition', () => {
    const source = getWorkerSource();
    expect(source).toContain('function $getProperty');
  });

  it('contains $closeDialog function definition', () => {
    const source = getWorkerSource();
    expect(source).toContain('function $closeDialog');
  });

  it('contains $setAlarm function definition', () => {
    const source = getWorkerSource();
    expect(source).toContain('function $setAlarm');
  });

  it('passes all 10 sandbox API functions + $params to the Function constructor', () => {
    const source = getWorkerSource();
    // Verify the new Function() call includes all API method names
    expect(source).toContain("'$setProperty'");
    expect(source).toContain("'$getProperty'");
    expect(source).toContain("'$closeDialog'");
    expect(source).toContain("'$setAlarm'");
  });

  it('contains _widgetProperties snapshot storage', () => {
    const source = getWorkerSource();
    expect(source).toContain('_widgetProperties');
  });

  it('contains property path safety validation in worker', () => {
    const source = getWorkerSource();
    expect(source).toContain('_isPropertyPathSafe');
    expect(source).toContain('__proto__');
    expect(source).toContain('constructor');
    expect(source).toContain('prototype');
  });

  it('contains alarm level validation in worker', () => {
    const source = getWorkerSource();
    expect(source).toContain("'info'");
    expect(source).toContain("'warning'");
    expect(source).toContain("'critical'");
    expect(source).toContain("'emergency'");
  });

  it('populates _widgetProperties from the message data', () => {
    const source = getWorkerSource();
    expect(source).toContain('widgetProperties');
    // Ensure the snapshot is populated before script execution
    expect(source).toContain('Object.assign(_widgetProperties');
  });
});

/* ================================================================== */
/*  7. isPropertyPathSafe validation (exported for reuse)              */
/* ================================================================== */

describe('isPropertyPathSafe', () => {
  it('accepts simple property names', () => {
    expect(isPropertyPathSafe('fillColor')).toBe(true);
    expect(isPropertyPathSafe('opacity')).toBe(true);
    expect(isPropertyPathSafe('visible')).toBe(true);
  });

  it('accepts dot-separated paths', () => {
    expect(isPropertyPathSafe('config.fill')).toBe(true);
    expect(isPropertyPathSafe('style.border.color')).toBe(true);
  });

  it('accepts paths with underscores and hyphens', () => {
    expect(isPropertyPathSafe('fill_color')).toBe(true);
    expect(isPropertyPathSafe('font-size')).toBe(true);
    expect(isPropertyPathSafe('config.font_weight')).toBe(true);
  });

  it('rejects __proto__', () => {
    expect(isPropertyPathSafe('__proto__')).toBe(false);
  });

  it('rejects constructor', () => {
    expect(isPropertyPathSafe('constructor')).toBe(false);
  });

  it('rejects prototype', () => {
    expect(isPropertyPathSafe('prototype')).toBe(false);
  });

  it('rejects nested __proto__ paths', () => {
    expect(isPropertyPathSafe('a.__proto__.b')).toBe(false);
    expect(isPropertyPathSafe('config.__proto__')).toBe(false);
  });

  it('rejects empty string', () => {
    expect(isPropertyPathSafe('')).toBe(false);
  });

  it('rejects consecutive dots', () => {
    expect(isPropertyPathSafe('a..b')).toBe(false);
  });

  it('rejects paths with brackets', () => {
    expect(isPropertyPathSafe('items[0]')).toBe(false);
  });

  it('rejects paths with special characters', () => {
    expect(isPropertyPathSafe('a=b')).toBe(false);
    expect(isPropertyPathSafe('a;b')).toBe(false);
    expect(isPropertyPathSafe('a b')).toBe(false);
  });

  it('rejects paths exceeding 200 characters', () => {
    const longPath = 'a'.repeat(201);
    expect(isPropertyPathSafe(longPath)).toBe(false);
  });

  it('accepts paths at exactly 200 characters', () => {
    const maxPath = 'a'.repeat(200);
    expect(isPropertyPathSafe(maxPath)).toBe(true);
  });
});

/* ================================================================== */
/*  8. Backward compatibility (no callbacks = no-ops)                  */
/* ================================================================== */

describe('backward compatibility without callbacks', () => {
  it('$setProperty is a no-op when onSetProperty callback is not provided', async () => {
    // Create executor without any callbacks
    const { executor } = createExecutor();

    MockWorker.nextBehavior = 'custom';
    MockWorker.customHandler = function (this: MockWorker, req: WorkerRequest) {
      this.onmessage?.({
        data: {
          type: 'api-call',
          scriptId: req.scriptId,
          apiMethod: '$setProperty',
          apiArgs: ['widget-1', 'fillColor', '#ff0000'],
        },
      } as MessageEvent<WorkerResponse>);
      this.onmessage?.({
        data: { type: 'result', scriptId: req.scriptId, returnValue: undefined },
      } as MessageEvent<WorkerResponse>);
    };

    // Should succeed without error -- the $setProperty is silently ignored
    const result = await executor.execute(createScript());
    expect(result.success).toBe(true);

    executor.dispose();
  });

  it('$setAlarm is a no-op when onAlarm callback is not provided', async () => {
    const { executor } = createExecutor();

    MockWorker.nextBehavior = 'custom';
    MockWorker.customHandler = function (this: MockWorker, req: WorkerRequest) {
      this.onmessage?.({
        data: {
          type: 'api-call',
          scriptId: req.scriptId,
          apiMethod: '$setAlarm',
          apiArgs: ['pH', 'critical', 'Low pH'],
        },
      } as MessageEvent<WorkerResponse>);
      this.onmessage?.({
        data: { type: 'result', scriptId: req.scriptId, returnValue: undefined },
      } as MessageEvent<WorkerResponse>);
    };

    const result = await executor.execute(createScript());
    expect(result.success).toBe(true);

    executor.dispose();
  });

  it('constructor without third arg is backward compatible', () => {
    const tagBus = new TagValueBus();
    const eventBus = new WidgetEventBus();

    // This should not throw -- callbacks parameter is optional
    const executor = new ScriptExecutor(tagBus, eventBus);
    expect(executor).toBeDefined();

    executor.dispose();
  });
});

/* ================================================================== */
/*  9. Type validation on API arguments                                */
/* ================================================================== */

describe('API argument type validation', () => {
  it('$setProperty rejects non-string widgetId', async () => {
    const onSetProperty = vi.fn();
    const { executor } = createExecutor({ onSetProperty });

    MockWorker.nextBehavior = 'custom';
    MockWorker.customHandler = function (this: MockWorker, req: WorkerRequest) {
      this.onmessage?.({
        data: {
          type: 'api-call',
          scriptId: req.scriptId,
          apiMethod: '$setProperty',
          apiArgs: [123, 'fillColor', '#ff0000'],
        },
      } as MessageEvent<WorkerResponse>);
      this.onmessage?.({
        data: { type: 'result', scriptId: req.scriptId, returnValue: undefined },
      } as MessageEvent<WorkerResponse>);
    };

    await executor.execute(createScript());
    expect(onSetProperty).not.toHaveBeenCalled();

    executor.dispose();
  });

  it('$setAlarm rejects non-string tagName', async () => {
    const onAlarm = vi.fn();
    const { executor } = createExecutor({ onAlarm });

    MockWorker.nextBehavior = 'custom';
    MockWorker.customHandler = function (this: MockWorker, req: WorkerRequest) {
      this.onmessage?.({
        data: {
          type: 'api-call',
          scriptId: req.scriptId,
          apiMethod: '$setAlarm',
          apiArgs: [42, 'critical', 'bad tag'],
        },
      } as MessageEvent<WorkerResponse>);
      this.onmessage?.({
        data: { type: 'result', scriptId: req.scriptId, returnValue: undefined },
      } as MessageEvent<WorkerResponse>);
    };

    await executor.execute(createScript());
    expect(onAlarm).not.toHaveBeenCalled();

    executor.dispose();
  });

  it('$setAlarm rejects non-string message', async () => {
    const onAlarm = vi.fn();
    const { executor } = createExecutor({ onAlarm });

    MockWorker.nextBehavior = 'custom';
    MockWorker.customHandler = function (this: MockWorker, req: WorkerRequest) {
      this.onmessage?.({
        data: {
          type: 'api-call',
          scriptId: req.scriptId,
          apiMethod: '$setAlarm',
          apiArgs: ['pH', 'critical', 12345],
        },
      } as MessageEvent<WorkerResponse>);
      this.onmessage?.({
        data: { type: 'result', scriptId: req.scriptId, returnValue: undefined },
      } as MessageEvent<WorkerResponse>);
    };

    await executor.execute(createScript());
    expect(onAlarm).not.toHaveBeenCalled();

    executor.dispose();
  });
});
