/**
 * useAlarmRuntime — Connects the alarm engine backend to the React UI.
 *
 * ONE STORE / ONE TRANSPORT (T1):
 *  - Store: reads/writes the alarmRuntimeSlice inside the unified
 *    useScadaPackageStore. The old standalone `useAlarmRuntimeStore`
 *    (a second Zustand store that nothing else ever wrote to) is deleted.
 *  - Transport: ScadaSocketService exclusively. The old path went through
 *    the socketFactory pool with the DEFAULT '/socket.io/' path, which
 *    nginx routes to the gateway — an instance that serves no /scada
 *    namespace — so alarm traffic was silently dead.
 *
 * Responsibilities:
 *  - (Optionally) register the ALARM_STATUS listener → alarmRuntimeSlice.
 *    OperatorBootstrap is the canonical dispatcher; pass `listen: true` only
 *    when the hook is mounted OUTSIDE the operator bootstrap tree.
 *  - Dispatches alarm ACK commands to the server (individual + all) —
 *    never mutates local state; state updates arrive via ALARM_STATUS.
 *  - Handles pending alarm actions (toast, popup, setView) via callbacks.
 *  - Exposes queryHistory() for loading chronicle records.
 *
 * The hook is side-effect-free when unmounted: listeners are cleaned up.
 */

import { useEffect, useRef, useCallback, useState } from 'react';

import {
  ScadaSocketEvent,
  type AlarmStatusSummary,
  type AlarmInstance,
  type AlarmHistoryFilter,
} from '../types/scada-runtime.types';

import { useScadaPackageStore } from '../store/scada/createScadaStore';
import { getScadaSocketService } from '../services/ScadaSocketService';

/* ------------------------------------------------------------------ */
/*  Hook return type                                                    */
/* ------------------------------------------------------------------ */

export interface UseAlarmRuntimeResult {
  activeAlarms: AlarmInstance[];
  summary: AlarmStatusSummary | null;
  acknowledgeAlarm: (alarmId: string) => void;
  acknowledgeAll: () => void;
  history: AlarmInstance[];
  queryHistory: (filter: AlarmHistoryFilter) => Promise<void>;
  isLoading: boolean;
}

/* ------------------------------------------------------------------ */
/*  Optional action callbacks                                           */
/* ------------------------------------------------------------------ */

export interface AlarmRuntimeCallbacks {
  onToast?: (message: string, type: 'error' | 'warning' | 'success' | 'info') => void;
  onPopup?: (message: string) => void;
  onSetView?: (viewId: string) => void;
}

export interface UseAlarmRuntimeOptions {
  callbacks?: AlarmRuntimeCallbacks;
  /**
   * Register an ALARM_STATUS listener on the socket service. Defaults to
   * false: inside the operator tree OperatorBootstrap already dispatches
   * ALARM_STATUS into the store, and a second dispatcher would double-enqueue
   * pendingActions (toasts/popups). Enable only for mounts outside the
   * bootstrap (stories/tests).
   */
  listen?: boolean;
  /**
   * Consume queued alarm actions (toast/popup/setView) and dispatch them to
   * `callbacks`. Defaults to FALSE — a mount without this flag never drains
   * the queue (A2/Plan 2: passive consumers like AlarmPanel/AlarmSummaryBar
   * used to swallow the server's alarm commands). Exactly ONE mount in the
   * operator tree (OperatorBootstrap) should enable this.
   */
  processActions?: boolean;
}

/* ------------------------------------------------------------------ */
/*  Hook                                                                */
/* ------------------------------------------------------------------ */

export function useAlarmRuntime(
  callbacksOrOptions?: AlarmRuntimeCallbacks | UseAlarmRuntimeOptions,
): UseAlarmRuntimeResult {
  // Backwards-compatible call shape: useAlarmRuntime(callbacks) — treat a
  // bare callbacks object as { callbacks }.
  const options: UseAlarmRuntimeOptions =
    callbacksOrOptions && 'callbacks' in callbacksOrOptions
      ? (callbacksOrOptions as UseAlarmRuntimeOptions)
      : { callbacks: callbacksOrOptions as AlarmRuntimeCallbacks | undefined };

  const [isLoading, setIsLoading] = useState(false);

  // Unified package store selectors (alarmRuntimeSlice lives here).
  const activeAlarms = useScadaPackageStore((s) => s.activeAlarms);
  const summary = useScadaPackageStore((s) => s.alarmStatusSummary);
  const history = useScadaPackageStore((s) => s.alarmHistory);
  const pendingActions = useScadaPackageStore((s) => s.pendingActions);

  const submitAlarmAck = useScadaPackageStore((s) => s.submitAlarmAck);
  const submitAlarmAckAll = useScadaPackageStore((s) => s.submitAlarmAckAll);
  const setAlarmHistory = useScadaPackageStore((s) => s.setAlarmHistory);
  const consumeAllPendingActions = useScadaPackageStore((s) => s.consumeAllPendingActions);

  // Keep callbacks in a ref so event handlers always have the latest version
  const callbacksRef = useRef(options.callbacks);
  callbacksRef.current = options.callbacks;

  // ── Optional ALARM_STATUS listener (outside-bootstrap mounts only) ──────
  useEffect(() => {
    if (!options.listen) return;
    const socket = getScadaSocketService();
    const updateAlarmStatus = useScadaPackageStore.getState().updateAlarmStatus;
    const handler = (payload: AlarmStatusSummary): void => {
      updateAlarmStatus(payload);
    };
    socket.on(ScadaSocketEvent.ALARM_STATUS, handler);
    return () => {
      socket.off(ScadaSocketEvent.ALARM_STATUS, handler);
    };
  }, [options.listen]);

  // ── Pending action processor (single consumer: processActions only) ─────
  useEffect(() => {
    if (!options.processActions || pendingActions.length === 0) return;

    // Atomically consume all pending actions in a single store mutation,
    // then process the returned snapshot. This avoids O(n) individual
    // store updates that each trigger a re-render.
    const actions = consumeAllPendingActions();

    for (const action of actions) {
      try {
        switch (action.type) {
          case 'toastMessage': {
            const toastType = action.toastType ?? 'info';
            callbacksRef.current?.onToast?.(
              action.message ?? '',
              toastType as 'error' | 'warning' | 'success' | 'info',
            );
            break;
          }
          case 'popup': {
            callbacksRef.current?.onPopup?.(action.message ?? '');
            break;
          }
          case 'setView': {
            if (action.viewId) {
              callbacksRef.current?.onSetView?.(action.viewId);
            }
            break;
          }
        }
      } catch (err) {
        console.error('[useAlarmRuntime] action handler error:', err);
      }
    }
  }, [options.processActions, pendingActions, consumeAllPendingActions]);

  // ── ACK single alarm (socket only — server pushes the new state) ────────
  const acknowledgeAlarm = useCallback((alarmId: string) => {
    submitAlarmAck(alarmId);
  }, [submitAlarmAck]);

  // ── ACK all alarms (socket only) ────────────────────────────────────────
  const acknowledgeAll = useCallback(() => {
    submitAlarmAckAll();
  }, [submitAlarmAckAll]);

  // ── History query ────────────────────────────────────────────────────────
  const queryHistory = useCallback(async (filter: AlarmHistoryFilter): Promise<void> => {
    setIsLoading(true);
    try {
      const alarms = await getScadaSocketService().queryAlarmHistory(filter);
      setAlarmHistory(alarms);
    } catch (err) {
      console.error('[useAlarmRuntime] queryHistory error:', err);
    } finally {
      setIsLoading(false);
    }
  }, [setAlarmHistory]);

  return {
    activeAlarms,
    summary,
    acknowledgeAlarm,
    acknowledgeAll,
    history,
    queryHistory,
    isLoading,
  };
}
