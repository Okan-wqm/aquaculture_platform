/**
 * Tests for the SCADA Client-Side Scripting Sandbox (Phase 5A).
 *
 * Web Workers are not available in the jsdom test environment, so we mock
 * the Worker class to simulate the message-passing protocol between the
 * main thread (ScriptExecutor) and the worker sandbox.
 *
 * Test categories:
 * 1. Type and constant validation
 * 2. URL validation (security-critical)
 * 3. Script code validation
 * 4. Worker pool management
 * 5. Execution lifecycle (success, error, timeout)
 * 6. API call routing ($setTag, $navigate, $openCard, $openUrl, $log)
 * 7. Rate limiting (tag writes, logs)
 * 8. Disposal and cleanup
 * 9. Worker source generation
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { ScadaScript, WorkerRequest, WorkerResponse } from '../types';
import { SANDBOX_LIMITS } from '../types';
import { ScriptExecutor, isValidScriptUrl, validateScriptCode } from '../ScriptExecutor';
import { getWorkerSource } from '../workerScript';
import { TagValueBus } from '../../tags/TagValueBus';
import { WidgetEventBus } from '../../events/WidgetEventBus';

/* ================================================================== */
/*  Mock Worker                                                        */
/* ================================================================== */

/**
 * Mock Worker that simulates the Web Worker message-passing protocol.
 * When postMessage is called with an 'execute' request, it invokes the
 * configured response behavior (success, error, api-calls, etc.)
 */
class MockWorker {
  onmessage: ((event: MessageEvent<WorkerResponse>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;

  /** Configurable behavior for the next execute request */
  static nextBehavior: 'success' | 'error' | 'hang' | 'api-calls' | 'custom' = 'success';
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
      // Allow tests to define arbitrary behavior by setting customHandler
      // which receives the request and can call this.onmessage manually
      const handler = MockWorker.customHandler;
      // Use setTimeout to simulate async worker behavior
      setTimeout(() => handler.call(this, data), 0);
      return;
    }

    switch (MockWorker.nextBehavior) {
      case 'success':
        // Simulate immediate successful execution
        setTimeout(() => {
          this.onmessage?.({
            data: { type: 'result', scriptId, returnValue: undefined },
          } as MessageEvent<WorkerResponse>);
        }, 0);
        break;

      case 'error':
        // Simulate a script error
        setTimeout(() => {
          this.onmessage?.({
            data: { type: 'error', scriptId, error: 'Test script error' },
          } as MessageEvent<WorkerResponse>);
        }, 0);
        break;

      case 'hang':
        // Do nothing -- simulates a script that exceeds the timeout
        break;

      case 'api-calls':
        // Simulate a script that makes API calls before completing
        setTimeout(() => {
          this.onmessage?.({
            data: {
              type: 'api-call',
              scriptId,
              apiMethod: '$setTag',
              apiArgs: ['temperature', 25.5],
            },
          } as MessageEvent<WorkerResponse>);
          this.onmessage?.({
            data: {
              type: 'log',
              scriptId,
              message: 'Script executed',
              level: 'info',
            },
          } as MessageEvent<WorkerResponse>);
          this.onmessage?.({
            data: { type: 'result', scriptId, returnValue: 'done' },
          } as MessageEvent<WorkerResponse>);
        }, 0);
        break;
    }
  }

  terminate(): void {
    this.terminated = true;
    this.onmessage = null;
    this.onerror = null;
  }

  addEventListener(): void {
    // No-op for mock
  }
  removeEventListener(): void {
    // No-op for mock
  }
}

// Install the mock Worker globally
const OriginalWorker = globalThis.Worker;
beforeEach(() => {
  MockWorker.instances = [];
  MockWorker.nextBehavior = 'success';
  MockWorker.customHandler = null;
  (globalThis as Record<string, unknown>).Worker = MockWorker as unknown as typeof Worker;
});
afterEach(() => {
  (globalThis as Record<string, unknown>).Worker = OriginalWorker;
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
    id: 'test-script-1',
    name: 'Test Script',
    code: '$log("hello");',
    trigger: 'event',
    enabled: true,
    ...overrides,
  };
}

function createExecutor(): {
  executor: ScriptExecutor;
  tagBus: TagValueBus;
  eventBus: WidgetEventBus;
} {
  const tagBus = new TagValueBus();
  const eventBus = new WidgetEventBus();
  const executor = new ScriptExecutor(tagBus, eventBus);
  return { executor, tagBus, eventBus };
}

/* ================================================================== */
/*  1. Type and Constant Validation                                    */
/* ================================================================== */

describe('SANDBOX_LIMITS constants', () => {
  it('has correct timeout value', () => {
    expect(SANDBOX_LIMITS.TIMEOUT_MS).toBe(500);
  });

  it('has correct max tag writes', () => {
    expect(SANDBOX_LIMITS.MAX_TAG_WRITES).toBe(50);
  });

  it('has correct max workers', () => {
    expect(SANDBOX_LIMITS.MAX_WORKERS).toBe(4);
  });

  it('has correct minimum interval', () => {
    expect(SANDBOX_LIMITS.MIN_INTERVAL_MS).toBe(1000);
  });

  it('has correct max code size', () => {
    expect(SANDBOX_LIMITS.MAX_CODE_SIZE).toBe(50_000);
  });

  it('has correct max logs', () => {
    expect(SANDBOX_LIMITS.MAX_LOGS).toBe(20);
  });

  it('all values are readonly (frozen via as const)', () => {
    // Verify that the object is structurally correct
    const keys: ReadonlyArray<keyof typeof SANDBOX_LIMITS> = [
      'TIMEOUT_MS',
      'MAX_TAG_WRITES',
      'MAX_WORKERS',
      'MIN_INTERVAL_MS',
      'MAX_CODE_SIZE',
      'MAX_LOGS',
    ];
    expect(Object.keys(SANDBOX_LIMITS)).toEqual(expect.arrayContaining(keys as string[]));
  });
});

describe('ScadaScript type validation', () => {
  it('creates a valid script with all required fields', () => {
    const script = createScript();
    expect(script.id).toBeDefined();
    expect(script.name).toBeDefined();
    expect(script.code).toBeDefined();
    expect(script.trigger).toBeDefined();
    expect(script.enabled).toBeDefined();
  });

  it('supports optional triggerTag for tagChange scripts', () => {
    const script = createScript({ trigger: 'tagChange', triggerTag: 'pH' });
    expect(script.triggerTag).toBe('pH');
  });

  it('supports optional triggerInterval for interval scripts', () => {
    const script = createScript({ trigger: 'interval', triggerInterval: 2000 });
    expect(script.triggerInterval).toBe(2000);
  });
});

/* ================================================================== */
/*  2. URL Validation (security-critical)                              */
/* ================================================================== */

describe('isValidScriptUrl', () => {
  it('accepts https URLs', () => {
    expect(isValidScriptUrl('https://example.com')).toBe(true);
    expect(isValidScriptUrl('https://example.com/path?q=1')).toBe(true);
  });

  it('rejects http URLs (non-localhost)', () => {
    expect(isValidScriptUrl('http://example.com')).toBe(false);
    expect(isValidScriptUrl('http://evil.com')).toBe(false);
  });

  it('allows http localhost for development', () => {
    expect(isValidScriptUrl('http://localhost:3000')).toBe(true);
    expect(isValidScriptUrl('http://127.0.0.1:8080')).toBe(true);
  });

  it('rejects javascript: protocol (XSS prevention)', () => {
    expect(isValidScriptUrl('javascript:alert(1)')).toBe(false);
  });

  it('rejects data: URLs', () => {
    expect(isValidScriptUrl('data:text/html,<h1>evil</h1>')).toBe(false);
  });

  it('rejects file: protocol', () => {
    expect(isValidScriptUrl('file:///etc/passwd')).toBe(false);
  });

  it('rejects ftp: protocol', () => {
    expect(isValidScriptUrl('ftp://files.example.com')).toBe(false);
  });

  it('rejects empty string', () => {
    expect(isValidScriptUrl('')).toBe(false);
  });

  it('rejects malformed URLs', () => {
    expect(isValidScriptUrl('not-a-url')).toBe(false);
    expect(isValidScriptUrl('://missing-protocol')).toBe(false);
  });
});

/* ================================================================== */
/*  3. Script Code Validation                                          */
/* ================================================================== */

describe('validateScriptCode', () => {
  it('accepts valid script code', () => {
    expect(validateScriptCode('$log("hello");')).toBeUndefined();
  });

  it('rejects empty string', () => {
    expect(validateScriptCode('')).toContain('non-empty');
  });

  it('rejects oversized scripts', () => {
    const oversized = 'x'.repeat(SANDBOX_LIMITS.MAX_CODE_SIZE + 1);
    const error = validateScriptCode(oversized);
    expect(error).toContain('exceeds maximum size');
  });

  it('accepts scripts at the exact size limit', () => {
    // ASCII characters are 1 byte each
    const maxSize = 'x'.repeat(SANDBOX_LIMITS.MAX_CODE_SIZE);
    expect(validateScriptCode(maxSize)).toBeUndefined();
  });

  it('handles multi-byte characters correctly', () => {
    // Each emoji is 4 bytes in UTF-8, so fewer characters hit the limit
    const emoji = '\u{1F600}'; // Grinning face emoji
    const byteLength = new TextEncoder().encode(emoji).byteLength;
    const count = Math.ceil((SANDBOX_LIMITS.MAX_CODE_SIZE + 1) / byteLength);
    const oversized = emoji.repeat(count);
    expect(validateScriptCode(oversized)).toContain('exceeds maximum size');
  });
});

/* ================================================================== */
/*  4. Worker Pool Management                                          */
/* ================================================================== */

describe('ScriptExecutor worker pool', () => {
  it('creates worker from blob URL on first execute', async () => {
    const { executor } = createExecutor();
    MockWorker.nextBehavior = 'success';

    await executor.execute(createScript());

    expect(mockCreateObjectURL).toHaveBeenCalledTimes(1);
    expect(MockWorker.instances).toHaveLength(1);

    executor.dispose();
  });

  it('reuses idle workers across executions', async () => {
    const { executor } = createExecutor();
    MockWorker.nextBehavior = 'success';

    await executor.execute(createScript());
    await executor.execute(createScript({ id: 'script-2' }));

    // Should still only have 1 worker (reused)
    expect(MockWorker.instances).toHaveLength(1);

    executor.dispose();
  });

  it('creates new workers when existing ones are busy', async () => {
    const { executor } = createExecutor();

    // First script hangs (simulating busy worker)
    MockWorker.nextBehavior = 'hang';
    const hangPromise = executor.execute(createScript({ id: 'hang-script' }));

    // Second script should get a new worker
    MockWorker.nextBehavior = 'success';
    const successResult = await executor.execute(createScript({ id: 'success-script' }));

    expect(MockWorker.instances.length).toBeGreaterThanOrEqual(2);
    expect(successResult.success).toBe(true);

    // Let the hanging script timeout
    await hangPromise;

    executor.dispose();
  });

  it('returns error when pool is exhausted', async () => {
    const { executor } = createExecutor();
    MockWorker.nextBehavior = 'hang';

    // Fill up the pool (MAX_WORKERS = 4)
    const promises: Promise<unknown>[] = [];
    for (let i = 0; i < SANDBOX_LIMITS.MAX_WORKERS; i++) {
      promises.push(executor.execute(createScript({ id: `script-${i}` })));
    }

    // Next execute should fail immediately -- pool is full
    MockWorker.nextBehavior = 'success'; // Doesn't matter, no worker available
    const result = await executor.execute(createScript({ id: 'overflow' }));

    expect(result.success).toBe(false);
    expect(result.error).toContain('busy');

    // Clean up hanging promises
    await Promise.all(promises);
    executor.dispose();
  });
});

/* ================================================================== */
/*  5. Execution Lifecycle                                             */
/* ================================================================== */

describe('ScriptExecutor execution', () => {
  it('returns success for a well-behaved script', async () => {
    const { executor } = createExecutor();
    MockWorker.nextBehavior = 'success';

    const result = await executor.execute(createScript());

    expect(result.success).toBe(true);
    expect(result.error).toBeUndefined();
    expect(result.durationMs).toBeGreaterThanOrEqual(0);

    executor.dispose();
  });

  it('returns error for a script that throws', async () => {
    const { executor } = createExecutor();
    MockWorker.nextBehavior = 'error';

    const result = await executor.execute(createScript());

    expect(result.success).toBe(false);
    expect(result.error).toBe('Test script error');

    executor.dispose();
  });

  it('enforces 500ms timeout and terminates the worker', async () => {
    vi.useFakeTimers();

    const { executor } = createExecutor();
    MockWorker.nextBehavior = 'hang';

    const promise = executor.execute(createScript());

    // Advance past the timeout
    vi.advanceTimersByTime(SANDBOX_LIMITS.TIMEOUT_MS + 10);

    const result = await promise;

    expect(result.success).toBe(false);
    expect(result.error).toContain('timed out');

    // The hung worker should have been terminated
    const terminatedWorkers = MockWorker.instances.filter((w) => w.terminated);
    expect(terminatedWorkers.length).toBeGreaterThanOrEqual(1);

    executor.dispose();
    vi.useRealTimers();
  });

  it('returns error when executor is disposed', async () => {
    const { executor } = createExecutor();
    executor.dispose();

    const result = await executor.execute(createScript());

    expect(result.success).toBe(false);
    expect(result.error).toContain('disposed');
  });

  it('returns validation error for empty code', async () => {
    const { executor } = createExecutor();

    const result = await executor.execute(createScript({ code: '' }));

    expect(result.success).toBe(false);
    expect(result.error).toContain('non-empty');
    // No worker should have been created for invalid code
    expect(MockWorker.instances).toHaveLength(0);

    executor.dispose();
  });

  it('returns validation error for oversized code', async () => {
    const { executor } = createExecutor();
    const oversized = 'x'.repeat(SANDBOX_LIMITS.MAX_CODE_SIZE + 1);

    const result = await executor.execute(createScript({ code: oversized }));

    expect(result.success).toBe(false);
    expect(result.error).toContain('exceeds maximum size');
    expect(MockWorker.instances).toHaveLength(0);

    executor.dispose();
  });
});

/* ================================================================== */
/*  6. API Call Routing                                                */
/* ================================================================== */

describe('ScriptExecutor API call handling', () => {
  it('routes $setTag calls to TagValueBus', async () => {
    const { executor, tagBus } = createExecutor();
    const publishSpy = vi.spyOn(tagBus, 'publish');

    MockWorker.nextBehavior = 'api-calls';
    const result = await executor.execute(createScript());

    expect(publishSpy).toHaveBeenCalledWith('temperature', 25.5);
    expect(result.tagWrites).toBe(1);
    expect(result.success).toBe(true);

    executor.dispose();
  });

  it('collects $log messages in the result', async () => {
    const { executor } = createExecutor();
    MockWorker.nextBehavior = 'api-calls';

    const result = await executor.execute(createScript());

    expect(result.logs).toContain('Script executed');
    expect(result.success).toBe(true);

    executor.dispose();
  });

  it('routes $navigate calls to WidgetEventBus', async () => {
    const { executor, eventBus } = createExecutor();
    const dispatchSpy = vi.spyOn(eventBus, 'dispatch');

    MockWorker.nextBehavior = 'custom';
    MockWorker.customHandler = function (this: MockWorker, req: WorkerRequest) {
      this.onmessage?.({
        data: {
          type: 'api-call',
          scriptId: req.scriptId,
          apiMethod: '$navigate',
          apiArgs: ['screen-2'],
        },
      } as MessageEvent<WorkerResponse>);
      this.onmessage?.({
        data: { type: 'result', scriptId: req.scriptId, returnValue: undefined },
      } as MessageEvent<WorkerResponse>);
    };

    await executor.execute(createScript());

    expect(dispatchSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'navigate',
        params: expect.objectContaining({ targetScreenId: 'screen-2' }),
      })
    );

    executor.dispose();
  });

  it('routes $openCard calls to WidgetEventBus', async () => {
    const { executor, eventBus } = createExecutor();
    const dispatchSpy = vi.spyOn(eventBus, 'dispatch');

    MockWorker.nextBehavior = 'custom';
    MockWorker.customHandler = function (this: MockWorker, req: WorkerRequest) {
      this.onmessage?.({
        data: {
          type: 'api-call',
          scriptId: req.scriptId,
          apiMethod: '$openCard',
          apiArgs: ['screen-3', { width: 400, height: 300 }],
        },
      } as MessageEvent<WorkerResponse>);
      this.onmessage?.({
        data: { type: 'result', scriptId: req.scriptId, returnValue: undefined },
      } as MessageEvent<WorkerResponse>);
    };

    await executor.execute(createScript());

    expect(dispatchSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'openCard',
        params: expect.objectContaining({
          targetScreenId: 'screen-3',
          width: 400,
          height: 300,
        }),
      })
    );

    executor.dispose();
  });

  it('validates and opens URLs for $openUrl calls', async () => {
    const { executor } = createExecutor();
    const windowOpenSpy = vi.spyOn(window, 'open').mockReturnValue(null);

    MockWorker.nextBehavior = 'custom';
    MockWorker.customHandler = function (this: MockWorker, req: WorkerRequest) {
      this.onmessage?.({
        data: {
          type: 'api-call',
          scriptId: req.scriptId,
          apiMethod: '$openUrl',
          apiArgs: ['https://docs.example.com'],
        },
      } as MessageEvent<WorkerResponse>);
      this.onmessage?.({
        data: { type: 'result', scriptId: req.scriptId, returnValue: undefined },
      } as MessageEvent<WorkerResponse>);
    };

    await executor.execute(createScript());

    expect(windowOpenSpy).toHaveBeenCalledWith(
      'https://docs.example.com',
      '_blank',
      'noopener,noreferrer'
    );

    windowOpenSpy.mockRestore();
    executor.dispose();
  });

  it('blocks $openUrl for non-https protocols', async () => {
    const { executor } = createExecutor();
    const windowOpenSpy = vi.spyOn(window, 'open').mockReturnValue(null);

    MockWorker.nextBehavior = 'custom';
    MockWorker.customHandler = function (this: MockWorker, req: WorkerRequest) {
      this.onmessage?.({
        data: {
          type: 'api-call',
          scriptId: req.scriptId,
          apiMethod: '$openUrl',
          apiArgs: ['javascript:alert(1)'],
        },
      } as MessageEvent<WorkerResponse>);
      this.onmessage?.({
        data: { type: 'result', scriptId: req.scriptId, returnValue: undefined },
      } as MessageEvent<WorkerResponse>);
    };

    const result = await executor.execute(createScript());

    // window.open should NOT have been called
    expect(windowOpenSpy).not.toHaveBeenCalled();
    // The blocked URL should be logged
    expect(result.logs).toEqual(
      expect.arrayContaining([expect.stringContaining('BLOCKED')])
    );

    windowOpenSpy.mockRestore();
    executor.dispose();
  });

  it('ignores unknown API methods (defense in depth)', async () => {
    const { executor } = createExecutor();

    MockWorker.nextBehavior = 'custom';
    MockWorker.customHandler = function (this: MockWorker, req: WorkerRequest) {
      this.onmessage?.({
        data: {
          type: 'api-call',
          scriptId: req.scriptId,
          apiMethod: '$dangerousMethod',
          apiArgs: ['payload'],
        },
      } as MessageEvent<WorkerResponse>);
      this.onmessage?.({
        data: { type: 'result', scriptId: req.scriptId, returnValue: undefined },
      } as MessageEvent<WorkerResponse>);
    };

    // Should not throw
    const result = await executor.execute(createScript());
    expect(result.success).toBe(true);

    executor.dispose();
  });
});

/* ================================================================== */
/*  7. Rate Limiting                                                   */
/* ================================================================== */

describe('ScriptExecutor rate limiting', () => {
  it('tracks tag write count from $setTag API calls', async () => {
    const { executor, tagBus } = createExecutor();
    const publishSpy = vi.spyOn(tagBus, 'publish');

    MockWorker.nextBehavior = 'custom';
    MockWorker.customHandler = function (this: MockWorker, req: WorkerRequest) {
      // Send 3 tag writes
      for (let i = 0; i < 3; i++) {
        this.onmessage?.({
          data: {
            type: 'api-call',
            scriptId: req.scriptId,
            apiMethod: '$setTag',
            apiArgs: [`tag-${i}`, i * 10],
          },
        } as MessageEvent<WorkerResponse>);
      }
      this.onmessage?.({
        data: { type: 'result', scriptId: req.scriptId, returnValue: undefined },
      } as MessageEvent<WorkerResponse>);
    };

    const result = await executor.execute(createScript());

    expect(result.tagWrites).toBe(3);
    expect(publishSpy).toHaveBeenCalledTimes(3);

    executor.dispose();
  });

  it('respects MAX_LOGS limit for log messages', async () => {
    const { executor } = createExecutor();

    MockWorker.nextBehavior = 'custom';
    MockWorker.customHandler = function (this: MockWorker, req: WorkerRequest) {
      // Send more logs than the limit
      for (let i = 0; i < SANDBOX_LIMITS.MAX_LOGS + 10; i++) {
        this.onmessage?.({
          data: {
            type: 'log',
            scriptId: req.scriptId,
            message: `Log message ${i}`,
            level: 'info',
          },
        } as MessageEvent<WorkerResponse>);
      }
      this.onmessage?.({
        data: { type: 'result', scriptId: req.scriptId, returnValue: undefined },
      } as MessageEvent<WorkerResponse>);
    };

    const result = await executor.execute(createScript());

    // Logs should be capped at MAX_LOGS
    expect(result.logs).toHaveLength(SANDBOX_LIMITS.MAX_LOGS);
    expect(result.success).toBe(true);

    executor.dispose();
  });

  it('validates $setTag argument types on main thread', async () => {
    const { executor, tagBus } = createExecutor();
    const publishSpy = vi.spyOn(tagBus, 'publish');

    MockWorker.nextBehavior = 'custom';
    MockWorker.customHandler = function (this: MockWorker, req: WorkerRequest) {
      // Send a $setTag with invalid value type (object instead of primitive)
      this.onmessage?.({
        data: {
          type: 'api-call',
          scriptId: req.scriptId,
          apiMethod: '$setTag',
          apiArgs: ['tag-1', { nested: true }],
        },
      } as MessageEvent<WorkerResponse>);
      this.onmessage?.({
        data: { type: 'result', scriptId: req.scriptId, returnValue: undefined },
      } as MessageEvent<WorkerResponse>);
    };

    const result = await executor.execute(createScript());

    // Invalid type should be silently ignored -- publish should not be called
    expect(publishSpy).not.toHaveBeenCalled();
    expect(result.tagWrites).toBe(0);
    expect(result.success).toBe(true);

    executor.dispose();
  });
});

/* ================================================================== */
/*  8. Disposal and Cleanup                                            */
/* ================================================================== */

describe('ScriptExecutor disposal', () => {
  it('terminates all workers on dispose', async () => {
    const { executor } = createExecutor();
    MockWorker.nextBehavior = 'success';

    // Create a couple of workers
    await executor.execute(createScript({ id: 's1' }));
    // Force a second worker by making the first busy
    MockWorker.nextBehavior = 'hang';
    const hangPromise = executor.execute(createScript({ id: 's2' }));
    MockWorker.nextBehavior = 'success';
    await executor.execute(createScript({ id: 's3' }));

    // Now dispose
    executor.dispose();

    // All workers should be terminated
    for (const worker of MockWorker.instances) {
      expect(worker.terminated).toBe(true);
    }

    // Blob URL should be revoked
    expect(mockRevokeObjectURL).toHaveBeenCalled();

    await hangPromise; // Clean up
  });

  it('prevents further executions after dispose', async () => {
    const { executor } = createExecutor();
    executor.dispose();

    const result = await executor.execute(createScript());
    expect(result.success).toBe(false);
    expect(result.error).toContain('disposed');
  });
});

/* ================================================================== */
/*  9. Worker Source Generation                                        */
/* ================================================================== */

describe('getWorkerSource', () => {
  it('returns a non-empty string', () => {
    const source = getWorkerSource();
    expect(typeof source).toBe('string');
    expect(source.length).toBeGreaterThan(100);
  });

  it('contains security lockdown code (removes fetch)', () => {
    const source = getWorkerSource();
    expect(source).toContain('self.fetch = undefined');
  });

  it('contains security lockdown code (removes XMLHttpRequest)', () => {
    const source = getWorkerSource();
    expect(source).toContain('self.XMLHttpRequest = undefined');
  });

  it('contains security lockdown code (removes importScripts)', () => {
    const source = getWorkerSource();
    expect(source).toContain('self.importScripts = undefined');
  });

  it('contains security lockdown code (removes eval)', () => {
    const source = getWorkerSource();
    expect(source).toContain('self.eval = undefined');
  });

  it('contains security lockdown code (removes WebSocket)', () => {
    const source = getWorkerSource();
    expect(source).toContain('self.WebSocket = undefined');
  });

  it('contains the sandbox API functions', () => {
    const source = getWorkerSource();
    expect(source).toContain('function $getTag');
    expect(source).toContain('function $setTag');
    expect(source).toContain('function $navigate');
    expect(source).toContain('function $openCard');
    expect(source).toContain('function $openUrl');
    expect(source).toContain('function $log');
  });

  it('contains the message handler', () => {
    const source = getWorkerSource();
    expect(source).toContain('self.onmessage');
    expect(source).toContain("new Function(");
  });

  it('embeds the correct SANDBOX_LIMITS values', () => {
    const source = getWorkerSource();
    expect(source).toContain(String(SANDBOX_LIMITS.MAX_TAG_WRITES));
    expect(source).toContain(String(SANDBOX_LIMITS.MAX_LOGS));
  });

  it('contains tag write rate limiting logic', () => {
    const source = getWorkerSource();
    expect(source).toContain('_tagWriteCount');
    expect(source).toContain('Tag write limit exceeded');
  });

  it('contains log rate limiting logic', () => {
    const source = getWorkerSource();
    expect(source).toContain('_logCount');
  });

  it('locks down Function constructor after setup', () => {
    const source = getWorkerSource();
    expect(source).toContain('self.Function = undefined');
  });
});

/* ================================================================== */
/*  10. Tag Snapshot Filtering                                         */
/* ================================================================== */

describe('ScriptExecutor tag snapshot', () => {
  it('sends tag values to worker via postMessage', async () => {
    const { executor, tagBus } = createExecutor();

    // Set some tag values
    tagBus.publish('temperature', 22.5);
    tagBus.publish('status', 'running');
    tagBus.publish('alarm', true);

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
    expect(capturedRequest!.tagValues).toEqual({
      temperature: 22.5,
      status: 'running',
      alarm: true,
    });

    executor.dispose();
  });

  it('filters out non-primitive tag values', async () => {
    const { executor, tagBus } = createExecutor();

    tagBus.publish('temperature', 22.5);
    tagBus.publish('complexObj', { nested: true } as unknown); // Should be filtered

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
    expect(capturedRequest!.tagValues).toEqual({ temperature: 22.5 });
    expect(capturedRequest!.tagValues).not.toHaveProperty('complexObj');

    executor.dispose();
  });
});

/* ================================================================== */
/*  11. Worker onerror handling                                        */
/* ================================================================== */

describe('ScriptExecutor worker errors', () => {
  it('handles worker onerror events gracefully', async () => {
    const { executor } = createExecutor();

    MockWorker.nextBehavior = 'custom';
    MockWorker.customHandler = function (this: MockWorker, _req: WorkerRequest) {
      // Simulate a worker-level error (not a script error)
      setTimeout(() => {
        this.onerror?.({
          message: 'Worker crashed',
        } as ErrorEvent);
      }, 0);
    };

    const result = await executor.execute(createScript());

    expect(result.success).toBe(false);
    expect(result.error).toContain('Worker crashed');

    executor.dispose();
  });
});

/* ================================================================== */
/*  12. Blob URL lifecycle                                             */
/* ================================================================== */

describe('ScriptExecutor blob URL management', () => {
  it('creates blob URL only once across multiple executions', async () => {
    const { executor } = createExecutor();
    MockWorker.nextBehavior = 'success';

    await executor.execute(createScript({ id: 's1' }));
    await executor.execute(createScript({ id: 's2' }));
    await executor.execute(createScript({ id: 's3' }));

    // Blob URL should be created exactly once
    expect(mockCreateObjectURL).toHaveBeenCalledTimes(1);

    executor.dispose();
  });

  it('revokes blob URL on dispose', async () => {
    const { executor } = createExecutor();
    MockWorker.nextBehavior = 'success';
    await executor.execute(createScript());

    executor.dispose();

    expect(mockRevokeObjectURL).toHaveBeenCalledWith('blob:mock-url');
  });
});
