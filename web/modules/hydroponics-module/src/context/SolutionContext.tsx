import React, { createContext, useContext, useReducer, useCallback, useMemo, useRef, useEffect } from 'react';
import {
  SolutionSettings,
  GeneralOptions,
  WaterAnalysis,
  UserOptions,
  createDefaultSettings,
} from '../types/solution.types';
import type {
  NsType,
  SystemType,
  ModeState,
  DrainageComposition,
  CurrentNsFormula,
  ReadjustmentSettings,
} from '../types/modes.types';

// ============================================================================
// State & Actions
// ============================================================================

interface SolutionState {
  settings: SolutionSettings;
  isDirty: boolean;
}

type SolutionAction =
  | { type: 'SET_GENERAL'; payload: Partial<GeneralOptions> }
  | { type: 'SET_WATER'; payload: Partial<WaterAnalysis> }
  | { type: 'SET_USER'; payload: Partial<UserOptions> }
  | { type: 'SET_FIELD'; payload: { section: keyof SolutionSettings; path: string; value: unknown } }
  | { type: 'SET_DRAINAGE'; payload: DrainageComposition }
  | { type: 'SET_PREVIOUS_DRAINAGE'; payload: DrainageComposition }
  | { type: 'SET_NS_FORMULA'; payload: CurrentNsFormula }
  | { type: 'SET_READJUSTMENT'; payload: Partial<ReadjustmentSettings> }
  | { type: 'SET_NS_TYPE'; payload: NsType }
  | { type: 'RESET' }
  | { type: 'LOAD'; payload: SolutionSettings }
  | { type: 'MARK_SAVED' };

// ============================================================================
// Reducer
// ============================================================================

function setNestedValue(obj: Record<string, unknown>, path: string, value: unknown): Record<string, unknown> {
  const keys = path.split('.');
  // SEC-HYD-006: Guard against prototype pollution via path segments
  if (keys.some((k) => k === '__proto__' || k === 'constructor' || k === 'prototype')) {
    throw new Error('Attempted prototype pollution via SET_FIELD path');
  }
  const result = { ...obj };
  let current: Record<string, unknown> = result;

  for (let i = 0; i < keys.length - 1; i++) {
    current[keys[i]] = { ...(current[keys[i]] as Record<string, unknown>) };
    current = current[keys[i]] as Record<string, unknown>;
  }
  current[keys[keys.length - 1]] = value;
  return result;
}

const defaultDrainage: DrainageComposition = {
  ec: 0,
  ph: 6.0,
  parameters: {},
  sameAsIrrigation: false,
};

const defaultNsFormula: CurrentNsFormula = {
  targetEcDsMixer: 0,
  targetEcFertigation: 0,
  parameters: {},
};

const defaultReadjustment: ReadjustmentSettings = {
  isFirstReadjustment: true,
  fertigationMode: 'pulse',
  timeApplyingCurrentNs: 7,
  timeToRestore: 7,
  emittersPerPlant: 2,
  emitterFlowRate: 2.0,
  irrigationDuration: 5,
  irrigationsPerDay: 10,
  substrateType: 'rockwool',
  substrateVolumePerPlant: 15,
  drainageStorageVolume: 1000,
};

function solutionReducer(state: SolutionState, action: SolutionAction): SolutionState {
  switch (action.type) {
    case 'SET_GENERAL':
      return {
        ...state,
        isDirty: true,
        settings: {
          ...state.settings,
          generalOptions: { ...state.settings.generalOptions, ...action.payload },
        },
      };

    case 'SET_WATER':
      return {
        ...state,
        isDirty: true,
        settings: {
          ...state.settings,
          waterAnalysis: { ...state.settings.waterAnalysis, ...action.payload },
        },
      };

    case 'SET_USER':
      return {
        ...state,
        isDirty: true,
        settings: {
          ...state.settings,
          userOptions: { ...state.settings.userOptions, ...action.payload },
        },
      };

    case 'SET_FIELD': {
      const section = state.settings[action.payload.section];
      // BUG-HYD-001 / CRIT-2: Guard against undefined section (e.g. readjustmentSettings
      // when nsType !== 'adjusting'). Spreading undefined produces {} which silently
      // drops all required fields, causing NaN in downstream calculations.
      if (section === undefined) {
        return state;
      }
      const updated = setNestedValue(
        section as unknown as Record<string, unknown>,
        action.payload.path,
        action.payload.value
      );
      return {
        ...state,
        isDirty: true,
        settings: {
          ...state.settings,
          [action.payload.section]: updated,
        },
      };
    }

    case 'SET_DRAINAGE':
      return {
        ...state,
        isDirty: true,
        settings: { ...state.settings, drainageComposition: action.payload },
      };

    case 'SET_PREVIOUS_DRAINAGE':
      return {
        ...state,
        isDirty: true,
        settings: { ...state.settings, previousDrainage: action.payload },
      };

    case 'SET_NS_FORMULA':
      return {
        ...state,
        isDirty: true,
        settings: { ...state.settings, currentNsFormula: action.payload },
      };

    case 'SET_READJUSTMENT':
      return {
        ...state,
        isDirty: true,
        settings: {
          ...state.settings,
          readjustmentSettings: {
            ...(state.settings.readjustmentSettings ?? defaultReadjustment),
            ...action.payload,
          },
        },
      };

    case 'SET_NS_TYPE': {
      const nsType = action.payload;
      const newSettings = { ...state.settings };
      newSettings.generalOptions = {
        ...newSettings.generalOptions,
        basicOptions: { ...newSettings.generalOptions.basicOptions, nsType },
      };
      if (nsType === 'adjusting') {
        newSettings.drainageComposition = newSettings.drainageComposition ?? { ...defaultDrainage };
        newSettings.previousDrainage = newSettings.previousDrainage ?? { ...defaultDrainage };
        newSettings.currentNsFormula = newSettings.currentNsFormula ?? { ...defaultNsFormula };
        newSettings.readjustmentSettings = newSettings.readjustmentSettings ?? { ...defaultReadjustment };
      }
      return { ...state, isDirty: true, settings: newSettings };
    }

    case 'RESET':
      return { settings: createDefaultSettings(), isDirty: false };

    case 'LOAD':
      return { settings: action.payload, isDirty: false };

    case 'MARK_SAVED':
      return { ...state, isDirty: false };

    default:
      return state;
  }
}

// ============================================================================
// Context — split into state and dispatch to minimise re-renders
//
// PERF-HYD-003: Splitting the context into two separate contexts means tabs that
// only dispatch actions (never read state) do not re-render on every keystroke.
// Only consumers that read `settings` / `isDirty` / `mode` re-render when state
// changes — dispatch consumers (action callbacks) never re-render for state updates.
// ============================================================================

interface SolutionStateValue {
  settings: SolutionSettings;
  isDirty: boolean;
  mode: ModeState;
}

interface SolutionDispatchValue {
  setGeneral: (payload: Partial<GeneralOptions>) => void;
  setWater: (payload: Partial<WaterAnalysis>) => void;
  setUser: (payload: Partial<UserOptions>) => void;
  setField: (section: keyof SolutionSettings, path: string, value: unknown) => void;
  setDrainage: (payload: DrainageComposition) => void;
  setPreviousDrainage: (payload: DrainageComposition) => void;
  setNsFormula: (payload: CurrentNsFormula) => void;
  setReadjustment: (payload: Partial<ReadjustmentSettings>) => void;
  setNsType: (nsType: NsType) => void;
  reset: () => void;
  load: (settings: SolutionSettings) => void;
  save: () => void;
}

// Merged interface kept for API compatibility with useSolution()
type SolutionContextValue = SolutionStateValue & SolutionDispatchValue;

const SolutionStateContext = createContext<SolutionStateValue | null>(null);
const SolutionDispatchContext = createContext<SolutionDispatchValue | null>(null);
// Legacy single context kept for useSolution() backwards compatibility
const SolutionContext = createContext<SolutionContextValue | null>(null);

// ============================================================================
// Provider
// ============================================================================

export const SolutionProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [state, dispatch] = useReducer(solutionReducer, {
    settings: createDefaultSettings(),
    isDirty: false,
  });

  const setGeneral = useCallback((payload: Partial<GeneralOptions>) => {
    dispatch({ type: 'SET_GENERAL', payload });
  }, []);

  const setWater = useCallback((payload: Partial<WaterAnalysis>) => {
    dispatch({ type: 'SET_WATER', payload });
  }, []);

  const setUser = useCallback((payload: Partial<UserOptions>) => {
    dispatch({ type: 'SET_USER', payload });
  }, []);

  const setField = useCallback((section: keyof SolutionSettings, path: string, value: unknown) => {
    dispatch({ type: 'SET_FIELD', payload: { section, path, value } });
  }, []);

  const setDrainage = useCallback((payload: DrainageComposition) => {
    dispatch({ type: 'SET_DRAINAGE', payload });
  }, []);

  const setPreviousDrainage = useCallback((payload: DrainageComposition) => {
    dispatch({ type: 'SET_PREVIOUS_DRAINAGE', payload });
  }, []);

  const setNsFormula = useCallback((payload: CurrentNsFormula) => {
    dispatch({ type: 'SET_NS_FORMULA', payload });
  }, []);

  const setReadjustment = useCallback((payload: Partial<ReadjustmentSettings>) => {
    dispatch({ type: 'SET_READJUSTMENT', payload });
  }, []);

  const setNsType = useCallback((nsType: NsType) => {
    dispatch({ type: 'SET_NS_TYPE', payload: nsType });
  }, []);

  const reset = useCallback(() => dispatch({ type: 'RESET' }), []);
  const load = useCallback((settings: SolutionSettings) => dispatch({ type: 'LOAD', payload: settings }), []);

  // PERF-HYD-005: Stabilise save() reference using a ref so it doesn't contribute
  // to context value churn on every state change.
  // SEC-HYD-002: console.log removed — no operational data exposed to console.
  const settingsRef = useRef(state.settings);
  useEffect(() => { settingsRef.current = state.settings; }, [state.settings]);
  const save = useCallback(() => {
    // TODO: Replace with backend API call when the persistence endpoint is available.
    // settingsRef.current contains the current settings at the time of the call.
    dispatch({ type: 'MARK_SAVED' });
  }, []);

  const mode = useMemo<ModeState>(() => ({
    nsType: state.settings.generalOptions.basicOptions.nsType,
    systemType: state.settings.generalOptions.serviceDefinition.systemType as SystemType,
    isStarter: state.settings.generalOptions.basicOptions.cultivationStage === 'starter',
  }), [
    state.settings.generalOptions.basicOptions.nsType,
    state.settings.generalOptions.serviceDefinition.systemType,
    state.settings.generalOptions.basicOptions.cultivationStage,
  ]);

  // PERF-HYD-003: State value changes on every dispatch.
  const stateValue = useMemo<SolutionStateValue>(
    () => ({ settings: state.settings, isDirty: state.isDirty, mode }),
    [state.settings, state.isDirty, mode]
  );

  // PERF-HYD-003: Dispatch value contains only stable callbacks — never changes.
  const dispatchValue = useMemo<SolutionDispatchValue>(
    () => ({
      setGeneral, setWater, setUser, setField, setDrainage, setPreviousDrainage,
      setNsFormula, setReadjustment, setNsType, reset, load, save,
    }),
    [setGeneral, setWater, setUser, setField, setDrainage, setPreviousDrainage,
     setNsFormula, setReadjustment, setNsType, reset, load, save]
  );

  // Merged value for useSolution() backwards compatibility
  const mergedValue = useMemo<SolutionContextValue>(
    () => ({ ...stateValue, ...dispatchValue }),
    [stateValue, dispatchValue]
  );

  return (
    <SolutionStateContext.Provider value={stateValue}>
      <SolutionDispatchContext.Provider value={dispatchValue}>
        <SolutionContext.Provider value={mergedValue}>
          {children}
        </SolutionContext.Provider>
      </SolutionDispatchContext.Provider>
    </SolutionStateContext.Provider>
  );
};

// ============================================================================
// Hooks
// ============================================================================

/** Full merged context — use when you need both state and dispatch. */
export function useSolution(): SolutionContextValue {
  const ctx = useContext(SolutionContext);
  if (!ctx) {
    throw new Error('useSolution must be used within a SolutionProvider');
  }
  return ctx;
}

/**
 * PERF-HYD-003: State-only hook — use in components that only read data.
 * Re-renders whenever settings/isDirty/mode changes.
 */
export function useSolutionState(): SolutionStateValue {
  const ctx = useContext(SolutionStateContext);
  if (!ctx) {
    throw new Error('useSolutionState must be used within a SolutionProvider');
  }
  return ctx;
}

/**
 * PERF-HYD-003: Dispatch-only hook — use in components that only call actions.
 * Never re-renders due to state changes (all callbacks are stable refs).
 */
export function useSolutionDispatch(): SolutionDispatchValue {
  const ctx = useContext(SolutionDispatchContext);
  if (!ctx) {
    throw new Error('useSolutionDispatch must be used within a SolutionProvider');
  }
  return ctx;
}
