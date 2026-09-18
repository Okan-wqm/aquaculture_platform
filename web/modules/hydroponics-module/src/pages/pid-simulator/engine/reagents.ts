/**
 * Hydroponics Reagent Database & Direction Calculator
 * Independent module for hydroponic chemicals.
 */
import { colors } from '@aquaculture/shared-ui';

export interface HydroReagent {
  name: string;
  formula: string;
  mw: number;        // g/mol
  meqPerMol: number;
  slope: number;     // dALK/dDIC (Infinity = vertical)
  radians: number;   // Deffeyes direction angle
  color: string;
  type: 'acid' | 'base' | 'other';
}

export const HYDRO_REAGENTS: HydroReagent[] = [
  // === ACIDS (ALK down, DIC unchanged -> vertical DOWN) ===
  {
    name: 'Nitric Acid', formula: 'HNO\u2083', mw: 63.012, meqPerMol: 1,
    slope: Infinity, radians: 3 * Math.PI / 2, color: colors.error[500], type: 'acid',
  },
  {
    name: 'Phosphoric Acid', formula: 'H\u2083PO\u2084', mw: 97.994, meqPerMol: 1,
    slope: Infinity, radians: 3 * Math.PI / 2, color: colors.accent[300], type: 'acid',
  },
  {
    name: 'Sulfuric Acid', formula: 'H\u2082SO\u2084', mw: 98.079, meqPerMol: 2,
    slope: Infinity, radians: 3 * Math.PI / 2, color: colors.error[700], type: 'acid',
  },
  {
    name: 'Hydrochloric Acid', formula: 'HCl', mw: 36.461, meqPerMol: 1,
    slope: Infinity, radians: 3 * Math.PI / 2, color: colors.accent[500], type: 'acid',
  },

  // === BASES (ALK up, DIC unchanged -> vertical UP) ===
  {
    name: 'Potassium Hydroxide', formula: 'KOH', mw: 56.1056, meqPerMol: 1,
    slope: Infinity, radians: Math.PI / 2, color: colors.success[600], type: 'base',
  },
  {
    name: 'Sodium Hydroxide', formula: 'NaOH', mw: 39.997, meqPerMol: 1,
    slope: Infinity, radians: Math.PI / 2, color: colors.success[700], type: 'base',
  },
  {
    name: 'Calcium Hydroxide', formula: 'Ca(OH)\u2082', mw: 74.093, meqPerMol: 2,
    slope: Infinity, radians: Math.PI / 2, color: colors.success[500], type: 'base',
  },
  {
    name: 'Potassium Carbonate', formula: 'K\u2082CO\u2083', mw: 138.205, meqPerMol: 2,
    slope: 2, radians: Math.atan(2), color: colors.secondary[600], type: 'base',
  },

  // === DIAGONAL (ALK and DIC increase together -> 45 deg) ===
  {
    name: 'Sodium Bicarbonate', formula: 'NaHCO\u2083', mw: 84.007, meqPerMol: 1,
    slope: 1, radians: Math.PI / 4, color: colors.info[600], type: 'other',
  },

  // === HORIZONTAL (DIC changes, ALK unchanged) ===
  {
    name: 'Add CO\u2082', formula: 'CO\u2082', mw: 44.010, meqPerMol: 0,
    slope: 0, radians: 0, color: colors.warning[600], type: 'other',
  },
  {
    name: 'De-gas CO\u2082', formula: '-CO\u2082', mw: 44.010, meqPerMol: 0,
    slope: 0, radians: Math.PI, color: colors.error[600], type: 'other',
  },
];

export const ACID_REAGENTS = HYDRO_REAGENTS.filter(r => r.type === 'acid');
export const BASE_REAGENTS = HYDRO_REAGENTS.filter(r => r.type === 'base');

/**
 * Calculate delta DIC and delta ALK for a reagent dose.
 */
export function reagentDeltas(
  reagent: HydroReagent,
  amountGrams: number,
  volumeL: number,
): { deltaDIC: number; deltaALK: number } {
  const moles = amountGrams / reagent.mw;
  const concMmolL = (moles * 1000) / volumeL;

  if (reagent.slope === 0) {
    const sign = Math.abs(reagent.radians) < 0.01 ? 1 : -1;
    return { deltaDIC: sign * concMmolL, deltaALK: 0 };
  }

  if (!isFinite(reagent.slope)) {
    const sign = reagent.radians < Math.PI ? 1 : -1;
    return { deltaDIC: 0, deltaALK: sign * reagent.meqPerMol * concMmolL };
  }

  return { deltaDIC: concMmolL, deltaALK: reagent.meqPerMol * concMmolL };
}

/**
 * Generate direction line from a starting point for a reagent.
 */
export function reagentDirectionLine(
  startDIC: number,
  startAlk: number,
  reagent: HydroReagent,
  length: number = 3,
): Array<{ CT: number; AT: number }> {
  const points: Array<{ CT: number; AT: number }> = [];
  const steps = 50;

  for (let i = 0; i <= steps; i++) {
    const t = (i / steps) * length;
    let ct: number, at: number;

    if (!isFinite(reagent.slope)) {
      ct = startDIC;
      at = reagent.radians === Math.PI / 2
        ? startAlk + t   // Base: UP
        : startAlk - t;  // Acid: DOWN
    } else if (reagent.slope === 0) {
      at = startAlk;
      ct = reagent.radians === 0
        ? startDIC + t   // Add CO2: RIGHT
        : startDIC - t;  // De-gas: LEFT
    } else {
      ct = startDIC + t;
      at = startAlk + t * reagent.slope;
    }

    points.push({
      CT: parseFloat(ct.toFixed(4)),
      AT: parseFloat(at.toFixed(4)),
    });
  }

  return points;
}
