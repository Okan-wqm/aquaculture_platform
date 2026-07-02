/**
 * useAlarmRuntime — Connects the alarm engine backend to the React UI.
 *
 * Responsibilities:
 *  - Listens for ALARM_STATUS WebSocket events from the /scada namespace.
 *  - Updates the alarmRuntimeSlice (activeAlarms, summary, pendingActions).
 *  - Dispatches alarm ACK commands to the server (individual + all).
 *  - Handles pending alarm actions (toast, popup, setView) via callbacks.
 *  - Exposes queryHistory() for loading chronicle records.
 *
 * Socket strategy:
 *  Uses the socketFactory pool (same pattern as useScadaLiveData) to get
 *  a raw Socket.IO connection to the /scada namespace. This avoids any
 *  dependency on the ScadaSocketService typed-listener layer while still
 *  sharing the underlying connection.
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

import { createAlarmRuntimeSlice } from '../store/scada/alarmRuntimeSlice';
import type { AlarmRuntimeSlice } from '../store/scada/alarmRuntimeSlice';
import { getSocket, releaseSocket } from './socketFactory';

// ── Standalone Zustand store for alarm runtime state ─────────────────────────
// A dedicated small store keeps alarm runtime state self-contained and avoids
// modifying the existing OperatorStore.
import { create } from 'zustand';
import type { StateCreator } from 'zustand';
import { immer } from 'zustand/middleware/immer';

export type AlarmRuntimeStore = AlarmRuntimeSlice;
const createStandaloneAlarmRuntimeSlice = createAlarmRuntimeSlice as unknown as StateCreator<
  AlarmRuntimeStore,
  [['zustand/immer', never]],
  [],
  AlarmRuntimeStore
>;

export const useAlarmRuntimeStore = create<AlarmRuntimeStore>()(
  immer((...args) => ({
    ...createStandaloneAlarmRuntimeSlice(...args),
  })),
);

// ── SCADA WebSocket URL (mirrors other hooks) ─────────────────────────────────
const SCADA_WS_URL: string =
  (() => {
    const base =
      (typeof import.meta !== 'undefined' &&
        (import.meta as unknown as Record<string, unknown>).env != null
        ? (import.meta as unknown as { env: Record<string, string> }).env.VITE_WS_URL
        : undefined) ??
      (typeof window !== 'undefined'
        ? (window as Window & { __RUNTIME_CONFIG__?: { WS_URL?: string } }).__RUNTIME_CONFIG__?.WS_URL
        : undefined) ??
      '';
    return base ? `${base}/scada` : '/scada';
  })();

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

/* ------------------------------------------------------------------ */
/*  Hook                                                                */
/* ------------------------------------------------------------------ */

export function useAlarmRuntime(
  callbacks?: AlarmRuntimeCallbacks,
): UseAlarmRuntimeResult {
  const [isLoading, setIsLoading] = useState(false);

  // Zustand store selectors
  const activeAlarms = useAlarmRuntimeStore((s) => s.activeAlarms);
  const summary = useAlarmRuntimeStore((s) => s.alarmStatusSummary);
  const history = useAlarmRuntimeStore((s) => s.alarmHistory);
  const pendingActions = useAlarmRuntimeStore((s) => s.pendingActions);

  const updateAlarmStatus = useAlarmRuntimeStore((s) => s.updateAlarmStatus);
  const consumeAllPendingActions = useAlarmRuntimeStore((s) => s.consumeAllPendingActions);

  // Keep callbacks in a ref so event handlers always have the latest version
  const callbacksRef = useRef<AlarmRuntimeCallbacks | undefined>(callbacks);
  callbacksRef.current = callbacks;

  // ── Socket listener ──────────────────────────────────────────────────────
  useEffect(() => {
    const socket = getSocket(SCADA_WS_URL);
    if (!socket) return;

    const handleAlarmStatus = (payload: AlarmStatusSummary) => {
      updateAlarmStatus(payload);
    };

    socket.on(ScadaSocketEvent.ALARM_STATUS, handleAlarmStatus);

    return () => {
      socket.off(ScadaSocketEvent.ALARM_STATUS, handleAlarmStatus);
      releaseSocket(socket);
    };
  }, [updateAlarmStatus]);

  // ── Pending action processor ─────────────────────────────────────────────
  useEffect(() => {
    if (pendingActions.length === 0) return;

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
  }, [pendingActions, consumeAllPendingActions]);

  // ── ACK single alarm ─────────────────────────────────────────────────────
  const acknowledgeAlarm = useCallback((alarmId: string) => {
    const socket = getSocket(SCADA_WS_URL);
    if (!socket) {
      console.warn('[useAlarmRuntime] acknowledgeAlarm: no socket available');
      return;
    }
    socket.emit(ScadaSocketEvent.ALARM_ACK, { alarmInstanceId: alarmId });
    releaseSocket(socket);
  }, []);

  // ── ACK all alarms ───────────────────────────────────────────────────────
  const acknowledgeAll = useCallback(() => {
    const socket = getSocket(SCADA_WS_URL);
    if (!socket) {
      console.warn('[useAlarmRuntime] acknowledgeAll: no socket available');
      return;
    }
    socket.emit(ScadaSocketEvent.ALARM_ACK_ALL, {});
    releaseSocket(socket);
  }, []);

  // ── History query ────────────────────────────────────────────────────────
  const queryHistory = useCallback(async (filter: AlarmHistoryFilter): Promise<void> => {
    setIsLoading(true);
    const socket = getSocket(SCADA_WS_URL);
    if (!socket) {
      console.warn('[useAlarmRuntime] queryHistory: no socket available');
      setIsLoading(false);
      return;
    }

    try {
      await new Promise<void>((resolve, reject) => {
        const TIMEOUT_MS = 15_000;
        const timer = setTimeout(() => {
          socket.off(ScadaSocketEvent.ALARM_HISTORY_RESULT, handler);
          reject(new Error('[useAlarmRuntime] History query timed out'));
        }, TIMEOUT_MS);

        const handler = (payload: { alarms?: AlarmInstance[] }) => {
          clearTimeout(timer);
          socket.off(ScadaSocketEvent.ALARM_HISTORY_RESULT, handler);

          if (payload?.alarms) {
            useAlarmRuntimeStore.setState((state) => {
              state.alarmHistory = payload.alarms!;
            });
          }
          resolve();
        };

        socket.on(ScadaSocketEvent.ALARM_HISTORY_RESULT, handler);
        socket.emit(ScadaSocketEvent.ALARM_HISTORY_QUERY, filter);
      });
    } catch (err) {
      console.error('[useAlarmRuntime] queryHistory error:', err);
    } finally {
      releaseSocket(socket);
      setIsLoading(false);
    }
  }, []);

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
