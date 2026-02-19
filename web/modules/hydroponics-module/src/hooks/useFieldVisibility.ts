import { useMemo } from 'react';
import type { ModeState } from '../types/modes.types';

export interface FieldVisibility {
  showNsTypeSelector: boolean;
  showCultivationType: boolean;
  showTargetDrainagePercent: boolean;
  showCurrentDrainageEc: boolean;
  showFirstReadjustment: boolean;
  nsTypeLocked: boolean;
  showDrainageTabs: boolean;
}

export function useFieldVisibility(mode: ModeState): FieldVisibility {
  return useMemo<FieldVisibility>(() => ({
    showNsTypeSelector: !mode.isStarter,
    showCultivationType: mode.systemType === 'closed',
    showTargetDrainagePercent: mode.systemType === 'closed',
    showCurrentDrainageEc: mode.systemType === 'closed',
    showFirstReadjustment: mode.nsType === 'adjusting',
    nsTypeLocked: mode.isStarter,
    showDrainageTabs: mode.nsType === 'adjusting',
  }), [mode.isStarter, mode.nsType, mode.systemType]);
}
