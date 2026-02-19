import { useMemo } from 'react';
import type { ModeState } from '../types/modes.types';

export interface TabDef {
  id: string;
  label: string;
  path: string;
}

const STANDARD_TABS: TabDef[] = [
  { id: 'general_options', label: 'General Options', path: 'general_options' },
  { id: 'water_analysis', label: 'Water Analysis', path: 'water_analysis' },
  { id: 'user_options', label: 'User Options', path: 'user_options' },
  { id: 'result', label: 'Result', path: 'result' },
];

const ADJUSTING_TABS: TabDef[] = [
  { id: 'general_options', label: 'General Options', path: 'general_options' },
  { id: 'water_analysis', label: 'Water Analysis', path: 'water_analysis' },
  { id: 'drainage_composition', label: 'Current Drainage', path: 'drainage_composition' },
  { id: 'previous_drainage', label: 'Previous Drainage', path: 'previous_drainage' },
  { id: 'current_ns_formula', label: 'Current NS Formula', path: 'current_ns_formula' },
  { id: 'readjustment', label: 'Readjustment', path: 'readjustment' },
  { id: 'user_options', label: 'User Options', path: 'user_options' },
  { id: 'result', label: 'Result', path: 'result' },
];

export function useVisibleTabs(mode: ModeState): TabDef[] {
  return useMemo(() => {
    return mode.nsType === 'adjusting' ? ADJUSTING_TABS : STANDARD_TABS;
  }, [mode.nsType]);
}
