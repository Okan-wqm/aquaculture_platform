import { describe, expect, it } from 'vitest';

import { co2Level } from '../co2-calc.js';
import {
  getK1,
  getK2,
  phNbsToFree,
  alphaTwo,
  calcDicOfAlk,
} from '../index.js';

/**
 * Carbonic-acid dissociation constants K1/K2 (Millero 2010 estuarine fit).
 *
 * getK1/getK2 return K on the SWS scale, so pK = -log10(K).
 *
 * These anchors pin the fit to the published thermodynamic values across the
 * FULL freshwater→seawater salinity range. A prior seawater-only fit passed at
 * S≈35 but was ~0.23 (pK1) / ~0.9 (pK2) low at S=0 — this suite is the guard
 * that keeps the freshwater/brackish end correct (tilapia, trout, hydroponics).
 */
describe('carbonic-acid K1/K2 — literature anchors (SWS pK)', () => {
  const pK1 = (tempC: number, S: number): number => -Math.log10(getK1(tempC, S));
  const pK2 = (tempC: number, S: number): number => -Math.log10(getK2(tempC, S));

  it('reproduces freshwater (S=0, 25°C) pure-water constants', () => {
    // Harned & Davis / Harned & Scholes: pK1≈6.352, pK2≈10.329 at 25°C, S=0
    expect(pK1(25, 0)).toBeCloseTo(6.352, 2); // |Δ| < 0.005
    expect(pK2(25, 0)).toBeCloseTo(10.329, 2);
  });

  it('reproduces seawater (S=35, 25°C) SWS constants', () => {
    expect(pK1(25, 35)).toBeCloseTo(5.840, 2);
    expect(pK2(25, 35)).toBeCloseTo(8.964, 2);
  });

  it('REGRESSION GUARD: brackish pK2 must stay near the estuarine fit', () => {
    // The old seawater-only fit gave pK2(25,0.5)=9.41 (K2 ~4× too high).
    // The correct estuarine fit gives ≈10.008. This threshold fails loudly if
    // a linear-in-S seawater fit is ever reintroduced.
    expect(pK2(25, 0.5)).toBeGreaterThan(9.9);
    expect(pK2(25, 0.5)).toBeCloseTo(10.008, 2);
    // pK2 must fall monotonically with rising salinity (FW > brackish > SW)
    expect(pK2(25, 0)).toBeGreaterThan(pK2(25, 5));
    expect(pK2(25, 5)).toBeGreaterThan(pK2(25, 35));
  });
});

/**
 * End-to-end freshwater speciation goldens.
 *
 * Values are the reference desktop-app (Python √S-Millero) outputs at a
 * freshwater point (30°C, S=0.5). Before the fix the engine was off by ~78%
 * on α₂ and ~35% on CO₂ here. Tight tolerances keep the Deffeyes chart honest.
 */
describe('freshwater carbonate speciation matches the reference SSoT', () => {
  it('α₂ (CO₃²⁻ fraction) at 30°C, S=0.5, pH 6.5', () => {
    const pHfree = phNbsToFree(6.5, 30, 0.5);
    expect(alphaTwo(pHfree, 30, 0.5)).toBeCloseTo(0.00019862, 7);
  });

  it('DIC from ALK at 30°C, S=0.5, pH 6.5, ALK 4 meq/L', () => {
    expect(calcDicOfAlk(4.0, 6.5, 30, 0.5)).toBeCloseTo(6.33877, 3);
  });

  it('CO₂ (mg/L) at 30°C, S=0.5, pH 8.2, ALK 4 meq/L', () => {
    expect(co2Level(4.0, 8.2, 30, 0.5)).toBeCloseTo(1.99112, 3);
  });
});
