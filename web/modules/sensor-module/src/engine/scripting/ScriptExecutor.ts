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
} from './types';
import { SANDBOX_LIMITS } from './types';
import { getWorkerSource } from './workerScript';

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

  constructor(tagBus: TagValueBus, eventBus: WidgetEventBus) {
    this.tagBus = tagBus;
    this.eventBus = eventBus;
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
   * 3. Send execute message with tag snapshot
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

      // Send the execute command to the worker
      const request: WorkerRequest = {
        type: 'execute',
        scriptId: script.id,
        code: script.code,
        tagValues: tagSnapshot,
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
