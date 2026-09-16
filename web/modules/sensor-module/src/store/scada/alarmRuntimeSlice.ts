/**
 * alarmRuntimeSlice — Runtime alarm state & actions.
 *
 * Manages live alarm instances, alarm history, the status summary pushed
 * from the server, history filter state, and the pending action queue
 * (toasts, popups, setView commands triggered by alarm transitions).
 *
 * This slice is distinct from alarmSlice, which owns design-time alarm
 * rule definitions. This slice owns only operator-mode runtime state.
 *
 * ONE STORE / ONE TRANSPORT (T1): this slice lives ONLY inside the unified
 * useScadaPackageStore (there is no standalone alarm store anymore), and
 * acknowledgements are NEVER applied locally — ACK commands are emitted over
 * the ScadaSocketService and the state only changes when the server pushes
 * the next ALARM_STATUS. A local optimistic ACK would let the UI show an
 * alarm as acknowledged even when the server rejected it.
 */
import type { ScadaSliceCreator } from './types';
import { getScadaSocketService } from '../../services/ScadaSocketService';
import type {
  AlarmInstance,
  AlarmStatusSummary,
  AlarmHistoryFilter,
  AlarmActionCommand,
} from '../../types/scada-runtime.types';

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

const MAX_ALARM_HISTORY = 1000;

/* ------------------------------------------------------------------ */
/*  Slice Interface                                                     */
/* ------------------------------------------------------------------ */

export interface AlarmRuntimeSlice {
  // State
  activeAlarms: AlarmInstance[];
  alarmHistory: AlarmInstance[];
  alarmStatusSummary: AlarmStatusSummary | null;
  alarmHistoryFilter: AlarmHistoryFilter;
  pendingActions: AlarmActionCommand[];

  // Actions
  setActiveAlarms: (alarms: AlarmInstance[]) => void;
  updateAlarmStatus: (summary: AlarmStatusSummary) => void;
  /**
   * Socket-only ACK: emits ALARM_ACK to the server. No local mutation —
   * the acknowledged state arrives with the next ALARM_STATUS push.
   */
  submitAlarmAck: (alarmId: string) => void;
  /** Socket-only ACK-all: emits ALARM_ACK_ALL. No local mutation. */
  submitAlarmAckAll: () => void;
  /** Replace the history list from an ALARM_HISTORY_RESULT payload. */
  setAlarmHistory: (alarms: AlarmInstance[]) => void;
  addToHistory: (alarm: AlarmInstance) => void;
  setAlarmHistoryFilter: (filter: Partial<AlarmHistoryFilter>) => void;
  clearPendingActions: () => void;
  consumePendingAction: (index: number) => void;
  /** Atomically returns and clears all pending actions in a single mutation. */
  consumeAllPendingActions: () => AlarmActionCommand[];
}

/* ------------------------------------------------------------------ */
/*  Slice Creator                                                       */
/* ------------------------------------------------------------------ */

export const createAlarmRuntimeSlice: ScadaSliceCreator<AlarmRuntimeSlice> = (set, get) => ({
  // Initial state
  activeAlarms: [],
  alarmHistory: [],
  alarmStatusSummary: null,
  alarmHistoryFilter: {},
  pendingActions: [],

  // Actions
  setActiveAlarms: (alarms) =>
    set((state) => {
      state.activeAlarms = alarms;
    }),

  updateAlarmStatus: (summary) =>
    set((state) => {
      state.alarmStatusSummary = summary;
      state.activeAlarms = summary.activeAlarms;
      if (summary.pendingActions && summary.pendingActions.length > 0) {
        state.pendingActions.push(...summary.pendingActions);
      }
    }),

  submitAlarmAck: (alarmId) => {
    getScadaSocketService().acknowledgeAlarm(alarmId);
  },

  submitAlarmAckAll: () => {
    getScadaSocketService().acknowledgeAllAlarms();
  },

  setAlarmHistory: (alarms) =>
    set((state) => {
      state.alarmHistory = alarms.slice(-MAX_ALARM_HISTORY);
    }),

  addToHistory: (alarm) =>
    set((state) => {
      state.alarmHistory.push(alarm);
      if (state.alarmHistory.length > MAX_ALARM_HISTORY) {
        state.alarmHistory = state.alarmHistory.slice(-MAX_ALARM_HISTORY);
      }
    }),

  setAlarmHistoryFilter: (filter) =>
    set((state) => {
      Object.assign(state.alarmHistoryFilter, filter);
    }),

  clearPendingActions: () =>
    set((state) => {
      state.pendingActions = [];
    }),

  consumePendingAction: (index) =>
    set((state) => {
      if (index < 0 || index >= state.pendingActions.length) return;
      state.pendingActions.splice(index, 1);
    }),

  consumeAllPendingActions: () => {
    const current = get().pendingActions;
    if (current.length === 0) return [];
    // Take a shallow copy before clearing so callers can iterate safely.
    const actions = [...current];
    set((state) => {
      state.pendingActions = [];
    });
    return actions;
  },
});
