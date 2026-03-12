/**
 * useSimulation — React hook that bridges StInterpreter with React state.
 *
 * Manages the simulation lifecycle: load ST code → parse → create interpreter →
 * run cycles (single-step or continuous) → expose variable snapshots to the UI.
 *
 * Performance rules applied:
 *  - useCallback on every action (stable references, no re-render cascades)
 *  - useRef for interpreter instance (mutation without re-render)
 *  - useState only for UI-visible state: state, error, variables, cycleCount, scanCycleMs
 *  - useEffect cleanup: clearInterval on unmount
 *  - variables snapshot is a new array each cycle (React change detection)
 */
import { useState, useCallback, useRef, useEffect } from 'react';
import { parseST } from './st-parser-lite';
import { StInterpreter, SimValue, VariableInfo } from './st-interpreter';

// ── Public types ────────────────────────────────────────────

export type SimulationState = 'idle' | 'ready' | 'running' | 'paused' | 'error';

export interface UseSimulationReturn {
  // State
  state: SimulationState;
  error: string | null;
  variables: VariableInfo[];
  cycleCount: number;
  scanCycleMs: number;

  // Actions
  load: (code: string) => void;
  runOneCycle: () => void;
  startContinuous: (intervalMs?: number) => void;
  pause: () => void;
  stop: () => void;
  setInput: (name: string, value: SimValue) => void;
  setScanCycleMs: (ms: number) => void;

  // Synchronous accessors for closed-loop use (bypass React state)
  /** Read variable info directly from interpreter — no stale closure risk */
  getVariableSnapshot: () => VariableInfo[];
  /** Set input variable directly on interpreter without triggering refreshVariables */
  setInputDirect: (name: string, value: SimValue) => void;
  /** Run one cycle directly without React state updates (call refreshVariables after) */
  runOneCycleDirect: () => void;
}

// ── Hook ────────────────────────────────────────────────────

export function useSimulation(): UseSimulationReturn {
  // ---- React state (drives re-renders) ----
  const [state, setState] = useState<SimulationState>('idle');
  const [error, setError] = useState<string | null>(null);
  const [variables, setVariables] = useState<VariableInfo[]>([]);
  const [cycleCount, setCycleCount] = useState(0);
  const [scanCycleMs, setScanCycleMsState] = useState(100);

  // ---- Refs (no re-render) ----
  const interpreterRef = useRef<StInterpreter | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const scanCycleMsRef = useRef(scanCycleMs);

  // Keep ref in sync with state so callbacks see latest value without dep churn
  scanCycleMsRef.current = scanCycleMs;

  // ---- Helpers ----

  /** Take a fresh variable snapshot from the interpreter and push to state. */
  const refreshVariables = useCallback(() => {
    const interp = interpreterRef.current;
    if (!interp) return;
    // New array each time → React detects the change
    setVariables(interp.getVariableInfo());
  }, []);

  /** Stop the continuous interval if one is running. */
  const clearRunInterval = useCallback(() => {
    if (intervalRef.current !== null) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
  }, []);

  // ---- Actions ----

  const load = useCallback(
    (code: string) => {
      // Stop any running simulation first
      clearRunInterval();

      try {
        const { ast, errors } = parseST(code);

        if (errors.length > 0) {
          setState('error');
          setError(errors.map((e) => e.message).join('\n'));
          interpreterRef.current = null;
          setVariables([]);
          setCycleCount(0);
          return;
        }

        if (ast.length === 0) {
          setState('error');
          setError('No program found in the provided code.');
          interpreterRef.current = null;
          setVariables([]);
          setCycleCount(0);
          return;
        }

        const interp = new StInterpreter(ast[0]);
        interpreterRef.current = interp;

        setState('ready');
        setError(null);
        setCycleCount(0);
        setVariables(interp.getVariableInfo());
      } catch (err) {
        setState('error');
        setError(err instanceof Error ? err.message : String(err));
        interpreterRef.current = null;
        setVariables([]);
        setCycleCount(0);
      }
    },
    [clearRunInterval],
  );

  const runOneCycle = useCallback(() => {
    const interp = interpreterRef.current;
    if (!interp) return;

    try {
      interp.runCycle();
      setCycleCount((prev) => prev + 1);
      refreshVariables();
      // Single step leaves us in ready (or paused if we were paused)
      setState((prev) => (prev === 'running' ? 'running' : 'ready'));
    } catch (err) {
      setState('error');
      setError(err instanceof Error ? err.message : String(err));
      clearRunInterval();
    }
  }, [refreshVariables, clearRunInterval]);

  const startContinuous = useCallback(
    (intervalMs?: number) => {
      const interp = interpreterRef.current;
      if (!interp) return;

      // Clear any previous interval
      clearRunInterval();

      const ms = intervalMs ?? scanCycleMsRef.current;
      setState('running');

      intervalRef.current = setInterval(() => {
        try {
          interp.runCycle();
          setCycleCount((prev) => prev + 1);
          refreshVariables();
        } catch (err) {
          setState('error');
          setError(err instanceof Error ? err.message : String(err));
          clearRunInterval();
        }
      }, ms);
    },
    [clearRunInterval, refreshVariables],
  );

  const pause = useCallback(() => {
    clearRunInterval();
    setState('paused');
    // Variables are preserved — no reset
  }, [clearRunInterval]);

  const stop = useCallback(() => {
    clearRunInterval();

    const interp = interpreterRef.current;
    if (interp) {
      interp.reset();
      setVariables(interp.getVariableInfo());
    }

    setState(interp ? 'ready' : 'idle');
    setCycleCount(0);
    setError(null);
  }, [clearRunInterval]);

  const setInput = useCallback(
    (name: string, value: SimValue) => {
      const interp = interpreterRef.current;
      if (!interp) return;

      // Safety: only allow setting VAR_INPUT scoped variables
      const info = interp.getVariableInfo();
      const varInfo = info.find((v) => v.name === name);
      if (!varInfo || varInfo.scope !== 'VAR_INPUT') {
        return; // silently refuse non-input variables
      }

      interp.setVariable(name, value);
      refreshVariables();
    },
    [refreshVariables],
  );

  // ---- Synchronous accessors for closed-loop (no React state overhead) ----

  const getVariableSnapshot = useCallback((): VariableInfo[] => {
    return interpreterRef.current?.getVariableInfo() ?? [];
  }, []);

  const setInputDirect = useCallback((name: string, value: SimValue) => {
    const interp = interpreterRef.current;
    if (!interp) return;
    const info = interp.getVariableInfo();
    const varInfo = info.find((v) => v.name === name);
    if (!varInfo || (varInfo.scope !== 'VAR_INPUT' && varInfo.scope !== 'VAR_IN_OUT')) return;
    interp.setVariable(name, value);
  }, []);

  const runOneCycleDirect = useCallback(() => {
    const interp = interpreterRef.current;
    if (!interp) return;
    interp.runCycle();
    setCycleCount((prev) => prev + 1);
  }, []);

  const setScanCycleMs = useCallback(
    (ms: number) => {
      const clamped = Math.max(10, ms); // Minimum 10ms to avoid pegging the CPU
      setScanCycleMsState(clamped);
      scanCycleMsRef.current = clamped;

      // If currently running, restart the interval with the new rate
      if (intervalRef.current !== null) {
        clearRunInterval();

        const interp = interpreterRef.current;
        if (interp) {
          intervalRef.current = setInterval(() => {
            try {
              interp.runCycle();
              setCycleCount((prev) => prev + 1);
              refreshVariables();
            } catch (err) {
              setState('error');
              setError(err instanceof Error ? err.message : String(err));
              clearRunInterval();
            }
          }, clamped);
        }
      }
    },
    [clearRunInterval, refreshVariables],
  );

  // ---- Cleanup on unmount ----

  useEffect(() => {
    return () => {
      if (intervalRef.current !== null) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, []);

  // ---- Return ----

  return {
    // State
    state,
    error,
    variables,
    cycleCount,
    scanCycleMs,

    // Actions
    load,
    runOneCycle,
    startContinuous,
    pause,
    stop,
    setInput,
    setScanCycleMs,

    // Synchronous accessors
    getVariableSnapshot,
    setInputDirect,
    runOneCycleDirect,
  };
}
