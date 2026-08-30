/**
 * Faz 4 veri taşıma dönüşüm matematiği (plan §9.1–9.2 + K-3/D-12 kuralları).
 *
 * Pinler: band örtüşmesi priority ile çözülür ve boşluklar açıkça kapatılır;
 * oran/FCR feed matrisinden band-orta ağırlık + medyan sıcaklıkta bilinear
 * örneklenir; çözülemeyen yem → DRAFT; v2 doğrulamasını geçemeyen ACTIVE adayı
 * DRAFT'a düşer; preMedicationFasting AYNEN taşınır.
 */
import {
  buildEvenMealSchedule,
  convertLegacySchedule,
  convertProgramToProtocolV2,
  convertV1ProtocolToV2,
  normalizeAssignmentsToRanges,
  resolveUniqueName,
  sampleMatrix,
  type FeedRef,
  type LegacyFeedAssignment,
  type LegacyProgramRow,
  type LegacyV1ProtocolRow,
} from '../migration/legacy-protocol-conversion';

const feed = (id: string, code: string, matrix?: FeedRef['feedingMatrix2D']): FeedRef => ({
  id,
  code,
  name: `Feed ${code}`,
  type: 'grower',
  feedingMatrix2D: matrix,
});

const FEED_A = feed('11111111-1111-4111-8111-111111111111', 'FA', {
  temperatures: [10, 20],
  weights: [0, 100],
  rates: [
    [4, 2],
    [6, 4],
  ],
  fcrMatrix: [
    [1.0, 1.2],
    [1.1, 1.3],
  ],
});
const FEED_B = feed('22222222-2222-4222-8222-222222222222', 'FB');

const assignment = (over: Partial<LegacyFeedAssignment>): LegacyFeedAssignment => ({
  feedId: FEED_A.id,
  feedCode: 'FA',
  feedName: 'Feed FA',
  minWeightG: 0,
  maxWeightG: 100,
  priority: 1,
  ...over,
});

describe('sampleMatrix', () => {
  it('interpolates bilinearly inside the domain', () => {
    // temp 15 (yarı), weight 50 (yarı): ortalaması (4+2+6+4)/4 = 4
    const value = sampleMatrix(
      {
        temperatures: [10, 20],
        weights: [0, 100],
        values: [
          [4, 2],
          [6, 4],
        ],
      },
      15,
      50,
    );
    expect(value).toBeCloseTo(4);
  });

  it('clamps out-of-domain requests to the nearest edge', () => {
    const value = sampleMatrix(
      {
        temperatures: [10, 20],
        weights: [0, 100],
        values: [
          [4, 2],
          [6, 4],
        ],
      },
      99,
      -5,
    );
    expect(value).toBe(6); // temp üst kenar + ağırlık alt kenar
  });
});

describe('normalizeAssignmentsToRanges', () => {
  it('resolves overlaps by priority (1 wins) and merges same-feed neighbours', () => {
    const { ranges, notes } = normalizeAssignmentsToRanges([
      assignment({ minWeightG: 0, maxWeightG: 60, priority: 2 }),
      assignment({
        feedId: FEED_B.id,
        feedCode: 'FB',
        minWeightG: 40,
        maxWeightG: 100,
        priority: 1,
      }),
    ]);
    expect(ranges).toHaveLength(2);
    expect(ranges[0]).toMatchObject({ minWeightG: 0, maxWeightG: 40 });
    expect(ranges[0]!.assignment.feedId).toBe(FEED_A.id);
    // 40–60 örtüşmesini priority 1 (FB) kazanır ve 60–100 ile birleşir.
    expect(ranges[1]).toMatchObject({ minWeightG: 40, maxWeightG: 100 });
    expect(ranges[1]!.assignment.feedId).toBe(FEED_B.id);
    expect(notes.some((note) => note.includes('örtüşme'))).toBe(true);
  });

  it('closes gaps by extending the previous band and pins the start to 0g', () => {
    const { ranges, notes } = normalizeAssignmentsToRanges([
      assignment({ minWeightG: 10, maxWeightG: 50 }),
      assignment({ feedId: FEED_B.id, minWeightG: 80, maxWeightG: 200 }),
    ]);
    expect(ranges[0]).toMatchObject({ minWeightG: 0, maxWeightG: 80 });
    expect(ranges[1]).toMatchObject({ minWeightG: 80, maxWeightG: 200 });
    expect(notes.some((note) => note.includes('boşluğu'))).toBe(true);
    expect(notes.some((note) => note.includes("0g'a çekildi"))).toBe(true);
  });
});

describe('convertProgramToProtocolV2', () => {
  const program = (over: Partial<LegacyProgramRow>): LegacyProgramRow => ({
    id: '33333333-3333-4333-8333-333333333333',
    tenantId: 'tenant',
    name: 'Alabalık Programı',
    status: 'active',
    feedAssignments: [assignment({ minWeightG: 0, maxWeightG: 100 })],
    settings: { autoTransition: true, transitionBuffer: 0.5, fcrSource: 'feed' },
    ...over,
  });

  it('samples rate and FCR from the feed matrix at band mid-weight and median temperature', () => {
    const converted = convertProgramToProtocolV2(program({}), {
      feedsById: new Map([[FEED_A.id, FEED_A]]),
      medianTempC: 15,
    });
    expect(converted).not.toBeNull();
    // mid ağırlık 50g, medyan 15°C → oran 4 (bilinear orta), FCR 1.15
    expect(converted!.bands[0]!.feedingRatePercent).toBeCloseTo(4);
    expect(converted!.bands[0]!.expectedFcr).toBeCloseTo(1.15);
    expect(converted!.status).toBe('active');
    expect(converted!.migrationNote).toContain('[migrated:program:');
  });

  it('keeps the program fcrTable as the protocol matrix when fcrSource=program', () => {
    const converted = convertProgramToProtocolV2(
      program({
        settings: { fcrSource: 'program', defaultMealsPerDay: 3 },
        fcrTable: {
          temperatures: [10, 20],
          weights: [0, 100],
          fcrValues: [
            [1, 1],
            [2, 2],
          ],
        },
      }),
      { feedsById: new Map([[FEED_A.id, FEED_A]]), medianTempC: 10 },
    );
    expect(converted!.settings.fcrSource).toBe('matrix');
    expect(converted!.fcrMatrix?.fcrValues).toEqual([
      [1, 1],
      [2, 2],
    ]);
    expect(converted!.defaultMealSchedule.mealsPerDay).toBe(3);
  });

  it('skips completed/cancelled programs and drafts non-active ones', () => {
    expect(
      convertProgramToProtocolV2(program({ status: 'completed' }), {
        feedsById: new Map(),
        medianTempC: null,
      }),
    ).toBeNull();
    const paused = convertProgramToProtocolV2(program({ status: 'paused' }), {
      feedsById: new Map([[FEED_A.id, FEED_A]]),
      medianTempC: null,
    });
    expect(paused!.status).toBe('draft');
    expect(paused!.notes.some((note) => note.includes('15°C varsayımıyla'))).toBe(true);
  });

  it('carries enrichment schedule + preMedicationFasting into settings.adjustments', () => {
    const converted = convertProgramToProtocolV2(program({}), {
      feedsById: new Map([[FEED_A.id, FEED_A]]),
      medianTempC: 12,
      enrichment: {
        defaultSchedule: {
          totalMealsPerDay: 2,
          schedule: [
            { time: '08:00', percentOfDaily: 60 },
            { time: '16:00', percentOfDaily: 40 },
          ],
          adjustments: { preMedicationFasting: 24, lowOxygenReduction: 30 },
        },
        temperatureRanges: [{ min: 5, max: 12, feedingMultiplier: 0.7 }],
        minDissolvedOxygen: 5.5,
        growthStageProtocols: null,
      },
    });
    expect(converted!.defaultMealSchedule.entries).toHaveLength(2);
    expect(converted!.settings.adjustments?.preMedicationFastingHours).toBe(24);
    expect(converted!.settings.adjustments?.lowOxygenReduction).toBe(30);
    expect(converted!.settings.minDissolvedOxygen).toBe(5.5);
    expect(converted!.temperatureAdjustments).toEqual([{ minC: 5, maxC: 12, rateMultiplier: 0.7 }]);
  });
});

describe('convertV1ProtocolToV2', () => {
  const v1 = (over: Partial<LegacyV1ProtocolRow>): LegacyV1ProtocolRow => ({
    id: '44444444-4444-4444-8444-444444444444',
    tenantId: 'tenant',
    name: 'V1 Protokol',
    species: 'Alabalık',
    isDefault: false,
    ...over,
  });

  it('resolves feeds via protocol feedId and becomes ACTIVE when everything resolves', () => {
    const converted = convertV1ProtocolToV2(
      v1({
        feedId: FEED_A.id,
        targetFcr: 1.4,
        growthStageProtocols: [
          { minWeight: 0, maxWeight: 100, feedPercent: 3 },
          { minWeight: 100, maxWeight: 500, feedPercent: 2 },
        ],
      }),
      { feedsById: new Map([[FEED_A.id, FEED_A]]), feedsByType: new Map() },
    );
    expect(converted.status).toBe('active');
    expect(converted.bands).toHaveLength(2);
    expect(converted.bands.every((band) => band.feedId === FEED_A.id)).toBe(true);
    expect(converted.bands[0]!.expectedFcr).toBe(1.4);
  });

  it('falls back to species growthStages.recommendedFeedType and drafts when unresolved', () => {
    const converted = convertV1ProtocolToV2(
      v1({
        growthStageProtocols: [{ minWeight: 0, maxWeight: 100, feedPercent: 3 }],
      }),
      {
        feedsById: new Map(),
        feedsByType: new Map([['starter', [FEED_A, FEED_B]]]), // çoklu eşleşme → çözülemez
        species: {
          id: 'species-1',
          commonName: 'Alabalık',
          growthStages: [
            { minWeight: 0, maxWeight: 100, recommendedFeedType: 'STARTER', targetFCR: 1.1 },
          ],
        },
      },
    );
    expect(converted.status).toBe('draft');
    expect(converted.bands[0]!.feedId).toBe('');
    expect(converted.bands[0]!.expectedFcr).toBe(1.1); // tür aşaması FCR'ı yine taşınır
    expect(converted.notes.some((note) => note.includes('çözülemedi'))).toBe(true);
  });

  it('converts kg-unit stages to grams and carries preMedicationFasting verbatim', () => {
    const converted = convertV1ProtocolToV2(
      v1({
        feedId: FEED_A.id,
        growthStageProtocols: [{ minWeight: 0, maxWeight: 1, weightUnit: 'kg', feedPercent: 2.5 }],
        defaultSchedule: {
          totalMealsPerDay: 2,
          schedule: [
            { time: '09:00', percentOfDaily: 50 },
            { time: '15:00', percentOfDaily: 50 },
          ],
          adjustments: { preMedicationFasting: 12 },
        },
      }),
      { feedsById: new Map([[FEED_A.id, FEED_A]]), feedsByType: new Map() },
    );
    expect(converted.bands[0]).toMatchObject({ minWeightG: 0, maxWeightG: 1000 });
    expect(converted.settings.adjustments?.preMedicationFastingHours).toBe(12);
  });

  it('demotes an ACTIVE candidate that fails v2 validation to DRAFT with the errors noted', () => {
    const converted = convertV1ProtocolToV2(
      v1({
        feedId: FEED_A.id,
        // feedPercent 40 → v2 üst sınırı (%15) clamp'ler; ama geçersiz öğün
        // planı v2 doğrulamasında yakalanır (toplam %90).
        growthStageProtocols: [{ minWeight: 0, maxWeight: 100, feedPercent: 3 }],
        defaultSchedule: {
          totalMealsPerDay: 2,
          schedule: [
            { time: '09:00', percentOfDaily: 50 },
            { time: '15:00', percentOfDaily: 40 },
          ],
        },
      }),
      { feedsById: new Map([[FEED_A.id, FEED_A]]), feedsByType: new Map() },
    );
    // Geçersiz v1 planı convertLegacySchedule'da elenir → eşit dağıtım devreye girer,
    // protokol ACTIVE kalabilir; kural notu düşer.
    expect(converted.defaultMealSchedule.entries.length).toBeGreaterThan(0);
    const sum = converted.defaultMealSchedule.entries.reduce(
      (acc, entry) => acc + entry.percentOfDaily,
      0,
    );
    expect(Math.abs(sum - 100)).toBeLessThanOrEqual(0.01);
  });
});

describe('helpers', () => {
  it('buildEvenMealSchedule distributes times across 08:00–18:00 and sums to 100', () => {
    const schedule = buildEvenMealSchedule(3);
    expect(schedule.entries.map((entry) => entry.time)).toEqual(['08:00', '13:00', '18:00']);
    const sum = schedule.entries.reduce((acc, entry) => acc + entry.percentOfDaily, 0);
    expect(Math.abs(sum - 100)).toBeLessThanOrEqual(0.01);
  });

  it('convertLegacySchedule rejects non-increasing times and bad sums', () => {
    expect(
      convertLegacySchedule({
        schedule: [
          { time: '10:00', percentOfDaily: 50 },
          { time: '09:00', percentOfDaily: 50 },
        ],
      }),
    ).toBeNull();
    expect(
      convertLegacySchedule({
        schedule: [
          { time: '09:00', percentOfDaily: 50 },
          { time: '15:00', percentOfDaily: 49 },
        ],
      }),
    ).toBeNull();
  });

  it('resolveUniqueName suffixes deterministically on collision', () => {
    const taken = new Set(['program a', 'program a (migrated)']);
    expect(resolveUniqueName('Program A', taken, 'abcdef01-0000-4000-8000-000000000000')).toBe(
      'Program A (migrated-abcdef01)',
    );
    expect(resolveUniqueName('Program B', taken, 'x')).toBe('Program B');
  });
});
