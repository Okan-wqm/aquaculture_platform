import { describe, expect, it } from 'vitest';

import {
  alkMgToMeq,
  criticalPHforH2SPHChartDomain,
  criticalPHforNH3PHChartDomain,
  generateDeffeyesChartData,
  generateH2SToxicZone,
} from '../index.js';
import type { ToxicLimits } from '../index.js';

const TOXIC_H2S_LIMITS: ToxicLimits = {
  tan: 0.5,
  unIonizedNH3: 0.0125,
  co2Toxic: 40,
  h2sMeasuredUgL: 15,
  h2sLimitUgL: 25,
  h2sMeasuredAtPH: 7,
};

describe('generateDeffeyesChartData — H₂S toxic zone (legacy ALK/DIC chart)', () => {
  it('emits an h2sToxicZone next to the NH₃ and CO₂ zones', () => {
    const data = generateDeffeyesChartData(
      { tempC: 12, pH: 7, salinity: 1, alkalinity: alkMgToMeq(80) },
      null,
      TOXIC_H2S_LIMITS,
      alkMgToMeq(50),
      alkMgToMeq(100),
      400
    );

    expect(data.nh3ToxicZone).not.toBeNull();
    expect(data.co2ToxicZone).not.toBeNull();
    expect(data.h2sToxicZone).not.toBeNull();
    expect(data.h2sToxicZone?.points.length ?? 0).toBeGreaterThanOrEqual(2);
    expect(data.h2sToxicZone?.label).toMatch(/H₂S/);
  });
});

describe('generateH2SToxicZone', () => {
  it('traces a finite boundary when H₂S can exceed the toxic limit', () => {
    const zone = generateH2SToxicZone(12, 1, 15, 7, 25, 8);
    expect(zone).not.toBeNull();
    for (const point of zone?.points ?? []) {
      expect(Number.isFinite(point.CT)).toBe(true);
      expect(Number.isFinite(point.AT)).toBe(true);
    }
  });

  it('returns null when the sample can never reach the limit (chart fully safe)', () => {
    // Tiny measured H₂S with a very high limit → no reachable critical pH.
    expect(generateH2SToxicZone(12, 1, 1, 7, 1000, 8)).toBeNull();
  });
});

describe('critical-pH status helpers survive the DIC/pH removal', () => {
  it('criticalPHforH2SPHChartDomain returns a finite pH for toxic inputs', () => {
    expect(Number.isFinite(criticalPHforH2SPHChartDomain(15, 7, 25, 12, 1))).toBe(true);
  });

  it('criticalPHforNH3PHChartDomain returns a finite pH for toxic inputs', () => {
    expect(Number.isFinite(criticalPHforNH3PHChartDomain(0.5, 0.0125, 12, 1))).toBe(true);
  });
});
