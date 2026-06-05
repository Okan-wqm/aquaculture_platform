import { describe, expect, it } from 'vitest';
import {
  alkMgToMeq,
  calcAlkOfDicPh,
  calcForwardDosing,
  calcH2S,
  calcTotalSulfide,
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

function generatePair() {
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

function generatePHData(overrides: Partial<typeof fixture> = {}) {
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

    expect(ph.domain.maxPH).toBe(12.5);
    expect(ph.pHReferences.some(line => line.value === 12.5 && line.points.length === 2)).toBe(true);
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
    expect(alkalinityStats).toBeDefined();
    expect(pHReferenceStats).toBeDefined();
    expect(alkalinityStats!.projected).toBeGreaterThan(0);
    expect(pHReferenceStats!.projected).toBe(ph.pHReferences.length * 2);

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
      const reagent = REAGENTS.find(r => r.name === testCase.reagent);
      expect(reagent).toBeDefined();

      const source = reagentDirectionLine(startDIC, startALK, reagent!, 2);
      const projected = projectAlkDicLineToDicPh(source, fixture.tempC, fixture.salinity, {
        truncateOnInvalid: true,
      });

      expect(projected.length).toBeGreaterThan(2);
      const first = projected[0]!;
      const last = projected[projected.length - 1]!;
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
    const reagent = REAGENTS.find(r => r.name === 'Sodium Bicarbonate');
    expect(reagent).toBeDefined();

    const source = reagentDirectionLine(legacy.currentPoint.DIC, legacy.currentPoint.ALK, reagent!, 2);
    const firstSource = source[0]!;
    const lastSource = source[source.length - 1]!;
    expect((lastSource.AT - firstSource.AT) / (lastSource.CT - firstSource.CT)).toBeCloseTo(reagent!.slope, 5);

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
      const next = path[index + 1]!;
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
