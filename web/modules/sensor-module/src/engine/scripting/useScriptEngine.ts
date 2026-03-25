/**
 * React hook that manages script lifecycle for a SCADA package.
 *
 * Responsibilities:
 * 1. Creates and disposes a ScriptExecutor (Web Worker pool) tied to the
 *    React component lifecycle
 * 2. Sets up trigger subscriptions:
 *    - 'load': executes once when the hook mounts
 *    - 'tagChange': subscribes to TagValueBus for the specified trigger tag
 *    - 'interval': creates a setInterval timer (min 1000ms)
 *    - 'event': no automatic trigger -- scripts run via executeScript()
 * 3. Tracks per-script logs and errors for UI display (script console)
 * 4. Cleans up all subscriptions, timers, and workers on unmount
 *
 * Usage:
 * ```tsx
 * const { executeScript, scriptLogs, scriptErrors } = useScriptEngine(
 *   scadaPackage.scripts,
 *   tagBus,
 *   eventBus
 * );
 * ```
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { TagValueBus } from '../tags/TagValueBus';
import type { WidgetEventBus } from '../events/WidgetEventBus';
import type { ScadaScript, ScriptExecutionResult } from './types';
import { SANDBOX_LIMITS } from './types';
import { ScriptExecutor } from './ScriptExecutor';

interface UseScriptEngineReturn {
  /** Manually execute a script by ID (for 'event' trigger or ad-hoc execution) */
  executeScript: (
    scriptId: string,
    params?: Record<string, unknown>
  ) => Promise<ScriptExecutionResult | undefined>;
  /** Per-script log messages (scriptId -> log lines) */
  scriptLogs: Map<string, string[]>;
  /** Per-script last error message (scriptId -> error string) */
  scriptErrors: Map<string, string>;
}

export function useScriptEngine(
  scripts: ScadaScript[],
  tagBus: TagValueBus | null,
  eventBus: WidgetEventBus | null
): UseScriptEngineReturn {
  const [scriptLogs, setScriptLogs] = useState<Map<string, string[]>>(
    () => new Map()
  );
  const [scriptErrors, setScriptErrors] = useState<Map<string, string>>(
    () => new Map()
  );

  // Ref to hold the executor so it persists across renders but can be
  // disposed on unmount without causing stale closures
  const executorRef = useRef<ScriptExecutor | null>(null);

  // Memoize the enabled scripts list so we don't re-subscribe on every render
  const enabledScripts = useMemo(
    () => scripts.filter((s) => s.enabled),
    [scripts]
  );

  // Create/dispose the executor when buses become available or change
  useEffect(() => {
    if (!tagBus || !eventBus) {
      executorRef.current = null;
      return;
    }

    const executor = new ScriptExecutor(tagBus, eventBus);
    executorRef.current = executor;

    return () => {
      executor.dispose();
      executorRef.current = null;
    };
  }, [tagBus, eventBus]);

  /**
   * Internal execute helper that runs a script, updates logs/errors state,
   * and returns the execution result.
   */
  const runScript = useCallback(
    async (
      script: ScadaScript,
      params?: Record<string, unknown>
    ): Promise<ScriptExecutionResult | undefined> => {
      const executor = executorRef.current;
      if (!executor) return undefined;

      const result = await executor.execute(script, params);

      // Update logs for this script
      if (result.logs.length > 0) {
        setScriptLogs((prev) => {
          const next = new Map(prev);
          const existing = next.get(script.id) ?? [];
          // Keep the last 100 log lines per script to prevent unbounded growth
          const merged = [...existing, ...result.logs].slice(-100);
          next.set(script.id, merged);
          return next;
        });
      }

      // Update error state for this script
      if (result.error) {
        setScriptErrors((prev) => {
          const next = new Map(prev);
          next.set(script.id, result.error!);
          return next;
        });
      } else {
        // Clear previous error on success
        setScriptErrors((prev) => {
          if (!prev.has(script.id)) return prev;
          const next = new Map(prev);
          next.delete(script.id);
          return next;
        });
      }

      return result;
    },
    []
  );

  /**
   * Public API: execute a script by ID.
   * Primarily used for 'event' trigger scripts that are invoked from widget
   * event handlers, but can also be used to manually re-run any script.
   */
  const executeScript = useCallback(
    async (
      scriptId: string,
      params?: Record<string, unknown>
    ): Promise<ScriptExecutionResult | undefined> => {
      const script = enabledScripts.find((s) => s.id === scriptId);
      if (!script) return undefined;
      return runScript(script, params);
    },
    [enabledScripts, runScript]
  );

  // Set up trigger subscriptions for enabled scripts
  useEffect(() => {
    if (!tagBus || !executorRef.current) return;

    const cleanups: Array<() => void> = [];

    for (const script of enabledScripts) {
      switch (script.trigger) {
        case 'load': {
          // Execute once on mount (fire-and-forget, errors tracked in state)
          runScript(script);
          break;
        }

        case 'tagChange': {
          if (!script.triggerTag) break;
          const unsub = tagBus.subscribe(script.triggerTag, () => {
            runScript(script);
          });
          cleanups.push(unsub);
          break;
        }

        case 'interval': {
          // Enforce minimum interval to prevent CPU abuse
          const interval = Math.max(
            script.triggerInterval ?? SANDBOX_LIMITS.MIN_INTERVAL_MS,
            SANDBOX_LIMITS.MIN_INTERVAL_MS
          );
          const handle = setInterval(() => {
            runScript(script);
          }, interval);
          cleanups.push(() => clearInterval(handle));
          break;
        }

        case 'event': {
          // Event-triggered scripts are invoked explicitly via executeScript().
          // No automatic subscription needed here.
          break;
        }
      }
    }

    return () => {
      for (const cleanup of cleanups) {
        cleanup();
      }
    };
    // We include runScript in deps but it's stable (useCallback with [] deps)
  }, [enabledScripts, tagBus, runScript]);

  return { executeScript, scriptLogs, scriptErrors };
}
