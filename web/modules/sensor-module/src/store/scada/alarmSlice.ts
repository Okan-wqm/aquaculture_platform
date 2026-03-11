import type { ScadaSliceCreator, AlarmSlice } from './types';
import { DEFAULT_CONTROL_PERMISSIONS, DEFAULT_TREND_CONFIG } from './types';

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
    }),

  removeAlarmRule: (id) =>
    set((state) => {
      state.alarmRules = state.alarmRules.filter((r) => r.id !== id);
      state.isDirty = true;
    }),

  updateAlarmRule: (id, updates) =>
    set((state) => {
      const rule = state.alarmRules.find((r) => r.id === id);
      if (!rule) return;
      Object.assign(rule, updates);
      state.isDirty = true;
    }),

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
