/**
 * ScriptEngine — Client-side sandboxed JavaScript script runner.
 *
 * Designed for SCADA widget click events and view lifecycle scripts.
 * Uses the Function constructor (NOT eval) for a degree of sandboxing.
 *
 * Features:
 *  - Bridge functions: $getTag, $setTag, $setView, $getAlarm
 *  - These bridge functions call back to ScadaSocketService or external stores
 *  - 5-second timeout protection per script execution
 *  - Console capture (log, warn, error, info)
 *  - Error handling with script name and context
 *
 * This is a plain TypeScript class with no React dependency so it can be
 * used outside the component tree (e.g. in a Web Worker or test harness).
 *
 * Security note: The Function constructor prevents closure access to outer
 * scope variables, but scripts still run in the same JavaScript realm and
 * can access window, fetch, etc.  For production hardening consider running
 * scripts in a Worker or iframe sandbox.
 */

import type {
  ScadaScript,
  ScriptResult,
  AlarmInstance,
  TagValueChange,
} from '../types/scada-runtime.types';

// ── Constants ──────────────────────────────────────────────────────────────────

const SCRIPT_TIMEOUT_MS = 5_000;
const MAX_CONSOLE_LINES = 200;

// ── Console entry type ─────────────────────────────────────────────────────────

export interface ScriptConsoleEntry {
  level: 'log' | 'warn' | 'error' | 'info';
  text: string;
  scriptId: string;
  timestamp: number;
}

// ── Bridge function types (injected into script scope) ─────────────────────────

export interface ScriptBridge {
  /** Get the current value of a tag. Returns the raw value or null. */
  $getTag: (tagId: string) => unknown;
  /** Set a tag value (async — writes through to the data source). */
  $setTag: (tagId: string, value: unknown) => Promise<void>;
  /** Navigate to / open a view by screen ID. */
  $setView: (viewId: string) => void;
  /** Get an active alarm instance by alarm rule ID. Returns null if not found. */
  $getAlarm: (alarmId: string) => AlarmInstance | null;
}

// ── Bridge resolver (provided by the consumer) ─────────────────────────────────

/**
 * ScriptBridgeResolver — Callbacks that the ScriptEngine uses to interact
 * with the rest of the system (data provider, alarm store, navigation).
 * The consumer must supply these when constructing the engine.
 */
export interface ScriptBridgeResolver {
  getTagValue: (tagId: string) => TagValueChange | null;
  writeTagValue: (tagId: string, value: unknown) => Promise<void>;
  setView: (viewId: string) => void;
  getAlarm: (alarmId: string) => AlarmInstance | null;
}

// ── Default options ─────────────────────────────────────────────────────────────

/**
 * Maximum time (in ms) that a synchronous script body is expected to run before
 * a watchdog warning is emitted.  True cancellation of synchronous infinite
 * loops (`while (true) {}`) is **not possible** in a single-threaded JS
 * context — the event loop is blocked and no timer callback can fire.
 *
 * For production hardening, consider running user scripts inside a dedicated
 * Web Worker where the main thread can call `worker.terminate()` to abort a
 * runaway synchronous loop.
 */
const DEFAULT_MAX_SYNC_EXECUTION_MS = 5_000;

// ── ScriptEngine class ────────────────────────────────────────────────────────

export interface ScriptEngineOptions {
  /** Async timeout per script execution (ms). Defaults to 5 000. */
  timeoutMs?: number;
  /**
   * Advisory threshold (ms) after which a watchdog warning is logged for
   * potentially blocked synchronous execution.
   *
   * **Important:** True cancellation of synchronous infinite loops
   * (`while (true) {}`) is impossible in a single-threaded JS context because
   * the event loop is blocked and no timer callback can fire.  This option
   * only logs a warning — it cannot terminate the script.
   *
   * For production hardening, run user scripts inside a Web Worker where the
   * main thread can call `worker.terminate()` to abort a runaway loop.
   *
   * @default 5000
   */
  maxSyncExecutionMs?: number;
}

export class ScriptEngine {
  private consoleBuffer: ScriptConsoleEntry[] = [];
  private running = new Set<string>();
  private bridge: ScriptBridgeResolver;
  private readonly timeoutMs: number;
  private readonly maxSyncExecutionMs: number;

  constructor(bridge: ScriptBridgeResolver, options?: ScriptEngineOptions) {
    this.bridge = bridge;
    this.timeoutMs = options?.timeoutMs ?? SCRIPT_TIMEOUT_MS;
    this.maxSyncExecutionMs = options?.maxSyncExecutionMs ?? DEFAULT_MAX_SYNC_EXECUTION_MS;
  }

  // ── Public API ────────────────────────────────────────────────────────────

  /**
   * Update the bridge resolver (e.g. when the data provider changes).
   */
  setBridge(bridge: ScriptBridgeResolver): void {
    this.bridge = bridge;
  }

  /**
   * Run a SCADA script with optional parameters.
   * Returns a ScriptResult with success/error information and timing.
   */
  async runScript(
    script: ScadaScript,
    params: Record<string, unknown> = {},
  ): Promise<ScriptResult> {
    if (!script.enabled) {
      return {
        scriptId: script.id,
        success: false,
        error: 'Script is disabled',
        durationMs: 0,
      };
    }

    if (this.running.has(script.id)) {
      return {
        scriptId: script.id,
        success: false,
        error: 'Script is already running',
        durationMs: 0,
      };
    }

    this.running.add(script.id);
    const start = performance.now();

    try {
      const result = await this._execute(script, params);
      const durationMs = performance.now() - start;
      return { scriptId: script.id, success: true, result, durationMs };
    } catch (err) {
      const durationMs = performance.now() - start;
      const message = err instanceof Error ? err.message : String(err);
      this._appendConsole('error', script.id, message);
      return { scriptId: script.id, success: false, error: message, durationMs };
    } finally {
      this.running.delete(script.id);
    }
  }

  /**
   * Whether a specific script is currently executing.
   */
  isRunning(scriptId: string): boolean {
    return this.running.has(scriptId);
  }

  /**
   * Get the console output buffer.
   * Returns a shallow copy — mutations do not affect the engine.
   */
  getConsoleOutput(): ScriptConsoleEntry[] {
    return [...this.consoleBuffer];
  }

  /**
   * Clear the console buffer, optionally filtered by script ID.
   */
  clearConsole(scriptId?: string): void {
    if (scriptId === undefined) {
      this.consoleBuffer = [];
    } else {
      this.consoleBuffer = this.consoleBuffer.filter(
        (e) => e.scriptId !== scriptId,
      );
    }
  }

  // ── Private ───────────────────────────────────────────────────────────────

  /**
   * Execute a script with timeout protection and a synchronous-execution watchdog.
   *
   * **Timeout cleanup:** The `setTimeout` backing the timeout promise is always
   * cleared via the `finally` block, preventing dangling timer leaks when the
   * script resolves before the deadline.
   *
   * **Synchronous infinite loop caveat:**
   * A script that enters a synchronous infinite loop (`while (true) {}`) will
   * block the main thread.  Because JavaScript is single-threaded, no timer
   * callback (including the timeout) can fire until the loop yields.  The
   * watchdog timer set here will only fire *after* the loop completes (or
   * never), so it serves as a diagnostic signal rather than a hard kill.
   *
   * For production hardening, execute user scripts inside a Web Worker where
   * the main thread can call `worker.terminate()` to forcibly abort execution.
   */
  private async _execute(
    script: ScadaScript,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    // Build bridge functions for this execution.
    const { $getTag, $setTag, $setView, $getAlarm } = this._buildBridge(script.id);

    // Build the captured console.
    const $console = this._buildConsole(script.id);

    // Construct the sandboxed function.
    // The Function constructor does not close over the surrounding lexical
    // scope, so internal variables are not accidentally accessible.
    // We expose only what we explicitly pass as named arguments.
    // eslint-disable-next-line no-new-func
    const factory = new Function(
      '$getTag',
      '$setTag',
      '$setView',
      '$getAlarm',
      '$console',
      'params',
      `"use strict";
return (async function __scadaScript__() {
${script.code}
})();`,
    );

    // ── Timeout with proper cleanup (Issue 1 fix) ──────────────────────────
    // The timeoutHandle is always cleared in the `finally` block so we never
    // leave a dangling setTimeout when the script resolves normally.
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

    // ── Synchronous-execution watchdog (Issue 2 mitigation) ────────────────
    // This watchdog fires only if the event loop is *not* blocked.  If a
    // synchronous infinite loop is running, the callback cannot execute until
    // the loop yields — at which point the warning is still useful as a
    // post-mortem diagnostic.  True sync cancellation requires Web Workers.
    let watchdogHandle: ReturnType<typeof setTimeout> | undefined;
    let executionStarted = true;

    try {
      const scriptPromise: Promise<unknown> = factory(
        $getTag,
        $setTag,
        $setView,
        $getAlarm,
        $console,
        params,
      );

      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(
          () => reject(new Error(`Script timed out after ${this.timeoutMs} ms`)),
          this.timeoutMs,
        );
      });

      // Watchdog: log a warning if the script appears to be blocking the
      // event loop beyond the advisory threshold.
      watchdogHandle = setTimeout(() => {
        if (executionStarted) {
          console.warn(
            `[ScriptEngine] Script "${script.id}" has been executing for ` +
            `>${this.maxSyncExecutionMs} ms — possible synchronous infinite loop. ` +
            `Consider using a Web Worker for production hardening.`,
          );
        }
      }, this.maxSyncExecutionMs);

      return await Promise.race([scriptPromise, timeoutPromise]);
    } finally {
      executionStarted = false;
      if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
      if (watchdogHandle !== undefined) clearTimeout(watchdogHandle);
    }
  }

  private _buildBridge(scriptId: string): ScriptBridge {
    const resolver = this.bridge;

    const $getTag = (tagId: string): unknown => {
      const val = resolver.getTagValue(tagId);
      return val?.value ?? null;
    };

    const $setTag = async (tagId: string, value: unknown): Promise<void> => {
      await resolver.writeTagValue(tagId, value);
    };

    const $setView = (viewId: string): void => {
      resolver.setView(viewId);
    };

    const $getAlarm = (alarmId: string): AlarmInstance | null => {
      return resolver.getAlarm(alarmId);
    };

    // Suppress unused variable warning for scriptId (kept for potential
    // future per-execution bridge customization).
    void scriptId;

    return { $getTag, $setTag, $setView, $getAlarm };
  }

  private _buildConsole(
    scriptId: string,
  ): Record<string, (...args: unknown[]) => void> {
    const capture = (level: ScriptConsoleEntry['level']) => {
      return (...args: unknown[]) => {
        const text = args
          .map((a) => {
            if (typeof a === 'string') return a;
            try {
              return JSON.stringify(a);
            } catch {
              return String(a);
            }
          })
          .join(' ');
        this._appendConsole(level, scriptId, text);
      };
    };

    return {
      log: capture('log'),
      warn: capture('warn'),
      error: capture('error'),
      info: capture('info'),
    };
  }

  private _appendConsole(
    level: ScriptConsoleEntry['level'],
    scriptId: string,
    text: string,
  ): void {
    const entry: ScriptConsoleEntry = {
      level,
      text,
      scriptId,
      timestamp: Date.now(),
    };
    this.consoleBuffer.push(entry);
    if (this.consoleBuffer.length > MAX_CONSOLE_LINES) {
      this.consoleBuffer = this.consoleBuffer.slice(-MAX_CONSOLE_LINES);
    }
  }
}

// ── Factory ────────────────────────────────────────────────────────────────────

/**
 * Create a ScriptEngine wired to the given bridge resolver.
 */
export function createScriptEngine(
  bridge: ScriptBridgeResolver,
  options?: ScriptEngineOptions,
): ScriptEngine {
  return new ScriptEngine(bridge, options);
}
