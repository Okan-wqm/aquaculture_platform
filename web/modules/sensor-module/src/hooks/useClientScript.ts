/**
 * useClientScript — Sandboxed client-side script execution.
 *
 * Execution model:
 *  - Uses the Function constructor (not eval) for a degree of sandboxing.
 *  - Injects $getTag, $setTag, and $setView system functions sourced from
 *    the active IDataProvider and the OperatorStore.
 *  - Enforces a 5-second execution timeout via a racing Promise.
 *  - Captures console.log / console.warn / console.error output so the
 *    SCADA designer can see script output in the HMI console panel.
 *  - Supports async scripts (the generated function is always awaited).
 *
 * Security note: Client scripts run in the same JavaScript realm as the
 * application.  The Function constructor prevents closure access to outer
 * scope variables, but does not provide a true sandbox — scripts can still
 * access window, fetch, etc.  For production deployments consider running
 * scripts in a Worker or iframe sandbox.
 */

import { useState, useRef, useCallback, useEffect } from 'react';
import { useDataProvider } from '../providers';
import { useOperatorStore } from '../store/scada/operatorStore';
import type { ScadaScript, ScriptResult } from '../types/scada-runtime.types';

/* ------------------------------------------------------------------ */
/*  Constants                                                           */
/* ------------------------------------------------------------------ */

const SCRIPT_TIMEOUT_MS = 5_000;
const MAX_CONSOLE_LINES = 200;

/* ------------------------------------------------------------------ */
/*  Hook return type                                                    */
/* ------------------------------------------------------------------ */

export interface ClientScriptResult {
  runScript: (
    script: ScadaScript,
    params?: Record<string, unknown>,
  ) => Promise<ScriptResult>;
  isRunning: boolean;
  consoleOutput: string[];
}

/* ------------------------------------------------------------------ */
/*  Timeout helper                                                      */
/* ------------------------------------------------------------------ */

function timeoutPromise(ms: number): Promise<never> {
  return new Promise((_, reject) =>
    setTimeout(() => reject(new Error(`Script timed out after ${ms} ms`)), ms),
  );
}

/* ------------------------------------------------------------------ */
/*  Hook                                                                */
/* ------------------------------------------------------------------ */

export function useClientScript(): ClientScriptResult {
  const provider = useDataProvider();
  // We need $setView to navigate to a screen: the operator store does not
  // expose a "navigate to screen" directly, so we pull the overlay opener
  // which can open a dialog-type overlay for a given screenId.
  const openOverlay = useOperatorStore((s) => s.openOverlay);

  const [isRunning, setIsRunning] = useState(false);
  const [consoleOutput, setConsoleOutput] = useState<string[]>([]);

  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  // -----------------------------------------------------------------------
  // Console capture
  // -----------------------------------------------------------------------

  const appendLine = useCallback((level: string, args: unknown[]) => {
    const text = args
      .map((a) => {
        if (typeof a === 'string') return a;
        try { return JSON.stringify(a); } catch { return String(a); }
      })
      .join(' ');
    const line = `[${level}] ${text}`;
    if (!mountedRef.current) return;
    setConsoleOutput((prev) => {
      const next = [...prev, line];
      return next.length > MAX_CONSOLE_LINES ? next.slice(-MAX_CONSOLE_LINES) : next;
    });
  }, []);

  // -----------------------------------------------------------------------
  // System functions injected into the script scope
  // -----------------------------------------------------------------------

  const buildSysFunctions = useCallback(
    (captureLog: (level: string, args: unknown[]) => void) => {
      const $getTag = (tagId: string): unknown => {
        const val = provider.getTagValue(tagId);
        return val?.value ?? null;
      };

      const $setTag = async (tagId: string, value: unknown): Promise<void> => {
        await provider.writeTagValue(tagId, value);
      };

      // $setView opens a target screen as a dialog overlay so the script can
      // trigger navigation programmatically.
      const $setView = (screenId: string): void => {
        openOverlay({
          type: 'dialog',
          screenId,
          position: { x: 0, y: 0 },
        });
      };

      const $console = {
        log:   (...args: unknown[]) => captureLog('log',   args),
        warn:  (...args: unknown[]) => captureLog('warn',  args),
        error: (...args: unknown[]) => captureLog('error', args),
        info:  (...args: unknown[]) => captureLog('info',  args),
      };

      return { $getTag, $setTag, $setView, $console };
    },
    [provider, openOverlay],
  );

  // -----------------------------------------------------------------------
  // runScript
  // -----------------------------------------------------------------------

  const runScript = useCallback(
    async (
      script: ScadaScript,
      params: Record<string, unknown> = {},
    ): Promise<ScriptResult> => {
      if (!script.enabled) {
        return {
          scriptId: script.id,
          success: false,
          error: 'Script is disabled',
          durationMs: 0,
        };
      }

      setIsRunning(true);
      const capturedLines: string[] = [];

      const captureLog = (level: string, args: unknown[]) => {
        const text = args
          .map((a) => {
            if (typeof a === 'string') return a;
            try { return JSON.stringify(a); } catch { return String(a); }
          })
          .join(' ');
        capturedLines.push(`[${level}] ${text}`);
        appendLine(level, args);
      };

      const { $getTag, $setTag, $setView, $console } =
        buildSysFunctions(captureLog);

      const start = performance.now();

      try {
        // Build the sandboxed function.  The Function constructor does not
        // close over the surrounding lexical scope, so internal variables like
        // `provider` and `openOverlay` are not accidentally accessible.
        // We expose only what we explicitly pass as named arguments.
        // eslint-disable-next-line no-new-func
        const factory = new Function(
          '$getTag',
          '$setTag',
          '$setView',
          '$console',
          'params',
          `"use strict";
return (async function __scadaScript__() {
${script.code}
})();`,
        );

        const scriptPromise: Promise<unknown> = factory(
          $getTag,
          $setTag,
          $setView,
          $console,
          params,
        );

        const result = await Promise.race([scriptPromise, timeoutPromise(SCRIPT_TIMEOUT_MS)]);

        const durationMs = performance.now() - start;
        if (mountedRef.current) setIsRunning(false);

        return { scriptId: script.id, success: true, result, durationMs };
      } catch (err) {
        const durationMs = performance.now() - start;
        if (mountedRef.current) setIsRunning(false);

        const message = err instanceof Error ? err.message : String(err);
        captureLog('error', [message]);

        return { scriptId: script.id, success: false, error: message, durationMs };
      }
    },
    [appendLine, buildSysFunctions],
  );

  return { runScript, isRunning, consoleOutput };
}
