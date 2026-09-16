import { original } from 'immer';
import type { ScadaSliceCreator, AlarmSlice, AlarmRuleDef } from './types';
import { DEFAULT_CONTROL_PERMISSIONS, DEFAULT_TREND_CONFIG } from './types';
import { appendHistory } from './historySlice';

export const createAlarmSlice: ScadaSliceCreator<AlarmSlice> = (set) => ({
  // State
  alarmRules: [],
  controlPermissions: { ...DEFAULT_CONTROL_PERMISSIONS, securityLevels: { ...DEFAULT_CONTROL_PERMISSIONS.securityLevels } },
  trendConfig: { ...DEFAULT_TREND_CONFIG, tags: [...DEFAULT_TREND_CONFIG.tags] },

  // Actions
  addAlarmRule: (rule) =>
    set((state) => {
      state.alarmRules.push(rule);
      state.isDirty = true;
      appendHistory(state, { type: 'ALARM_ADD', rule });
    }),

  removeAlarmRule: (id) =>
    set((state) => {
      const prev = original(state) ?? state;
      const index = prev.alarmRules.findIndex((r) => r.id === id);
      if (index === -1) return;
      const rule: AlarmRuleDef = prev.alarmRules[index];
      state.alarmRules = state.alarmRules.filter((r) => r.id !== id);
      state.isDirty = true;
      appendHistory(state, { type: 'ALARM_REMOVE', rule, index });
    }),

  updateAlarmRule: (id, updates) =>
    set((state) => {
      const rule = state.alarmRules.find((r) => r.id === id);
      if (!rule) return;
      const prev = original(state) ?? state;
      const before = prev.alarmRules.find((r) => r.id === id);
      if (!before) return;
      Object.assign(rule, updates);
      state.isDirty = true;
      appendHistory(state, {
        type: 'ALARM_UPDATE',
        ruleId: id,
        before,
        after: { ...before, ...updates },
      });
    }),

  // Control permissions / trend config are package-level configuration, not
  // canvas mutations — they are intentionally NOT wired into undo history.
  updateControlPermissions: (perms) =>
    set((state) => {
      state.controlPermissions = perms;
      state.isDirty = true;
    }),

  updateTrendConfig: (config) =>
    set((state) => {
      state.trendConfig = config;
      state.isDirty = true;
    }),
});
