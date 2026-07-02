/**
 * Chemical Reagent Database & Dosing Calculator
 * Ported from R CarbCalc calcAdjustment() function
 *
 * The R algorithm:
 * 1. Sort two reagents by radians (lower/higher)
 * 2. Check feasibility: waypoint angle must be between reagent angles
 * 3. Find intersection point of two reagent direction lines
 * 4. Calculate amounts for each reagent
 */

import { ReagentInfo, DosingResult, DosingRecipe, DosingVisualization, OnDemandStep, OnDemandInput } from './types.js';
import { calcPhForAlkDic, calcCo2OfDic, co2MmToMg } from './water-quality.js';

// ============================================================================
// REAGENT DATABASE
// ============================================================================

export const REAGENTS: ReagentInfo[] = [
  {
    name: 'Sodium Bicarbonate',
    formula: 'NaHCO₃',
    mw: 84.007,
    meqPerMol: 1,
    slope: 1,
    radians: Math.PI / 4,
  },
  {
    name: 'Sodium Carbonate',
    formula: 'Na₂CO₃',
    mw: 105.988,
    meqPerMol: 2,
    slope: 2,
    radians: Math.atan(2),
  },
  {
    name: 'Sodium Hydroxide',
    formula: 'NaOH',
    mw: 39.997,
    meqPerMol: 1,
    slope: Infinity,
    radians: Math.PI / 2,
  },
  {
    name: 'Calcium Carbonate',
    formula: 'CaCO₃',
    mw: 100.087,
    meqPerMol: 2,
    slope: 2,
    radians: Math.atan(2),
  },
  {
    name: 'Calcium Hydroxide',
    formula: 'Ca(OH)₂',
    mw: 74.093,
    meqPerMol: 2,
    slope: Infinity,
    radians: Math.PI / 2,
  },
  {
    name: 'Calcium Oxide',
    formula: 'CaO',
    mw: 56.077,
    meqPerMol: 2,
    slope: Infinity,
    radians: Math.PI / 2,
  },
  {
    name: 'Add CO₂',
    formula: 'CO₂',
    mw: 44.010,
    meqPerMol: 0,
    slope: 0,
    radians: 0,
  },
  {
    name: 'De-gas CO₂',
    formula: '-CO₂',
    mw: 44.010,
    meqPerMol: 0,
    slope: 0,
    radians: Math.PI,
  },
  {
    name: 'Muriatic Acid',
    formula: 'HCl',
    mw: 36.461,
    meqPerMol: 1,
    slope: Infinity,
    radians: 3 * Math.PI / 2,
  },
];

// ============================================================================
// DOSING CALCULATIONS - Ported from R calcAdjustment()
// ============================================================================

/**
 * Calculate dosing for a two-reagent combination.
 * Implements the R CarbCalc geometric intersection algorithm.
 *
 * Algorithm:
 * 1. Sort reagents by radians → lower, higher
 * 2. Calculate waypoint slope angle (initPoint → finalPoint)
 * 3. Adjust angle for quadrant (Q2/Q3 add π, Q4 add 2π)
 * 4. Check feasibility: waypoint angle must be between reagent angles
 * 5. Find intersection point (dicStar, alkStar) of two reagent lines:
 *    - Line through initPoint with slope = lowerReagent.slope
 *    - Line through finalPoint with slope = higherReagent.slope
 * 6. Reagent 1 (lower): amount from DIC change to intersection
 * 7. Reagent 2 (higher): amount from ALK deficit at intersection
 *
 * Units: DIC in mmol/L, ALK in meq/L, volume in m³, output in kg
 */
function calcTwoReagentDosing(
  initDic: number,
  initAlk: number,
  finalDic: number,
  finalAlk: number,
  volumeM3: number,
  reagent1: ReagentInfo,
  reagent2: ReagentInfo,
): DosingRecipe | null {
  const volumeL = volumeM3 * 1000;

  const deltaDic = finalDic - initDic;
  const deltaAlk = finalAlk - initAlk;

  if (Math.abs(deltaDic) < 1e-6 && Math.abs(deltaAlk) < 1e-6) return null;

  // Step 1: Sort reagents by radians
  let lower: ReagentInfo;
  let higher: ReagentInfo;
  if (reagent1.radians < reagent2.radians) {
    lower = reagent1;
    higher = reagent2;
  } else {
    lower = reagent2;
    higher = reagent1;
  }

  // Step 2: Calculate waypoint slope angle
  let wpSlopeRad: number;
  if (Math.abs(deltaDic) < 1e-10) {
    // Vertical movement
    wpSlopeRad = deltaAlk > 0 ? Math.PI / 2 : 3 * Math.PI / 2;
  } else {
    wpSlopeRad = Math.atan(deltaAlk / deltaDic);

    // Step 3: Quadrant correction (matching R code)
    if (deltaDic < 0 && deltaAlk >= 0) {
      // Q2
      wpSlopeRad += Math.PI;
    } else if (deltaDic < 0 && deltaAlk < 0) {
      // Q3
      wpSlopeRad += Math.PI;
    } else if (deltaDic >= 0 && deltaAlk < 0) {
      // Q4
      wpSlopeRad += 2 * Math.PI;
    }
  }

  // Step 4: Feasibility check (from R code)
  let feasible = false;
  if (higher.radians - lower.radians < Math.PI) {
    feasible = wpSlopeRad >= lower.radians && wpSlopeRad <= higher.radians;
  } else {
    feasible = wpSlopeRad >= higher.radians || wpSlopeRad <= lower.radians;
  }

  if (!feasible) return null;

  // Step 5: Find intersection point (dicStar, alkStar)
  let dicStar: number;
  let alkStar: number;

  if (higher.slope > 2 || !isFinite(higher.slope)) {
    // Higher reagent is vertical (NaOH, Ca(OH)₂, CaO, HCl)
    // Line through finalPoint is vertical → dicStar = finalDic
    dicStar = finalDic;
    alkStar = lower.slope * (finalDic - initDic) + initAlk;
  } else if (lower.slope === 0) {
    // Lower reagent is horizontal (CO₂)
    // Line through initPoint is horizontal → alkStar = initAlk
    // Higher reagent line through finalPoint: ALK = higher.slope * (DIC - finalDic) + finalAlk
    // Set alkStar = initAlk → initAlk = higher.slope * (dicStar - finalDic) + finalAlk
    dicStar = (initAlk - finalAlk) / higher.slope + finalDic;
    alkStar = initAlk;
  } else {
    // Both have finite, non-zero slopes: general intersection
    // Line 1: ALK = lower.slope * (DIC - initDic) + initAlk
    // Line 2: ALK = higher.slope * (DIC - finalDic) + finalAlk
    // Solve: lower.slope * DIC - lower.slope * initDic + initAlk
    //      = higher.slope * DIC - higher.slope * finalDic + finalAlk
    const slopeDiff = higher.slope - lower.slope;
    if (Math.abs(slopeDiff) < 1e-12) return null; // Same slope = parallel lines
    dicStar = (initAlk - lower.slope * initDic - finalAlk + higher.slope * finalDic) / slopeDiff;
    alkStar = lower.slope * (dicStar - initDic) + initAlk;
  }

  // Step 6: Reagent 1 (lower) - amount from DIC change
  // Units: |mmol/L| * (g/mol) * L → need to convert properly
  // amount_mmol = |dicStar - initDic| * volumeL
  // amount_grams = amount_mmol * mw / 1000
  let chemAdj1Grams: number;

  if (lower.slope === 0 || !isFinite(lower.slope)) {
    // Horizontal or vertical reagent
    if (lower.slope === 0) {
      // CO₂: amount based on DIC change
      chemAdj1Grams = Math.abs(dicStar - initDic) * lower.mw * volumeL / 1000;
    } else {
      // Vertical: amount based on ALK change
      chemAdj1Grams = Math.abs(alkStar - initAlk) * (lower.mw / lower.meqPerMol) * volumeL / 1000;
    }
  } else {
    // Diagonal: 1 mol reagent → 1 mmol DIC, amount based on DIC change
    chemAdj1Grams = Math.abs(dicStar - initDic) * lower.mw * volumeL / 1000;
  }

  // Step 7: Reagent 2 (higher) - amount from ALK deficit
  const alkDeficit = Math.abs(finalAlk - alkStar);
  let chemAdj2Grams: number;

  if (higher.slope === 0) {
    // CO₂/De-gas: amount based on DIC change
    chemAdj2Grams = Math.abs(finalDic - dicStar) * higher.mw * volumeL / 1000;
  } else {
    // For all others: alkDeficit * (mw / meqPerMol) * vol
    chemAdj2Grams = alkDeficit * (higher.mw / higher.meqPerMol) * volumeL / 1000;
  }

  // Sanity check
  if (chemAdj1Grams < 0 || chemAdj2Grams < 0) return null;
  if (!isFinite(chemAdj1Grams) || !isFinite(chemAdj2Grams)) return null;

  // Build result
  const step1: DosingResult = {
    reagentName: lower.name,
    formula: lower.formula,
    amountGrams: chemAdj1Grams,
    amountKg: chemAdj1Grams / 1000,
    deltaAlk: alkStar - initAlk,
    deltaDIC: dicStar - initDic,
  };

  const step2: DosingResult = {
    reagentName: higher.name,
    formula: higher.formula,
    amountGrams: chemAdj2Grams,
    amountKg: chemAdj2Grams / 1000,
    deltaAlk: finalAlk - alkStar,
    deltaDIC: finalDic - dicStar,
  };

  // Filter out zero-amount steps
  const steps: DosingResult[] = [];
  if (chemAdj1Grams > 0.001) steps.push(step1);
  if (chemAdj2Grams > 0.001) steps.push(step2);
  if (steps.length === 0) return null;

  const firstStep = steps[0];
  if (steps.length === 1 && firstStep) {
    return {
      description: `${firstStep.formula} only`,
      steps,
    };
  }

  return {
    description: `${step1.formula} + ${step2.formula}`,
    steps,
  };
}

/**
 * A recipe is counter-productive when its two reagents push alkalinity in
 * OPPOSITE directions — one adds it, the other removes it — so the recipe
 * overshoots then corrects (e.g. NaHCO₃ to raise ALK, then HCl to trim the
 * excess). Such recipes are geometrically feasible but waste reagent, and the
 * reference desktop tool never surfaces them. CO₂ is ALK-neutral (deltaAlk≈0)
 * so base+CO₂ / acid+CO₂ recipes are never flagged.
 */
function isCounterProductiveRecipe(recipe: DosingRecipe): boolean {
  const hasAlkGain = recipe.steps.some(s => s.deltaAlk > 1e-9);
  const hasAlkLoss = recipe.steps.some(s => s.deltaAlk < -1e-9);
  return hasAlkGain && hasAlkLoss;
}

/**
 * Rank key: sum of each reagent's position in the curated REAGENTS priority
 * list (NaHCO₃ first as the default aquaculture buffer). Lower = more practical,
 * so practical recipes survive the cap instead of being displaced by iteration
 * order.
 */
function recipePriority(recipe: DosingRecipe): number {
  return recipe.steps.reduce((sum, s) => {
    const idx = REAGENTS.findIndex(r => r.name === s.reagentName);
    return sum + (idx < 0 ? 99 : idx);
  }, 0);
}

/**
 * Calculate dosing recipes to move from current to target operating point.
 * Enumerates all pairs of selected reagents, drops counter-productive
 * (overshoot-then-correct) combinations, ranks the rest by reagent
 * practicality, then caps the list.
 *
 * @param currentDIC - Current DIC in mmol/L
 * @param currentAlk - Current alkalinity in meq/L
 * @param targetDIC - Target DIC in mmol/L
 * @param targetAlk - Target alkalinity in meq/L
 * @param volumeM3 - System volume in m³
 * @param selectedReagents - List of selected reagent names
 * @returns Array of dosing recipes (max 6), practical recipes first
 */
export function calculateDosingRecipes(
  currentDIC: number,
  currentAlk: number,
  targetDIC: number,
  targetAlk: number,
  volumeM3: number,
  selectedReagents: string[]
): DosingRecipe[] {
  const deltaAlk = targetAlk - currentAlk;
  const deltaDIC = targetDIC - currentDIC;

  if (Math.abs(deltaAlk) < 0.001 && Math.abs(deltaDIC) < 0.001) {
    return []; // Already at target
  }

  const selected = REAGENTS.filter(r => selectedReagents.includes(r.name));
  if (selected.length === 0) return [];

  // Enumerate every feasible reagent pair (no early cap), dedup identical recipes
  const seen = new Set<string>();
  const all: DosingRecipe[] = [];
  for (let i = 0; i < selected.length; i++) {
    for (let j = i + 1; j < selected.length; j++) {
      const r1 = selected[i];
      const r2 = selected[j];
      if (!r1 || !r2) {
        continue;
      }

      const recipe = calcTwoReagentDosing(
        currentDIC, currentAlk,
        targetDIC, targetAlk,
        volumeM3,
        r1, r2,
      );
      if (!recipe) continue;

      const recipeKey = recipe.steps.map(s => s.formula).sort().join('+');
      if (seen.has(recipeKey)) continue;
      seen.add(recipeKey);
      all.push(recipe);
    }
  }

  // Curate: drop counter-productive recipes so they cannot displace practical
  // ones under the cap — unless they are the ONLY feasible option (then keep
  // them so the operator still gets an answer). Then rank by practicality.
  const productive = all.filter(r => !isCounterProductiveRecipe(r));
  const ranked = (productive.length > 0 ? productive : all)
    .slice()
    .sort((a, b) => recipePriority(a) - recipePriority(b));

  return ranked.slice(0, 6); // Max 6 recipes, practical first
}

/**
 * Calculate reagent direction line on Deffeyes diagram.
 * Line goes from the current point in the reagent's addition direction only.
 */
export function reagentDirectionLine(
  startDIC: number,
  startAlk: number,
  reagent: ReagentInfo,
  length = 3
): Array<{ CT: number; AT: number }> {
  const points: Array<{ CT: number; AT: number }> = [];
  const steps = 50;

  for (let i = 0; i <= steps; i++) {
    const t = (i / steps) * length;
    let ct: number, at: number;

    if (!isFinite(reagent.slope)) {
      ct = startDIC;
      if (reagent.radians === Math.PI / 2) {
        at = startAlk + t; // Base: UP
      } else {
        at = startAlk - t; // Acid (3π/2): DOWN
      }
    } else if (reagent.slope === 0) {
      at = startAlk;
      if (reagent.radians === 0) {
        ct = startDIC + t; // Add CO₂: RIGHT
      } else {
        ct = startDIC - t; // De-gas CO₂ (π): LEFT
      }
    } else {
      // Diagonal
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

// Reagent color palette for visualization
const REAGENT_COLORS: Record<string, string> = {
  'Sodium Bicarbonate': '#2563eb',
  'Sodium Carbonate': '#7c3aed',
  'Sodium Hydroxide': '#059669',
  'Calcium Carbonate': '#0891b2',
  'Calcium Hydroxide': '#65a30d',
  'Calcium Oxide': '#ca8a04',
  'Add CO₂': '#ea580c',
  'De-gas CO₂': '#dc2626',
  'Muriatic Acid': '#be185d',
};

/**
 * Calculate dosing visualization for Deffeyes diagram.
 * Shows two reagent direction lines from current point,
 * the intermediate intersection point, and the two-step path to target.
 *
 * Returns null if the combination is not feasible.
 */
export function calcDosingVisualization(
  currentDIC: number,
  currentAlk: number,
  targetDIC: number,
  targetAlk: number,
  reagent1Name: string,
  reagent2Name: string,
): DosingVisualization | null {
  const r1 = REAGENTS.find(r => r.name === reagent1Name);
  const r2 = REAGENTS.find(r => r.name === reagent2Name);
  if (!r1 || !r2) return null;

  const deltaDic = targetDIC - currentDIC;
  const deltaAlk = targetAlk - currentAlk;
  if (Math.abs(deltaDic) < 1e-6 && Math.abs(deltaAlk) < 1e-6) return null;

  // Sort by radians
  let lower: ReagentInfo, higher: ReagentInfo;
  if (r1.radians < r2.radians) { lower = r1; higher = r2; }
  else { lower = r2; higher = r1; }

  // Feasibility check (same as calcTwoReagentDosing)
  let wpSlopeRad: number;
  if (Math.abs(deltaDic) < 1e-10) {
    wpSlopeRad = deltaAlk > 0 ? Math.PI / 2 : 3 * Math.PI / 2;
  } else {
    wpSlopeRad = Math.atan(deltaAlk / deltaDic);
    if (deltaDic < 0 && deltaAlk >= 0) wpSlopeRad += Math.PI;
    else if (deltaDic < 0 && deltaAlk < 0) wpSlopeRad += Math.PI;
    else if (deltaDic >= 0 && deltaAlk < 0) wpSlopeRad += 2 * Math.PI;
  }

  let feasible = false;
  if (higher.radians - lower.radians < Math.PI) {
    feasible = wpSlopeRad >= lower.radians && wpSlopeRad <= higher.radians;
  } else {
    feasible = wpSlopeRad >= higher.radians || wpSlopeRad <= lower.radians;
  }
  if (!feasible) return null;

  // Find intersection point (same logic as calcTwoReagentDosing)
  let dicStar: number, alkStar: number;
  if (higher.slope > 2 || !isFinite(higher.slope)) {
    dicStar = targetDIC;
    alkStar = lower.slope * (targetDIC - currentDIC) + currentAlk;
  } else if (lower.slope === 0) {
    dicStar = (currentAlk - targetAlk) / higher.slope + targetDIC;
    alkStar = currentAlk;
  } else {
    const slopeDiff = higher.slope - lower.slope;
    if (Math.abs(slopeDiff) < 1e-12) return null;
    dicStar = (currentAlk - lower.slope * currentDIC - targetAlk + higher.slope * targetDIC) / slopeDiff;
    alkStar = lower.slope * (dicStar - currentDIC) + currentAlk;
  }

  if (!isFinite(dicStar) || !isFinite(alkStar)) return null;

  // Build direction lines (from current point, in both reagent directions)
  const line1 = reagentDirectionLine(currentDIC, currentAlk, lower, 4);
  const line2 = reagentDirectionLine(currentDIC, currentAlk, higher, 4);

  // Build two-step path
  const step1Path = [
    { CT: currentDIC, AT: currentAlk },
    { CT: dicStar, AT: alkStar },
  ];
  const step2Path = [
    { CT: dicStar, AT: alkStar },
    { CT: targetDIC, AT: targetAlk },
  ];

  return {
    reagentLine1: { points: line1, label: lower.formula, color: REAGENT_COLORS[lower.name] || '#6b7280' },
    reagentLine2: { points: line2, label: higher.formula, color: REAGENT_COLORS[higher.name] || '#6b7280' },
    step1Path,
    step2Path,
    intermediatePoint: { DIC: dicStar, ALK: alkStar },
    step1Label: `Step 1: ${lower.formula}`,
    step2Label: `Step 2: ${higher.formula}`,
  };
}

// ============================================================================
// FORWARD (ON-DEMAND) DOSING CALCULATOR
// ============================================================================

/**
 * Compute delta_DIC (mmol/L) and delta_ALK (meq/L) for a given reagent amount.
 *
 * Direction rules (from reagent radians / slope):
 *   - slope === 0, radians === 0     → Add CO₂:   +DIC, 0 ALK
 *   - slope === 0, radians === π     → De-gas CO₂: -DIC, 0 ALK
 *   - slope === Inf, radians === π/2 → Base (NaOH etc.): 0 DIC, +ALK
 *   - slope === Inf, radians === 3π/2→ Acid (HCl): 0 DIC, -ALK
 *   - finite slope                   → Diagonal: +DIC, +slope*DIC
 */
function reagentDeltas(
  reagent: ReagentInfo,
  amountGrams: number,
  volumeL: number
): { deltaDIC: number; deltaALK: number } {
  const moles = amountGrams / reagent.mw;
  const concMmolL = (moles * 1000) / volumeL;  // mmol/L

  if (reagent.slope === 0) {
    // Horizontal: CO₂ add or degas
    const sign = Math.abs(reagent.radians) < 0.01 ? 1 : -1;  // radians≈0 → add, radians≈π → degas
    return { deltaDIC: sign * concMmolL, deltaALK: 0 };
  }

  if (!isFinite(reagent.slope)) {
    // Vertical: base or acid
    const sign = reagent.radians < Math.PI ? 1 : -1;  // π/2 → base (up), 3π/2 → acid (down)
    return { deltaDIC: 0, deltaALK: sign * reagent.meqPerMol * concMmolL };
  }

  // Diagonal reagent: 1 mol reagent → 1 mmol DIC + meqPerMol meq ALK
  return { deltaDIC: concMmolL, deltaALK: reagent.meqPerMol * concMmolL };
}

/**
 * Forward dosing calculator: given current water state and a sequential list
 * of chemical additions, compute the resulting (DIC, ALK, pH, CO₂) after each step.
 *
 * @param current - Current water state (DIC mmol/L, ALK meq/L, tempC, salinity)
 * @param volumeM3 - System volume in m³
 * @param steps - List of {reagentKey, amountGrams} to apply in order
 * @returns Array of OnDemandStep, starting with "Start" and ending with "Final"
 */
export function calcForwardDosing(
  current: { dic: number; alk: number; tempC: number; salinity: number },
  volumeM3: number,
  steps: OnDemandInput[]
): OnDemandStep[] {
  const volumeL = volumeM3 * 1000;

  const startPH = calcPhForAlkDic(current.alk, current.dic, current.tempC, current.salinity);
  const startCO2mm = calcCo2OfDic(current.dic, startPH, current.tempC, current.salinity);

  const result: OnDemandStep[] = [
    {
      label: 'Start',
      dic: current.dic,
      alk: current.alk,
      ph: startPH,
      co2: co2MmToMg(startCO2mm),
      amountKg: 0,
    },
  ];

  let dic = current.dic;
  let alk = current.alk;

  for (let i = 0; i < steps.length; i++) {
    const input = steps[i];
    if (!input) {
      continue;
    }

    const { reagentKey, amountGrams } = input;
    if (amountGrams <= 0) continue;

    const reagent = REAGENTS.find(r => r.name === reagentKey);
    if (!reagent) continue;

    const { deltaDIC, deltaALK } = reagentDeltas(reagent, amountGrams, volumeL);
    dic = dic + deltaDIC;
    alk = alk + deltaALK;

    // Clamp to physically valid range
    dic = Math.max(0, dic);
    alk = Math.max(0, alk);

    const ph = calcPhForAlkDic(alk, dic, current.tempC, current.salinity);
    const co2mm = calcCo2OfDic(dic, ph, current.tempC, current.salinity);

    const isLast = i === steps.length - 1;
    result.push({
      label: isLast ? `Final (${reagent.formula})` : `+ ${reagent.formula} ${amountGrams.toFixed(1)}g`,
      dic,
      alk,
      ph,
      co2: co2MmToMg(co2mm),
      amountKg: amountGrams / 1000,
    });
  }

  // Rename last step as "Final" if more than one reagent step
  if (result.length > 2) {
    const finalStep = result[result.length - 1];
    if (finalStep) {
      finalStep.label = 'Final';
    }
  }

  return result;
}
