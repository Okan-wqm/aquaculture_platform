/**
 * alarmRuntimeSlice — Runtime alarm state & actions.
 *
 * Manages live alarm instances, alarm history, the status summary pushed
 * from the server, history filter state, and the pending action queue
 * (toasts, popups, setView commands triggered by alarm transitions).
 *
 * This slice is distinct from alarmSlice, which owns design-time alarm
 * rule definitions. This slice owns only operator-mode runtime state.
 */
import type { ScadaSliceCreator } from './types';
import type {
  AlarmInstance,
  AlarmStatusSummary,
  AlarmHistoryFilter,
  AlarmActionCommand,
} from '../../types/scada-runtime.types';

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
  acknowledgeAlarm: (alarmId: string) => void;
  acknowledgeAllAlarms: () => void;
  addToHistory: (alarm: AlarmInstance) => void;
  setAlarmHistoryFilter: (filter: Partial<AlarmHistoryFilter>) => void;
  clearPendingActions: () => void;
  consumePendingAction: (index: number) => void;
}

/* ------------------------------------------------------------------ */
/*  Slice Creator                                                       */
/* ------------------------------------------------------------------ */

export const createAlarmRuntimeSlice: ScadaSliceCreator<AlarmRuntimeSlice> = (set) => ({
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

  acknowledgeAlarm: (alarmId) =>
    set((state) => {
      const now = Date.now();
      const alarm = state.activeAlarms.find((a) => a.id === alarmId);
      if (!alarm) return;
      alarm.status = 'acknowledged';
      alarm.ackTime = now;
    }),

  acknowledgeAllAlarms: () =>
    set((state) => {
      const now = Date.now();
      for (const alarm of state.activeAlarms) {
        if (alarm.status !== 'acknowledged') {
          alarm.status = 'acknowledged';
          alarm.ackTime = now;
        }
      }
    }),

  addToHistory: (alarm) =>
    set((state) => {
      state.alarmHistory.push(alarm);
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
});
