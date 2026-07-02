import { describe, expect, it } from 'vitest';

import { calculateDosingRecipes, REAGENTS } from '../index.js';

const ALL = REAGENTS.map(r => r.name);

/**
 * Dosing-recipe curation.
 *
 * The per-recipe dosing MATH matches the reference desktop tool exactly (see the
 * numeric goldens below). The bug this suite guards is enumeration/curation: a
 * hard slice(0,6) with no ranking let counter-productive recipes (add a base,
 * then acidify away the excess) consume slots and displace practical lime
 * recipes (CaO, Ca(OH)₂). Recipes are now curated (counter-productive dropped)
 * and ranked before the cap.
 */
describe('calculateDosingRecipes — curation & ranking', () => {
  // Raise both DIC and ALK: current (2, 2) → target (3, 2.5). vol = 1 m³.
  const recs = calculateDosingRecipes(2.0, 2.0, 3.0, 2.5, 1.0, ALL);

  it('never surfaces counter-productive base+acid recipes when practical ones exist', () => {
    // For a raise-ALK move, HCl only appears paired with a base (overshoot-then-trim)
    expect(recs.every(r => r.steps.every(s => s.formula !== 'HCl'))).toBe(true);
  });

  it('keeps the practical lime recipes that the old cap dropped', () => {
    const formulas = recs.flatMap(r => r.steps.map(s => s.formula));
    expect(formulas).toContain('CaO');
    expect(formulas).toContain('Ca(OH)₂');
    expect(recs.length).toBeLessThanOrEqual(6);
  });

  it('ranks the default aquaculture buffer (NaHCO₃ + CO₂) first', () => {
    expect(recs[0]?.steps.some(s => s.formula === 'NaHCO₃')).toBe(true);
  });

  it('per-recipe MATH is unchanged (matches reference goldens)', () => {
    const nahco3 = recs.find(r => r.steps.some(s => s.formula === 'NaHCO₃'));
    const base = nahco3?.steps.find(s => s.formula === 'NaHCO₃');
    const co2 = nahco3?.steps.find(s => s.formula === 'CO₂');
    expect(base?.amountGrams).toBeCloseTo(42.004, 2);
    expect(co2?.amountGrams).toBeCloseTo(22.005, 2);
  });

  it('falls back to a counter-productive recipe only when it is the sole option', () => {
    // Only a base + acid selected for a raise-both move: the single feasible
    // recipe is counter-productive, but the operator must still get an answer.
    const only = calculateDosingRecipes(2.0, 2.0, 3.0, 2.5, 1.0, [
      'Sodium Bicarbonate',
      'Muriatic Acid',
    ]);
    expect(only.length).toBeGreaterThanOrEqual(1);
  });

  it('returns nothing when already at target', () => {
    expect(calculateDosingRecipes(2.0, 2.0, 2.0, 2.0, 1.0, ALL)).toEqual([]);
  });
});
