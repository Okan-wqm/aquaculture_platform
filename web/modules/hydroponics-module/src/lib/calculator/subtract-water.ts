import type { WaterParameter } from '../../types/solution.types';
import type { NutrientVector, SubtractResult } from './types';
import { emptyVector } from './types';
import { mgLToUmol } from '../units';

/**
 * Step 2: Subtract irrigation water composition from target.
 * toAdd = target - irrigationWater (negative values clamped to 0 with warning)
 */

const MACRO_KEYS: (keyof NutrientVector)[] = ['K', 'Ca', 'Mg', 'NH4', 'NO3', 'H2PO4', 'SO4', 'Cl', 'Na', 'HCO3', 'Si'];
const MICRO_KEYS: (keyof NutrientVector)[] = ['Fe', 'Mn', 'Zn', 'Cu', 'B', 'Mo'];

/** Map water parameter IDs to NutrientVector keys */
const WATER_TO_VECTOR: Record<string, keyof NutrientVector> = {
  k: 'K',
  ca: 'Ca',
  mg: 'Mg',
  nh4: 'NH4',
  no3: 'NO3',
  p: 'H2PO4',
  so4: 'SO4',
  cl: 'Cl',
  na: 'Na',
  hco3: 'HCO3',
  si: 'Si',
  fe: 'Fe',
  mn: 'Mn',
  zn: 'Zn',
  cu: 'Cu',
  b: 'B',
  mo: 'Mo',
};

export function waterParametersToVector(params: WaterParameter[]): NutrientVector {
  const v = emptyVector();
  for (const p of params) {
    const key = WATER_TO_VECTOR[p.id];
    if (!key) continue;

    if (MICRO_KEYS.includes(key)) {
      // Water micro values in ppm (mg/L) → convert to umol/L
      v[key] = p.unit === 'ppm' ? mgLToUmol(p.value, key) : p.value;
    } else if (key === 'Si') {
      // Si can be in ppm
      v[key] = p.unit === 'ppm' ? mgLToUmol(p.value, 'Si') : p.value;
    } else {
      // Macro in mmol/L (assume already mmol if unit = 'mmol')
      v[key] = p.value;
    }
  }
  return v;
}

export function subtractWater(
  target: NutrientVector,
  water: NutrientVector
): SubtractResult {
  const toAdd = emptyVector();
  const warnings: string[] = [];
  const allKeys = [...MACRO_KEYS, ...MICRO_KEYS] as (keyof NutrientVector)[];

  for (const key of allKeys) {
    const diff = target[key] - water[key];
    if (diff < 0) {
      warnings.push(`${key}: water contains more than target (${water[key].toFixed(3)} > ${target[key].toFixed(3)}). Set to 0.`);
      toAdd[key] = 0;
    } else {
      toAdd[key] = diff;
    }
  }

  return { toAdd, warnings };
}
