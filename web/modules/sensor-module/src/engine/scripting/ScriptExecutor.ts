/**
 * Manages a pool of Web Workers for executing SCADA scripts.
 * Each worker is created from an inline Blob URL (no external file needed).
 *
 * Architecture:
 * - Pool size: 1-4 workers (created lazily, reused across invocations)
 * - Timeout: 500ms per execution (worker terminated and replaced if exceeded)
 * - API calls: Worker sends postMessage, executor validates and routes them
 * - Tag writes: Validated then routed to TagValueBus
 * - Navigation: Routed to WidgetEventBus as 'navigate' action
 * - URL opens: Validated (https only in production) then window.open
 * - Property writes: Validated then routed via onSetProperty callback (Phase 9D)
 * - Dialog close: Routed to WidgetEventBus as 'closeDialog' action (Phase 9D)
 * - Alarms: Validated then routed via onAlarm callback (Phase 9D)
 *
 * Tenant isolation: Scripts only access tags visible to the current
 * SCADA package's target device. No cross-tenant tag access is possible
 * because the tag snapshot is filtered before being sent to the worker.
 *
 * The executor never executes user code on the main thread -- all user
 * code runs exclusively inside Web Worker sandboxes.
 */

import type { TagValueBus } from '../tags/TagValueBus';
import type { WidgetEventBus } from '../events/WidgetEventBus';
import type {
  ScadaScript,
  WorkerRequest,
  WorkerResponse,
  ScriptExecutionResult,
  TagPrimitive,
  AlarmLevel,
} from './types';
import { SANDBOX_LIMITS } from './types';
import { getWorkerSource } from './workerScript';

/**
 * Callback interface for Phase 9D scripting extensions.
 * These callbacks decouple the ScriptExecutor from store-specific
 * implementations -- the executor validates inputs and delegates
 * side effects to the calling code (typically useScriptEngine).
 */
export interface ScriptExecutorCallbacks {
  /**
   * Called when a script invokes $setProperty to change a widget's config.
   * The property path has already been validated for safety by the executor.
   */
  onSetProperty?: (widgetId: string, propertyPath: string, value: TagPrimitive) => void;
  /**
   * Called when a script invokes $setAlarm to raise a runtime alarm.
   * The alarm level and message length have already been validated.
   */
  onAlarm?: (tagName: string, level: AlarmLevel, message: string) => void;
  /**
   * Called once at execution start to build a snapshot of widget properties
   * for $getProperty access. Returns a map of widgetId -> { prop: value }.
   * Only primitive-valued config fields should be included.
   */
  getWidgetPropertySnapshot?: () => Record<string, Record<string, TagPrimitive>>;
}

/** Dangerous property path segments that could enable prototype pollution */
const FORBIDDEN_SEGMENTS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Validates a property path is safe to use for object traversal.
 * Reuses the same security pattern as SetPropertyHandler to maintain
 * consistent validation across the event-driven and scripting APIs.
 */
export function isPropertyPathSafe(path: string): boolean {
  if (!path || path.length === 0 || path.length > 200) return false;

  // Only allow alphanumeric characters, dots, underscores, and hyphens
  if (!/^[a-zA-Z0-9_.-]+$/.test(path)) return false;

  // Reject paths containing forbidden segments
  const segments = path.split('.');
  for (const segment of segments) {
    if (FORBIDDEN_SEGMENTS.has(segment)) return false;
    if (segment.length === 0) return false; // reject consecutive dots
  }

  return true;
}

/**
 * Validates that a URL is safe to open from a script.
 * Only HTTPS URLs are allowed to prevent:
 * - javascript: protocol XSS attacks
 * - data: URL abuse
 * - file: protocol local file access
 * - http: downgrade attacks in production
 *
 * In development (localhost), http is also permitted for convenience.
 */
export function isValidScriptUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'https:') return true;
    // Allow http in development environments (localhost)
    if (
      parsed.protocol === 'http:' &&
      (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1')
    ) {
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Validates script code before sending it to a worker.
 * Returns an error message if validation fails, undefined if valid.
 */
export function validateScriptCode(code: string): string | undefined {
  if (!code || typeof code !== 'string') {
    return 'Script code must be a non-empty string';
  }
  const byteLength = new TextEncoder().encode(code).byteLength;
  if (byteLength > SANDBOX_LIMITS.MAX_CODE_SIZE) {
    return `Script code exceeds maximum size (${byteLength} bytes > ${SANDBOX_LIMITS.MAX_CODE_SIZE} bytes)`;
  }
  return undefined;
}

export class ScriptExecutor {
  private workers: Worker[] = [];
  private busy = new Set<Worker>();
  private blobUrl: string | null = null;
  private disposed = false;

  private readonly tagBus: TagValueBus;
  private readonly eventBus: WidgetEventBus;
  private readonly callbacks: ScriptExecutorCallbacks;

  /**
   * @param tagBus    - Tag value bus for $getTag/$setTag operations
   * @param eventBus  - Widget event bus for navigation/overlay operations
   * @param callbacks - Optional Phase 9D extension callbacks for $setProperty,
   *                    $setAlarm, and widget property snapshot access.
   *                    Omitting callbacks makes the new API methods no-ops,
   *                    preserving backward compatibility with existing callers.
   */
  constructor(
    tagBus: TagValueBus,
    eventBus: WidgetEventBus,
    callbacks?: ScriptExecutorCallbacks,
  ) {
    this.tagBus = tagBus;
    this.eventBus = eventBus;
    this.callbacks = callbacks ?? {};
  }

  /**
   * Creates the Blob URL for worker instantiation.
   * Lazily initialized on first execute() call so that the Blob is only
   * created if scripting is actually used.
   */
  private getBlobUrl(): string {
    if (!this.blobUrl) {
      const source = getWorkerSource();
      const blob = new Blob([source], { type: 'application/javascript' });
      this.blobUrl = URL.createObjectURL(blob);
    }
    return this.blobUrl;
  }

  /**
   * Acquires an idle worker from the pool, or creates a new one if the pool
   * hasn't reached its maximum size. Returns null if all workers are busy
   * and the pool is full.
   */
  private acquireWorker(): Worker | null {
    // First, try to find an idle worker
    for (const worker of this.workers) {
      if (!this.busy.has(worker)) {
        this.busy.add(worker);
        return worker;
      }
    }

    // Create a new worker if under the limit
    if (this.workers.length < SANDBOX_LIMITS.MAX_WORKERS) {
      const worker = new Worker(this.getBlobUrl(), { type: 'classic' });
      this.workers.push(worker);
      this.busy.add(worker);
      return worker;
    }

    return null;
  }

  /**
   * Releases a worker back to the pool for reuse.
   */
  private releaseWorker(worker: Worker): void {
    this.busy.delete(worker);
  }

  /**
   * Terminates a worker and removes it from the pool.
   * Used when a script exceeds its timeout -- the worker is unrecoverable
   * after terminate() and must be replaced.
   */
  private terminateWorker(worker: Worker): void {
    this.busy.delete(worker);
    const idx = this.workers.indexOf(worker);
    if (idx !== -1) this.workers.splice(idx, 1);
    worker.terminate();
  }

  /**
   * Builds a tag value snapshot suitable for the worker.
   * Filters to only TagPrimitive values (number, string, boolean)
   * since the worker sandbox API only supports these types.
   */
  private getTagSnapshot(): Record<string, TagPrimitive> {
    const raw = this.tagBus.getSnapshot();
    const snapshot: Record<string, TagPrimitive> = {};
    for (const [key, value] of Object.entries(raw)) {
      if (
        typeof value === 'number' ||
        typeof value === 'string' ||
        typeof value === 'boolean'
      ) {
        snapshot[key] = value;
      }
    }
    return snapshot;
  }

  /**
   * Handles an API call message from the worker.
   * Validates the call and routes it to the appropriate bus or browser API.
   */
  private handleApiCall(
    response: WorkerResponse,
    logs: string[],
    tagWriteCounter: { count: number }
  ): void {
    const { apiMethod, apiArgs } = response;
    if (!apiMethod || !Array.isArray(apiArgs)) return;

    switch (apiMethod) {
      case '$setTag': {
        const [tagName, value] = apiArgs as [string, TagPrimitive];
        if (typeof tagName !== 'string') break;
        if (
          typeof value !== 'number' &&
          typeof value !== 'string' &&
          typeof value !== 'boolean'
        ) {
          break;
        }
        tagWriteCounter.count++;
        this.tagBus.publish(tagName, value);
        break;
      }

      case '$navigate': {
        const [screenId] = apiArgs as [string];
        if (typeof screenId !== 'string') break;
        this.eventBus.dispatch({
          widgetId: '__script__',
          screenId: '',
          action: 'navigate',
          params: { targetScreenId: screenId },
        });
        break;
      }

      case '$openCard': {
        const [screenId, options] = apiArgs as [
          string,
          { width?: number; height?: number } | undefined,
        ];
        if (typeof screenId !== 'string') break;
        this.eventBus.dispatch({
          widgetId: '__script__',
          screenId: '',
          action: 'openCard',
          params: {
            targetScreenId: screenId,
            width: options?.width,
            height: options?.height,
          },
        });
        break;
      }

      case '$openUrl': {
        const [url] = apiArgs as [string];
        if (typeof url !== 'string') break;
        if (!isValidScriptUrl(url)) {
          logs.push(`[BLOCKED] $openUrl rejected: "${url}" (only https allowed)`);
          break;
        }
        // Open in a new tab with noopener/noreferrer for security
        window.open(url, '_blank', 'noopener,noreferrer');
        break;
      }

      // ----------------------------------------------------------------
      // Phase 9D: Extended scripting API methods
      // ----------------------------------------------------------------

      case '$setProperty': {
        const [widgetId, propertyPath, propValue] = apiArgs as [string, string, TagPrimitive];
        if (typeof widgetId !== 'string' || typeof propertyPath !== 'string') break;

        // Only primitive values are allowed -- no objects, arrays, or functions
        if (
          typeof propValue !== 'number' &&
          typeof propValue !== 'string' &&
          typeof propValue !== 'boolean'
        ) {
          logs.push('[BLOCKED] $setProperty rejected: value must be a primitive');
          break;
        }

        // Security: validate property path against prototype pollution
        if (!isPropertyPathSafe(propertyPath)) {
          logs.push(`[BLOCKED] $setProperty rejected: unsafe property path "${propertyPath}"`);
          break;
        }

        // Rate-limited: shares the write budget with $setTag.
        // This prevents a script from bypassing tag write limits by
        // using $setProperty instead.
        tagWriteCounter.count++;

        if (this.callbacks.onSetProperty) {
          this.callbacks.onSetProperty(widgetId, propertyPath, propValue);
        }
        break;
      }

      case '$closeDialog': {
        // Delegate to WidgetEventBus which routes to CloseDialogHandler.
        // The handler is a no-op when no overlay is open.
        this.eventBus.dispatch({
          widgetId: '__script__',
          screenId: '',
          action: 'closeDialog',
          params: {},
        });
        break;
      }

      case '$setAlarm': {
        const [alarmTagName, level, alarmMessage] = apiArgs as [string, string, string];
        if (typeof alarmTagName !== 'string' || typeof alarmMessage !== 'string') break;

        // Validate alarm level against the allowed set
        const validLevels = new Set<string>(['info', 'warning', 'critical', 'emergency']);
        if (typeof level !== 'string' || !validLevels.has(level)) {
          logs.push(`[BLOCKED] $setAlarm rejected: invalid level "${String(level)}"`);
          break;
        }

        // Cap message length to prevent abuse
        if (alarmMessage.length > 500) {
          logs.push('[BLOCKED] $setAlarm rejected: message exceeds 500 character limit');
          break;
        }

        if (this.callbacks.onAlarm) {
          this.callbacks.onAlarm(alarmTagName, level as AlarmLevel, alarmMessage);
        }
        break;
      }

      default:
        // Unknown API method -- silently ignore (defense in depth)
        break;
    }
  }

  /**
   * Execute a script with the current tag snapshot.
   *
   * Flow:
   * 1. Validate script code (size, non-empty)
   * 2. Acquire a worker from the pool
   * 3. Send execute message with tag snapshot + widget property snapshot
   * 4. Wait for result/error with timeout
   * 5. Process any API calls that arrive during execution
   * 6. Release or terminate worker
   *
   * Returns a structured result with success/failure info, logs,
   * tag write count, and execution duration.
   */
  async execute(
    script: ScadaScript,
    params?: Record<string, unknown>
  ): Promise<ScriptExecutionResult> {
    const startTime = performance.now();

    // Validate code before sending to worker
    const validationError = validateScriptCode(script.code);
    if (validationError) {
      return {
        success: false,
        error: validationError,
        logs: [],
        tagWrites: 0,
        durationMs: performance.now() - startTime,
      };
    }

    if (this.disposed) {
      return {
        success: false,
        error: 'ScriptExecutor has been disposed',
        logs: [],
        tagWrites: 0,
        durationMs: performance.now() - startTime,
      };
    }

    const worker = this.acquireWorker();
    if (!worker) {
      return {
        success: false,
        error: 'All script workers are busy',
        logs: [],
        tagWrites: 0,
        durationMs: performance.now() - startTime,
      };
    }

    const tagSnapshot = this.getTagSnapshot();
    const logs: string[] = [];
    const tagWriteCounter = { count: 0 };

    return new Promise<ScriptExecutionResult>((resolve) => {
      let settled = false;

      const settle = (result: ScriptExecutionResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutHandle);
        worker.onmessage = null;
        worker.onerror = null;
        this.releaseWorker(worker);
        resolve(result);
      };

      const settleTimeout = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutHandle);
        worker.onmessage = null;
        worker.onerror = null;
        // Worker is unrecoverable after timeout -- terminate and remove from pool
        this.terminateWorker(worker);
        resolve({
          success: false,
          error: `Script execution timed out (>${SANDBOX_LIMITS.TIMEOUT_MS}ms)`,
          logs,
          tagWrites: tagWriteCounter.count,
          durationMs: performance.now() - startTime,
        });
      };

      // Timeout: terminate worker if script takes too long
      const timeoutHandle = setTimeout(settleTimeout, SANDBOX_LIMITS.TIMEOUT_MS);

      // Handle messages from the worker
      worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
        const response = event.data;
        if (!response || !response.scriptId) return;

        switch (response.type) {
          case 'result':
            settle({
              success: true,
              logs,
              tagWrites: tagWriteCounter.count,
              durationMs: performance.now() - startTime,
            });
            break;

          case 'error':
            settle({
              success: false,
              error: response.error || 'Unknown script error',
              logs,
              tagWrites: tagWriteCounter.count,
              durationMs: performance.now() - startTime,
            });
            break;

          case 'api-call':
            this.handleApiCall(response, logs, tagWriteCounter);
            break;

          case 'log':
            if (response.message && logs.length < SANDBOX_LIMITS.MAX_LOGS) {
              logs.push(response.message);
            }
            break;
        }
      };

      // Handle unexpected worker errors (syntax errors in worker code, etc.)
      worker.onerror = (event: ErrorEvent) => {
        settle({
          success: false,
          error: event.message || 'Worker error',
          logs,
          tagWrites: tagWriteCounter.count,
          durationMs: performance.now() - startTime,
        });
      };

      // Build widget property snapshot for $getProperty access (Phase 9D).
      // The snapshot is taken once at execution start so $getProperty reads
      // are consistent within a single script invocation.
      const widgetProperties = this.callbacks.getWidgetPropertySnapshot
        ? this.callbacks.getWidgetPropertySnapshot()
        : undefined;

      // Send the execute command to the worker
      const request: WorkerRequest = {
        type: 'execute',
        scriptId: script.id,
        code: script.code,
        tagValues: tagSnapshot,
        widgetProperties,
        params,
      };
      worker.postMessage(request);
    });
  }

  /**
   * Dispose all workers and release the Blob URL.
   * Must be called when the SCADA runtime unmounts to prevent memory leaks.
   * After dispose(), no further execute() calls will succeed.
   */
  dispose(): void {
    this.disposed = true;
    for (const worker of this.workers) {
      worker.terminate();
    }
    this.workers = [];
    this.busy.clear();
    if (this.blobUrl) {
      URL.revokeObjectURL(this.blobUrl);
      this.blobUrl = null;
    }
  }
}
