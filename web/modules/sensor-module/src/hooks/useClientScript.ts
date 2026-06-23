/**
 * useClientScript — Sandboxed client-side script execution (operator runtime).
 *
 * Execution model:
 *  - User code runs EXCLUSIVELY inside a Web Worker sandbox via the shared
 *    `ScriptExecutor` (engine/scripting). No user code is ever evaluated on
 *    the main thread — there is no `new Function`/`eval` here.
 *  - The executor is driven by two buses it already understands:
 *      • TagValueBus  — seeded from the live IDataProvider at execution start
 *                       ($getTag) and bridged so $setTag writes route back to
 *                       provider.writeTagValue.
 *      • WidgetEventBus — script navigation/overlay calls ($setView/$navigate,
 *                       $openCard, $closeDialog) are mapped to the operator
 *                       store's overlay actions, preserving the legacy
 *                       "$setView opens a dialog overlay" behaviour exactly.
 *  - Console output ($console.* / $log) is surfaced to the HMI console panel
 *    via the captured worker `logs`, with the same 200-line cap as before.
 *  - The 500ms worker timeout (SANDBOX_LIMITS.TIMEOUT_MS) replaces the old
 *    5s main-thread race; the worker is terminated on overrun.
 *
 * Security note: Because user code runs in a Worker isolate with dangerous
 * globals deleted (fetch, XMLHttpRequest, eval, Function, …), scripts cannot
 * touch window/DOM/network from the application realm. This is a true
 * sandbox, unlike the previous Function-constructor approach.
 */

import { useState, useRef, useCallback, useEffect, useMemo } from 'react';
import { useDataProvider } from '../providers';
import { useOperatorStore } from '../store/scada/operatorStore';
import { ScriptExecutor } from '../engine/scripting/ScriptExecutor';
import type { ScadaScript as EngineScript } from '../engine/scripting/types';
import { TagValueBus } from '../engine/tags/TagValueBus';
import { WidgetEventBus } from '../engine/events/WidgetEventBus';
import type { WidgetEventPayload } from '../engine/events/types';
import type { ScadaScript, ScriptResult } from '../types/scada-runtime.types';

/* ------------------------------------------------------------------ */
/*  Constants                                                           */
/* ------------------------------------------------------------------ */

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
/*  Runtime → engine script projection                                  */
/* ------------------------------------------------------------------ */

/**
 * Project the operator-runtime ScadaScript shape onto the engine
 * ScadaScript shape consumed by ScriptExecutor.execute. Both describe the
 * same package-level script; the engine type narrows `trigger` to its
 * required form. This is a structural projection, not a duplicated type.
 */
function toEngineScript(script: ScadaScript): EngineScript {
  return {
    id: script.id,
    name: script.name,
    code: script.code,
    trigger: script.trigger ?? 'event',
    triggerTag: script.triggerTag,
    triggerInterval: script.triggerInterval,
    enabled: script.enabled,
    deviceId: script.deviceId,
  };
}

/* ------------------------------------------------------------------ */
/*  Hook                                                                */
/* ------------------------------------------------------------------ */

export function useClientScript(): ClientScriptResult {
  const provider = useDataProvider();
  // $setView/$navigate and $openCard open overlays; $closeDialog closes them.
  // The operator store exposes overlay openers/closers used by the runtime.
  const openOverlay = useOperatorStore((s) => s.openOverlay);
  const closeAllOverlays = useOperatorStore((s) => s.closeAllOverlays);

  const [isRunning, setIsRunning] = useState(false);
  const [consoleOutput, setConsoleOutput] = useState<string[]>([]);

  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  // Keep the latest provider/overlay actions in refs so the buses (created
  // once) always reach current implementations without being recreated.
  const providerRef = useRef(provider);
  providerRef.current = provider;
  const openOverlayRef = useRef(openOverlay);
  openOverlayRef.current = openOverlay;
  const closeAllOverlaysRef = useRef(closeAllOverlays);
  closeAllOverlaysRef.current = closeAllOverlays;

  // -----------------------------------------------------------------------
  // Buses + executor (stable for the hook's lifetime)
  // -----------------------------------------------------------------------

  const tagBus = useMemo(() => new TagValueBus(), []);
  const eventBus = useMemo(() => new WidgetEventBus(), []);
  const executor = useMemo(() => new ScriptExecutor(tagBus, eventBus), [tagBus, eventBus]);

  // Bridge: $setTag → provider.writeTagValue (persistent for the hook's life).
  // ScriptExecutor.$setTag publishes to the TagValueBus during worker
  // execution; we forward each publish to the live provider exactly as the
  // legacy $setTag did. Seeding uses tagBus.seed() (silent) so initial tag
  // values never reach this listener — only script-originated writes do.
  useEffect(() => {
    const unsub = tagBus.subscribe('*', (value, tagName) => {
      void providerRef.current.writeTagValue(tagName, value);
    });
    return unsub;
  }, [tagBus]);

  // Bridge: worker navigation/overlay dispatches → operator store overlays.
  useEffect(() => {
    const unsubs: Array<() => void> = [];

    // $setView (legacy) and $navigate (worker) both open the target screen as
    // a DIALOG overlay — identical to the legacy hook's $setView behaviour.
    unsubs.push(
      eventBus.register('navigate', (event: WidgetEventPayload) => {
        const screenId = event.params.targetScreenId;
        if (!screenId) return;
        openOverlayRef.current({
          type: 'dialog',
          screenId,
          position: { x: 0, y: 0 },
        });
      }),
    );

    // $openCard → CARD overlay at the requested (default 0,0) position.
    unsubs.push(
      eventBus.register('openCard', (event: WidgetEventPayload) => {
        const screenId = event.params.targetScreenId;
        if (!screenId) return;
        const hasSize =
          event.params.width !== undefined || event.params.height !== undefined;
        openOverlayRef.current({
          type: 'card',
          screenId,
          position: { x: 0, y: 0 },
          ...(hasSize
            ? { size: { width: event.params.width ?? 400, height: event.params.height ?? 300 } }
            : {}),
        });
      }),
    );

    // $closeDialog → close the active overlays.
    unsubs.push(
      eventBus.register('closeDialog', () => {
        closeAllOverlaysRef.current();
      }),
    );

    return () => unsubs.forEach((u) => u());
  }, [eventBus]);

  // Dispose the worker pool when the hook unmounts.
  useEffect(() => {
    return () => {
      executor.dispose();
    };
  }, [executor]);

  // -----------------------------------------------------------------------
  // Console capture
  // -----------------------------------------------------------------------

  const appendLines = useCallback((lines: string[]) => {
    if (lines.length === 0 || !mountedRef.current) return;
    setConsoleOutput((prev) => {
      const next = [...prev, ...lines];
      return next.length > MAX_CONSOLE_LINES ? next.slice(-MAX_CONSOLE_LINES) : next;
    });
  }, []);

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

      // Seed the tag snapshot from the live provider so the worker's
      // synchronous $getTag reads see the same values the legacy hook read
      // live. A per-invocation snapshot is behaviourally equivalent for
      // event-handler scripts. seed() updates the value map silently so the
      // persistent $setTag write-bridge is not triggered by seeding; only
      // primitive values are stored (matching $getTag's return contract).
      const snapshot = providerRef.current.getTagSnapshot();
      const primitives: Record<string, unknown> = {};
      for (const [tagId, change] of Object.entries(snapshot)) {
        primitives[tagId] = change.value;
      }
      tagBus.seed(primitives);

      setIsRunning(true);
      try {
        const result = await executor.execute(toEngineScript(script), params);

        // Surface captured console/log output to the HMI console panel.
        appendLines(result.logs);

        if (mountedRef.current) setIsRunning(false);

        if (result.success) {
          return {
            scriptId: script.id,
            success: true,
            durationMs: result.durationMs,
          };
        }
        return {
          scriptId: script.id,
          success: false,
          error: result.error ?? 'Script execution failed',
          durationMs: result.durationMs,
        };
      } catch (err) {
        if (mountedRef.current) setIsRunning(false);
        const message = err instanceof Error ? err.message : String(err);
        appendLines([`[error] ${message}`]);
        return { scriptId: script.id, success: false, error: message, durationMs: 0 };
      }
    },
    [tagBus, executor, appendLines],
  );

  return { runScript, isRunning, consoleOutput };
}
