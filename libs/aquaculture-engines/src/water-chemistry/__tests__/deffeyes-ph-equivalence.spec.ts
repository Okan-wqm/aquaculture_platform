import { describe, expect, it } from 'vitest';

import {
  alkMgToMeq,
  calcAlkOfDicPh,
  calcCo2OfDic,
  calcForwardDosing,
  calcH2S,
  calcPhForCritCO2,
  calcPhForAlkDic,
  calcTotalSulfide,
  DEFFEYES_CHART_MAX_DIC,
  DEFFEYES_CHART_PH_DOMAIN,
  DEFFEYES_LEGACY_PH_DOMAIN,
  DEFFEYES_SOLVER_PH_DOMAIN,
  criticalPHforH2S,
  criticalPHforH2SInPHRange,
  criticalPHforH2SPHChartDomain,
  criticalPHforNH3InPHRange,
  criticalPHforNH3PHChartDomain,
  fractionH2S,
  fractionNH3,
  generateDeffeyesChartData,
  generateDeffeyesPHChartData,
  projectAlkDicLineSegmentsToDicPh,
  projectAlkDicLineToDicPh,
  projectAlkDicPointToDicPh,
  REAGENTS,
  reagentDirectionLine,
  sampleAlkDicSegmentSegmentsToDicPh,
} from '../index.js';

const fixture = {
  tempC: 12,
  pH: 7,
  salinity: 1,
  alkalinity: alkMgToMeq(80),
  targetpH: 7.5,
  targetAlkalinity: alkMgToMeq(100),
  alkMin: alkMgToMeq(50),
  alkMax: alkMgToMeq(100),
  caMgL: 400,
  tan: 0.5,
  unIonizedNH3: 0.0125,
  co2Toxic: 40,
  h2sMeasuredUgL: 15,
  h2sLimitUgL: 25,
};

type DeffeyesChartResult = ReturnType<typeof generateDeffeyesChartData>;
type DeffeyesPHChartResult = ReturnType<typeof generateDeffeyesPHChartData>;

function generatePair(): { legacy: DeffeyesChartResult; ph: DeffeyesPHChartResult } {
  const params = {
    tempC: fixture.tempC,
    pH: fixture.pH,
    salinity: fixture.salinity,
    alkalinity: fixture.alkalinity,
  };
  const target = {
    targetpH: fixture.targetpH,
    targetAlkalinity: fixture.targetAlkalinity,
  };

  const legacy = generateDeffeyesChartData(
    params,
    target,
    {
      tan: fixture.tan,
      unIonizedNH3: fixture.unIonizedNH3,
      co2Toxic: fixture.co2Toxic,
      h2s: 0,
    },
    fixture.alkMin,
    fixture.alkMax,
    fixture.caMgL
  );

  const ph = generateDeffeyesPHChartData(
    params,
    target,
    {
      tanMgL: fixture.tan,
      unIonizedNH3MgL: fixture.unIonizedNH3,
      co2ToxicMgL: fixture.co2Toxic,
      h2sMeasuredUgL: fixture.h2sMeasuredUgL,
      h2sLimitUgL: fixture.h2sLimitUgL,
      currentPH: fixture.pH,
    },
    fixture.alkMin,
    fixture.alkMax,
    fixture.caMgL
  );

  return { legacy, ph };
}

function requireValue<T>(value: T | null | undefined, label: string): T {
  expect(value).toBeDefined();
  if (value == null) {
    throw new Error(`${label} should be defined`);
  }
  return value;
}

function requireLineEndpoints<T>(values: readonly T[], label: string): { first: T; last: T } {
  expect(values.length).toBeGreaterThan(1);
  const first = values[0];
  const last = values.at(-1);
  if (first == null || last == null) {
    throw new Error(`${label} should contain endpoints`);
  }
  return { first, last };
}

function generatePHData(overrides: Partial<typeof fixture> = {}): DeffeyesPHChartResult {
  const f = { ...fixture, ...overrides };
  return generateDeffeyesPHChartData(
    { tempC: f.tempC, pH: f.pH, salinity: f.salinity, alkalinity: f.alkalinity },
    { targetpH: f.targetpH, targetAlkalinity: f.targetAlkalinity },
    {
      tanMgL: f.tan,
      unIonizedNH3MgL: f.unIonizedNH3,
      co2ToxicMgL: f.co2Toxic,
      h2sMeasuredUgL: f.h2sMeasuredUgL,
      h2sLimitUgL: f.h2sLimitUgL,
      currentPH: f.pH,
    },
    f.alkMin,
    f.alkMax,
    f.caMgL
  );
}

function h2sMeasuredForCritical(targetPH: number, limit = fixture.h2sLimitUgL): number {
  return limit * fractionH2S(fixture.pH, fixture.tempC, fixture.salinity)
    / fractionH2S(targetPH, fixture.tempC, fixture.salinity);
}

describe('DIC/pH Deffeyes projection', () => {
  it('preserves the old Deffeyes current and target chemistry mathematically', () => {
    const { legacy, ph } = generatePair();

    expect(ph.currentPoint.CT).toBeCloseTo(legacy.currentPoint.DIC, 4);
    expect(ph.currentPoint.AT).toBeCloseTo(legacy.currentPoint.ALK, 4);
    expect(ph.currentPoint.pH).toBeCloseTo(fixture.pH, 4);
    expect(calcAlkOfDicPh(ph.currentPoint.CT, ph.currentPoint.pH, fixture.tempC, fixture.salinity))
      .toBeCloseTo(legacy.currentPoint.ALK, 3);

    expect(ph.targetPoint).not.toBeNull();
    expect(legacy.targetPoint).not.toBeNull();
    expect(ph.targetPoint?.CT).toBeCloseTo(legacy.targetPoint?.DIC ?? NaN, 4);
    expect(ph.targetPoint?.AT).toBeCloseTo(legacy.targetPoint?.ALK ?? NaN, 4);
    expect(ph.targetPoint?.pH).toBeCloseTo(fixture.targetpH, 4);
    expect(calcAlkOfDicPh(ph.targetPoint?.CT ?? NaN, ph.targetPoint?.pH ?? NaN, fixture.tempC, fixture.salinity))
      .toBeCloseTo(legacy.targetPoint?.ALK ?? NaN, 3);
  });

  it('round-trips arbitrary ALK/DIC points back to the same alkalinity', () => {
    const { legacy } = generatePair();
    const sourcePoints = [
      legacy.currentPoint,
      legacy.targetPoint,
      { DIC: 0.75, ALK: fixture.alkMin },
      { DIC: 2.5, ALK: fixture.alkMax },
    ].filter((point): point is { DIC: number; ALK: number } => point != null);

    for (const point of sourcePoints) {
      const projected = projectAlkDicPointToDicPh(
        { CT: point.DIC, AT: point.ALK },
        fixture.tempC,
        fixture.salinity
      );
      expect(projected).not.toBeNull();
      expect(calcAlkOfDicPh(projected?.CT ?? NaN, projected?.pH ?? NaN, fixture.tempC, fixture.salinity))
        .toBeCloseTo(point.ALK, 3);
    }
  });

  it('projects legacy pH isolines to the same pH in the new chart space', () => {
    const { legacy } = generatePair();
    const legacyPHLine = legacy.isolines.find(line => line.pH === 7.5);
    expect(legacyPHLine).toBeDefined();

    const projected = projectAlkDicLineToDicPh(
      legacyPHLine?.points ?? [],
      fixture.tempC,
      fixture.salinity
    );

    expect(projected.length).toBeGreaterThan(20);
    for (const point of projected) {
      expect(point.pH).toBeCloseTo(7.5, 2);
    }
  });

  it('keeps pH 12.5 as an explicit reference line', () => {
    const { ph } = generatePair();

    expect(ph.domain.maxDIC).toBe(DEFFEYES_CHART_MAX_DIC);
    expect(ph.domain.minPH).toBe(DEFFEYES_CHART_PH_DOMAIN.minPH);
    expect(ph.domain.maxPH).toBe(DEFFEYES_CHART_PH_DOMAIN.maxPH);
    expect(ph.pHReferences.some(line => line.value === 12.5 && line.points.length === 2)).toBe(true);
    expect(ph.pHReferences.some(line => line.value === DEFFEYES_CHART_PH_DOMAIN.minPH)).toBe(true);
    expect(ph.pHReferences.every(line =>
      (line.value ?? NaN) >= DEFFEYES_CHART_PH_DOMAIN.minPH &&
      (line.value ?? NaN) <= DEFFEYES_CHART_PH_DOMAIN.maxPH
    )).toBe(true);
  });

  it('exports the chart, legacy, and solver pH domains as SSOT constants', () => {
    expect(DEFFEYES_CHART_PH_DOMAIN).toEqual({ minPH: 4, maxPH: 12.5 });
    expect(DEFFEYES_LEGACY_PH_DOMAIN).toEqual({ minPH: 4, maxPH: 12 });
    expect(DEFFEYES_SOLVER_PH_DOMAIN).toEqual({ minPH: 0, maxPH: 14 });
  });

  it('supports toxic pH boundaries above 12.0 up to the displayed 12.5 range', () => {
    const targetCriticalPH = 12.25;
    const highPHData = generateDeffeyesPHChartData(
      { tempC: fixture.tempC, pH: fixture.pH, salinity: fixture.salinity, alkalinity: fixture.alkalinity },
      null,
      {
        tanMgL: 1,
        unIonizedNH3MgL: fractionNH3(targetCriticalPH, fixture.tempC, fixture.salinity),
        co2ToxicMgL: fixture.co2Toxic,
        h2sMeasuredUgL: fixture.h2sMeasuredUgL,
        h2sLimitUgL: fixture.h2sLimitUgL,
        currentPH: fixture.pH,
      },
      fixture.alkMin,
      fixture.alkMax,
      fixture.caMgL
    );

    expect(highPHData.nh3ToxicZone?.criticalPH).toBeCloseTo(targetCriticalPH, 2);
    expect(highPHData.nh3ToxicZone?.polygons[0]?.some(point => point.pH === 12.5)).toBe(true);
  });

  it('uses chart-domain helper names and honors legacy wrapper pH bounds', () => {
    const targetCriticalPH = 12.25;
    const nh3Limit = fractionNH3(targetCriticalPH, fixture.tempC, fixture.salinity);
    const h2sMeasured = h2sMeasuredForCritical(3.5);

    expect(criticalPHforNH3PHChartDomain(1, nh3Limit, fixture.tempC, fixture.salinity, 4, 12.5))
      .toBeCloseTo(targetCriticalPH, 2);
    expect(criticalPHforNH3PHChartDomain(1, nh3Limit, fixture.tempC, fixture.salinity))
      .toBeCloseTo(targetCriticalPH, 2);
    expect(criticalPHforNH3InPHRange(1, nh3Limit, fixture.tempC, fixture.salinity))
      .toBeGreaterThan(DEFFEYES_LEGACY_PH_DOMAIN.maxPH);
    expect(criticalPHforNH3InPHRange(1, nh3Limit, fixture.tempC, fixture.salinity, 4, 12))
      .toBeGreaterThan(12);

    expect(criticalPHforH2SPHChartDomain(
      h2sMeasured,
      fixture.pH,
      fixture.h2sLimitUgL,
      fixture.tempC,
      fixture.salinity,
      4,
      12.5
    )).toBeLessThan(4);
    expect(criticalPHforH2SInPHRange(
      h2sMeasured,
      fixture.pH,
      fixture.h2sLimitUgL,
      fixture.tempC,
      fixture.salinity,
      3,
      12.5
    )).toBeCloseTo(3.5, 2);
  });

  it('does not flow CO2 sentinel pH values into legacy alkalinity boundaries', () => {
    const legacy = generateDeffeyesChartData(
      { tempC: fixture.tempC, pH: fixture.pH, salinity: fixture.salinity, alkalinity: fixture.alkalinity },
      null,
      {
        tan: fixture.tan,
        unIonizedNH3: fixture.unIonizedNH3,
        co2Toxic: 0.0001,
        h2s: 0,
      },
      fixture.alkMin,
      fixture.alkMax,
      fixture.caMgL
    );

    expect(legacy.co2ToxicZone?.points.length).toBeGreaterThan(2);
    for (const point of legacy.co2ToxicZone?.points.slice(0, 5) ?? []) {
      const boundaryPH = calcPhForAlkDic(point.AT, point.CT, fixture.tempC, fixture.salinity);
      expect(boundaryPH).toBeGreaterThanOrEqual(DEFFEYES_LEGACY_PH_DOMAIN.minPH);
      expect(boundaryPH).toBeLessThanOrEqual(DEFFEYES_LEGACY_PH_DOMAIN.maxPH);
      expect(point.AT).not.toBeCloseTo(
        calcAlkOfDicPh(point.CT, DEFFEYES_LEGACY_PH_DOMAIN.maxPH + 1, fixture.tempC, fixture.salinity),
        3
      );
    }
  });

  it('round-trips public alkalinity/DIC pH solving and dosing output above pH 12.0', () => {
    const dic = 1.1;
    const targetPH = 12.25;
    const alk = calcAlkOfDicPh(dic, targetPH, fixture.tempC, fixture.salinity);

    expect(calcPhForAlkDic(alk, dic, fixture.tempC, fixture.salinity)).toBeCloseTo(targetPH, 3);
    expect(calcForwardDosing(
      { dic, alk, tempC: fixture.tempC, salinity: fixture.salinity },
      1,
      []
    )[0]?.ph).toBeCloseTo(targetPH, 3);

    const co2CritMg = calcCo2OfDic(dic, targetPH, fixture.tempC, fixture.salinity) * 44.010;
    expect(calcPhForCritCO2(dic, co2CritMg, fixture.tempC, fixture.salinity)).toBeCloseTo(targetPH, 3);
  });

  it('builds NH3, CO2, and H2S toxic coloring in the correct pH directions', () => {
    const { ph } = generatePair();
    const h2sCritical = criticalPHforH2S(
      fixture.h2sMeasuredUgL,
      fixture.pH,
      fixture.h2sLimitUgL,
      fixture.tempC,
      fixture.salinity
    );

    expect(ph.nh3ToxicZone?.criticalPH).toBeGreaterThan(fixture.pH);
    expect(ph.nh3ToxicZone?.polygons[0]?.some(point => point.pH === ph.domain.maxPH)).toBe(true);

    expect(ph.co2ToxicZone?.boundary.length).toBeGreaterThan(2);
    expect(ph.co2ToxicZone?.polygons[0]?.some(point => point.pH === ph.domain.minPH)).toBe(true);

    expect(h2sCritical).toBeLessThan(fixture.pH);
    expect(ph.h2sToxicZone?.criticalPH).toBeCloseTo(h2sCritical, 3);
    expect(ph.h2sToxicZone?.polygons[0]?.some(point => point.pH === ph.domain.minPH)).toBe(true);
  });

  it('returns a sampled target path and real projection diagnostics', () => {
    const { ph } = generatePair();

    expect(ph.targetPath?.length).toBeGreaterThan(2);
    expect(ph.targetPathSegments?.length).toBeGreaterThan(0);
    expect(ph.targetPathSegments?.flat().length).toBe(ph.targetPath?.length);
    expect(ph.targetPath?.[0]?.CT).toBeCloseTo(ph.currentPoint.CT, 4);
    expect(ph.targetPath?.[(ph.targetPath?.length ?? 1) - 1]?.CT).toBeCloseTo(ph.targetPoint?.CT ?? NaN, 4);
    expect(ph.projectionStats.projected).toBeGreaterThan(0);
    const alkalinityStats = ph.projectionStats.layers.alkalinity;
    const pHReferenceStats = ph.projectionStats.layers.pHReferences;
    expect(requireValue(alkalinityStats, 'alkalinity projection stats').projected).toBeGreaterThan(0);
    expect(requireValue(pHReferenceStats, 'pH reference projection stats').projected).toBe(ph.pHReferences.length * 2);

    const extremeAlkData = generateDeffeyesPHChartData(
      { tempC: fixture.tempC, pH: fixture.pH, salinity: fixture.salinity, alkalinity: fixture.alkalinity },
      null,
      {
        tanMgL: fixture.tan,
        unIonizedNH3MgL: fixture.unIonizedNH3,
        co2ToxicMgL: fixture.co2Toxic,
        h2sMeasuredUgL: fixture.h2sMeasuredUgL,
        h2sLimitUgL: fixture.h2sLimitUgL,
        currentPH: fixture.pH,
      },
      0.01,
      40,
      fixture.caMgL
    );
    expect(extremeAlkData.projectionStats.rejected + extremeAlkData.projectionStats.clipped).toBeGreaterThan(0);
  });

  it('preserves chemical dosing directions after projecting reagent lines to pH space', () => {
    const { legacy } = generatePair();
    const startDIC = legacy.currentPoint.DIC;
    const startALK = legacy.currentPoint.ALK;

    const directionCases = [
      { reagent: 'Add CO₂', expectDic: 1, expectPH: -1 },
      { reagent: 'De-gas CO₂', expectDic: -1, expectPH: 1 },
      { reagent: 'Sodium Hydroxide', expectDic: 0, expectPH: 1 },
      { reagent: 'Muriatic Acid', expectDic: 0, expectPH: -1 },
    ];

    for (const testCase of directionCases) {
      const reagent = requireValue(REAGENTS.find(r => r.name === testCase.reagent), testCase.reagent);

      const source = reagentDirectionLine(startDIC, startALK, reagent, 2);
      const projected = projectAlkDicLineToDicPh(source, fixture.tempC, fixture.salinity, {
        truncateOnInvalid: true,
      });

      expect(projected.length).toBeGreaterThan(2);
      const { first, last } = requireLineEndpoints(projected, `${testCase.reagent} projected line`);
      const dicDelta = last.CT - first.CT;
      const phDelta = last.pH - first.pH;

      if (testCase.expectDic === 0) {
        expect(Math.abs(dicDelta)).toBeLessThan(0.001);
      } else {
        expect(Math.sign(dicDelta)).toBe(testCase.expectDic);
      }
      expect(Math.sign(phDelta)).toBe(testCase.expectPH);
    }
  });

  it('matches H2S critical pH to the sulfide mass balance at the boundary', () => {
    const criticalPH = criticalPHforH2SInPHRange(
      fixture.h2sMeasuredUgL,
      fixture.pH,
      fixture.h2sLimitUgL,
      fixture.tempC,
      fixture.salinity,
      4,
      12.5
    );
    const totalSulfide = calcTotalSulfide(fixture.h2sMeasuredUgL, fixture.pH, fixture.tempC, fixture.salinity);

    expect(criticalPH).toBeCloseTo(criticalPHforH2S(
      fixture.h2sMeasuredUgL,
      fixture.pH,
      fixture.h2sLimitUgL,
      fixture.tempC,
      fixture.salinity
    ), 3);
    expect(calcH2S(totalSulfide, criticalPH, fixture.tempC, fixture.salinity))
      .toBeCloseTo(fixture.h2sLimitUgL, 3);
  });

  it('supports h2sMeasuredAtPH and keeps currentPH as a deprecated alias', () => {
    const measuredAtPH = 7.4;
    const targetCriticalPH = 6.4;
    const h2sMeasuredUgL = fixture.h2sLimitUgL
      * fractionH2S(measuredAtPH, fixture.tempC, fixture.salinity)
      / fractionH2S(targetCriticalPH, fixture.tempC, fixture.salinity);
    const alias = generateDeffeyesPHChartData(
      { tempC: fixture.tempC, pH: fixture.pH, salinity: fixture.salinity, alkalinity: fixture.alkalinity },
      null,
      {
        tanMgL: fixture.tan,
        unIonizedNH3MgL: fixture.unIonizedNH3,
        co2ToxicMgL: fixture.co2Toxic,
        h2sMeasuredUgL,
        h2sLimitUgL: fixture.h2sLimitUgL,
        currentPH: measuredAtPH,
      },
      fixture.alkMin,
      fixture.alkMax,
      fixture.caMgL
    );
    const preferred = generateDeffeyesPHChartData(
      { tempC: fixture.tempC, pH: fixture.pH, salinity: fixture.salinity, alkalinity: fixture.alkalinity },
      null,
      {
        tanMgL: fixture.tan,
        unIonizedNH3MgL: fixture.unIonizedNH3,
        co2ToxicMgL: fixture.co2Toxic,
        h2sMeasuredUgL,
        h2sLimitUgL: fixture.h2sLimitUgL,
        h2sMeasuredAtPH: measuredAtPH,
        currentPH: 8.2,
      },
      fixture.alkMin,
      fixture.alkMax,
      fixture.caMgL
    );
    const fallbackToParamsPH = generateDeffeyesPHChartData(
      { tempC: fixture.tempC, pH: measuredAtPH, salinity: fixture.salinity, alkalinity: fixture.alkalinity },
      null,
      {
        tanMgL: fixture.tan,
        unIonizedNH3MgL: fixture.unIonizedNH3,
        co2ToxicMgL: fixture.co2Toxic,
        h2sMeasuredUgL,
        h2sLimitUgL: fixture.h2sLimitUgL,
      },
      fixture.alkMin,
      fixture.alkMax,
      fixture.caMgL
    );

    const expectedCriticalPH = criticalPHforH2SPHChartDomain(
      h2sMeasuredUgL,
      measuredAtPH,
      fixture.h2sLimitUgL,
      fixture.tempC,
      fixture.salinity,
      DEFFEYES_CHART_PH_DOMAIN.minPH,
      DEFFEYES_CHART_PH_DOMAIN.maxPH
    );

    expect(alias.h2sToxicZone?.criticalPH).toBeCloseTo(expectedCriticalPH, 3);
    expect(preferred.h2sToxicZone?.criticalPH).toBeCloseTo(expectedCriticalPH, 3);
    expect(fallbackToParamsPH.h2sToxicZone?.criticalPH).toBeCloseTo(expectedCriticalPH, 3);
    expect(expectedCriticalPH).toBeCloseTo(targetCriticalPH, 2);
  });

  it('ignores invalid h2sMeasuredAtPH values before using the deprecated currentPH alias', () => {
    const measuredAtPH = 7.6;
    const targetCriticalPH = 6.6;
    const h2sMeasuredUgL = fixture.h2sLimitUgL
      * fractionH2S(measuredAtPH, fixture.tempC, fixture.salinity)
      / fractionH2S(targetCriticalPH, fixture.tempC, fixture.salinity);

    const data = generateDeffeyesPHChartData(
      { tempC: fixture.tempC, pH: 7.1, salinity: fixture.salinity, alkalinity: fixture.alkalinity },
      null,
      {
        tanMgL: fixture.tan,
        unIonizedNH3MgL: fixture.unIonizedNH3,
        co2ToxicMgL: fixture.co2Toxic,
        h2sMeasuredUgL,
        h2sLimitUgL: fixture.h2sLimitUgL,
        h2sMeasuredAtPH: 0,
        currentPH: measuredAtPH,
      },
      fixture.alkMin,
      fixture.alkMax,
      fixture.caMgL
    );

    expect(data.h2sToxicZone?.criticalPH).toBeCloseTo(targetCriticalPH, 2);
    expect(data.h2sToxicZone?.label).toContain(targetCriticalPH.toFixed(2));
  });

  it('keeps exposed toxic-zone pH values inside the chart domain', () => {
    const fullNH3 = generatePHData({
      tan: 1,
      unIonizedNH3: fractionNH3(3.5, fixture.tempC, fixture.salinity),
    });
    const fullH2S = generatePHData({
      h2sMeasuredUgL: h2sMeasuredForCritical(12.8),
    });

    expect(fullNH3.nh3ToxicZone?.criticalPH).toBe(DEFFEYES_CHART_PH_DOMAIN.minPH);
    expect(fullNH3.nh3ToxicZone?.label).toContain(DEFFEYES_CHART_PH_DOMAIN.minPH.toFixed(2));
    expect(fullH2S.h2sToxicZone?.criticalPH).toBe(DEFFEYES_CHART_PH_DOMAIN.maxPH);
    expect(fullH2S.h2sToxicZone?.label).toContain(DEFFEYES_CHART_PH_DOMAIN.maxPH.toFixed(2));
  });

  it('clips H2S toxic fills for no-risk, below-domain, and full-domain cases', () => {
    const noRisk = generatePHData({ h2sMeasuredUgL: 1, h2sLimitUgL: 200 });
    expect(noRisk.h2sToxicZone).toBeNull();

    const belowVisibleDomain = generatePHData({
      h2sMeasuredUgL: h2sMeasuredForCritical(3.5),
    });
    expect(belowVisibleDomain.h2sToxicZone).toBeNull();

    const fullVisibleDomain = generatePHData({
      h2sMeasuredUgL: h2sMeasuredForCritical(12.8),
    });
    expect(fullVisibleDomain.h2sToxicZone?.criticalPH).toBeGreaterThanOrEqual(fullVisibleDomain.domain.maxPH);
    expect(fullVisibleDomain.h2sToxicZone?.polygons[0]?.some(point => point.pH === fullVisibleDomain.domain.minPH)).toBe(true);
    expect(fullVisibleDomain.h2sToxicZone?.polygons[0]?.some(point => point.pH === fullVisibleDomain.domain.maxPH)).toBe(true);
  });

  it('shrinks safe bands upward when H2S is active in the pH domain', () => {
    const withoutH2S = generatePHData({ h2sMeasuredUgL: 0 });
    const withH2S = generatePHData({ h2sMeasuredUgL: h2sMeasuredForCritical(6.8) });

    const withoutLowest = Math.min(...withoutH2S.safeBands.flatMap(band => band.polygons.flat().map(point => point.pH)));
    const withLowest = Math.min(...withH2S.safeBands.flatMap(band => band.polygons.flat().map(point => point.pH)));

    expect(withoutH2S.safeBands.length).toBeGreaterThan(0);
    expect(withH2S.safeBands.length).toBeGreaterThan(0);
    expect(withLowest).toBeGreaterThan(withoutLowest);
    expect(withLowest).toBeGreaterThanOrEqual(6.8);
  });

  it('keeps CO2 toxic polygons segmented and clipped to visible pH', () => {
    const highLimit = generatePHData({ co2Toxic: 250 });

    expect(highLimit.co2ToxicZone?.boundarySegments?.length).toBe(highLimit.co2ToxicZone?.polygons.length);
    expect(highLimit.co2ToxicZone?.polygons.length).toBeGreaterThan(0);
    expect(highLimit.co2ToxicZone?.boundary[0]?.CT).toBeGreaterThan(0.5);
    for (const polygon of highLimit.co2ToxicZone?.polygons ?? []) {
      expect(Math.min(...polygon.map(point => point.CT))).toBeGreaterThanOrEqual(0);
      expect(Math.max(...polygon.map(point => point.CT))).toBeLessThanOrEqual(highLimit.domain.maxDIC);
      expect(Math.min(...polygon.map(point => point.pH))).toBeGreaterThanOrEqual(highLimit.domain.minPH);
      expect(Math.max(...polygon.map(point => point.pH))).toBeLessThanOrEqual(highLimit.domain.maxPH);
    }
  });

  it('splits projected ALK/DIC lines around invalid samples instead of connecting gaps', () => {
    const source = [
      { CT: 1.0, AT: calcAlkOfDicPh(1.0, 7.0, fixture.tempC, fixture.salinity) },
      { CT: 1.1, AT: calcAlkOfDicPh(1.1, 7.1, fixture.tempC, fixture.salinity) },
      { CT: -1, AT: 1 },
      { CT: 2.0, AT: calcAlkOfDicPh(2.0, 8.0, fixture.tempC, fixture.salinity) },
      { CT: 2.1, AT: calcAlkOfDicPh(2.1, 8.1, fixture.tempC, fixture.salinity) },
    ];

    const segments = projectAlkDicLineSegmentsToDicPh(source, fixture.tempC, fixture.salinity);

    expect(segments).toHaveLength(2);
    expect(segments[0]?.map(point => point.sourceIndex)).toEqual([0, 1]);
    expect(segments[1]?.map(point => point.sourceIndex)).toEqual([3, 4]);
  });

  it('preserves diagonal reagent slope in source space and round-trips its pH projection', () => {
    const { legacy } = generatePair();
    const reagent = requireValue(REAGENTS.find(r => r.name === 'Sodium Bicarbonate'), 'Sodium Bicarbonate');

    const source = reagentDirectionLine(legacy.currentPoint.DIC, legacy.currentPoint.ALK, reagent, 2);
    const { first: firstSource, last: lastSource } = requireLineEndpoints(source, 'Sodium Bicarbonate source line');
    expect((lastSource.AT - firstSource.AT) / (lastSource.CT - firstSource.CT)).toBeCloseTo(reagent.slope, 5);

    const projected = projectAlkDicLineToDicPh(source, fixture.tempC, fixture.salinity, {
      truncateOnInvalid: true,
    });
    expect(projected.length).toBeGreaterThan(2);
    for (const point of projected) {
      expect(calcAlkOfDicPh(point.CT, point.pH, fixture.tempC, fixture.salinity)).toBeCloseTo(point.AT ?? NaN, 3);
    }
  });

  it('keeps on-demand sampled path segments mathematically equivalent to the forward dosing path', () => {
    const { legacy } = generatePair();
    const path = calcForwardDosing(
      { dic: legacy.currentPoint.DIC, alk: legacy.currentPoint.ALK, tempC: fixture.tempC, salinity: fixture.salinity },
      1,
      [
        { reagentKey: 'Sodium Hydroxide', amountGrams: 2 },
        { reagentKey: 'Add CO₂', amountGrams: 5 },
      ]
    );

    expect(path.length).toBeGreaterThan(1);
    const projectedSegments = path.slice(0, -1).flatMap((step, index) => {
      const next = requireValue(path[index + 1], `forward dosing step ${index + 1}`);
      const stepSegments = sampleAlkDicSegmentSegmentsToDicPh(
        { CT: step.dic, AT: step.alk },
        { CT: next.dic, AT: next.alk },
        fixture.tempC,
        fixture.salinity,
        { steps: 16 }
      );
      const projectedStart = projectAlkDicPointToDicPh({ CT: step.dic, AT: step.alk }, fixture.tempC, fixture.salinity);
      const projectedEnd = projectAlkDicPointToDicPh({ CT: next.dic, AT: next.alk }, fixture.tempC, fixture.salinity);
      const visible = stepSegments.flat();

      expect(projectedStart).not.toBeNull();
      expect(projectedEnd).not.toBeNull();
      expect(visible[0]?.CT).toBeCloseTo(projectedStart?.CT ?? NaN, 4);
      expect(visible[0]?.pH).toBeCloseTo(projectedStart?.pH ?? NaN, 4);
      expect(visible[visible.length - 1]?.CT).toBeCloseTo(projectedEnd?.CT ?? NaN, 4);
      expect(visible[visible.length - 1]?.pH).toBeCloseTo(projectedEnd?.pH ?? NaN, 4);

      return stepSegments;
    });

    expect(projectedSegments.length).toBeGreaterThan(0);
    for (const point of projectedSegments.flat()) {
      expect(calcAlkOfDicPh(point.CT, point.pH, fixture.tempC, fixture.salinity)).toBeCloseTo(point.AT ?? NaN, 3);
    }
  });
});
