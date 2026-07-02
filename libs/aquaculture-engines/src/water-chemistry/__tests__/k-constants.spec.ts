import { describe, expect, it } from 'vitest';

import { co2Level } from '../co2-calc.js';
import {
  getK1,
  getK2,
  getKH2S,
  totToFree,
  fractionH2S,
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

/**
 * H₂S first dissociation constant (Millero KH2S, Total scale internally).
 *
 * These guards pin the H₂S toxic-zone behavior on the Deffeyes chart. `getKH2S`
 * is used consistently on the FREE scale (fractionH2S converts pH NBS→Free and
 * KH2S Total→Free), which is the physically correct scale — matched independently
 * by the reference desktop app's empirical pKa(T,S) fit ON THE FREE SCALE.
 *
 * Independent anchors: general chemistry tables give H₂S pKa1 ≈ 7.0–7.1
 * (scienceready.com.au Ka1=8.9e-8 → 7.05); freshwater is where all pH scales
 * converge, so getKH2S(25,0) must land there. Salinity lowers the apparent pK1
 * (ionic strength stabilises HS⁻) — a real effect the fit must reproduce.
 */
describe('H₂S dissociation constant — literature anchor + salinity behavior', () => {
  // getKH2S is Total scale; at S=0 all pH scales coincide → thermodynamic pKa1
  const pKaFreshwater = -Math.log10(getKH2S(25, 0));
  // Apparent pK on the FREE scale (the scale the engine actually uses)
  const freePk = (tempC: number, S: number): number =>
    -Math.log10(totToFree(getKH2S(tempC, S), tempC, S));

  it('reproduces the freshwater H₂S pKa1 ≈ 7.0 (lit. 6.9–7.1)', () => {
    expect(pKaFreshwater).toBeGreaterThan(6.85);
    expect(pKaFreshwater).toBeLessThan(7.15);
  });

  it('salinity LOWERS the apparent (free-scale) pK1 by a physical ~0.3–0.4', () => {
    const drop = freePk(25, 0) - freePk(25, 35);
    expect(drop).toBeGreaterThan(0.25);
    expect(drop).toBeLessThan(0.5);
  });

  it('H₂S fraction rises as pH falls (toxic at low pH, opposite of NH₃)', () => {
    expect(fractionH2S(6, 25, 0)).toBeGreaterThan(fractionH2S(8, 25, 0));
  });

  it('H₂S fraction ≈ 0.5 at the freshwater pKa1 (self-consistent scale use)', () => {
    // At S=0 NBS==Free, so feeding the pKa as pH must split ~50/50
    expect(fractionH2S(pKaFreshwater, 25, 0)).toBeCloseTo(0.5, 2);
  });
});
