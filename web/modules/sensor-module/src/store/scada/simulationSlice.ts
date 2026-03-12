/**
 * simulationSlice — Simulation mode state & actions.
 *
 * Manages SCADA simulation mode where users can inject tag values,
 * run automation programs, and test alarm rules without a physical device.
 */
import type { ScadaSliceCreator, SimulationSlice } from './types';

export const createSimulationSlice: ScadaSliceCreator<SimulationSlice> = (set) => ({
  simulationMode: false,
  simTagValues: {},
  simAlarms: [],

  setSimulationMode: (on) =>
    set((state) => {
      state.simulationMode = on;
      if (!on) {
        // Clear simulation state when exiting
        state.simTagValues = {};
        state.simAlarms = [];
      }
    }),

  setSimTagValue: (tagName, value) =>
    set((state) => {
      // Guard: no-op if simulation mode is off (prevents zombie writes from stale intervals)
      if (!state.simulationMode) return;
      state.simTagValues[tagName] = value;
    }),

  setSimTagValuesBatch: (values) =>
    set((state) => {
      if (!state.simulationMode) return;
      if (Object.keys(values).length === 0) return;
      Object.assign(state.simTagValues, values);
    }),

  clearSimTagValues: () =>
    set((state) => {
      state.simTagValues = {};
    }),

  setSimAlarms: (alarms) =>
    set((state) => {
      state.simAlarms = alarms;
    }),
});
