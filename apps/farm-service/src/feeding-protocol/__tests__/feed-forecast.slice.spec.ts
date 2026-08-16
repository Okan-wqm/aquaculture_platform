/**
 * sliceSnapshotToHorizon (K-10) — pencere dışı iddia bırakılmadığını pinler:
 * seriler kesilir, dilim dışındaki tükeniş alanları null'lanır, dilim dışı
 * geçişler/alertler elenir; pencere içindekiler AYNEN korunur.
 */
import { FeedingForecastSnapshot } from '../entities/feeding-forecast-snapshot.entity';
import { sliceSnapshotToHorizon } from '../resolvers/feed-forecast.resolver';
import { compileFeedingForecastMortalityProvenanceV1 } from '@aquaculture/feeding-contracts';

function snapshotFixture(): FeedingForecastSnapshot {
  const series = Array.from({ length: 120 }, (_, i) => i + 1);
  return {
    id: 's1',
    tenantId: 't1',
    siteScopeKey: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    poolScope: 'SITE',
    generationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    payloadDigest: 'a'.repeat(64),
    horizonDays: 120,
    computedAt: new Date('2026-01-01T07:00:00Z'),
    perFeed: [
      {
        feedId: 'near',
        feedCode: 'N',
        feedName: 'Near',
        currentStockKg: 10,
        dailyConsumptionSeries: series,
        remainingStockSeries: series,
        stockoutDate: '2026-01-06',
        daysOfCover: 5,
        firstConsumptionDate: '2026-01-01',
        coverageFromAdoptionDays: 5,
        reorderDate: '2026-01-01',
        reorderQuantityKg: 42,
        procurementLeadTimeDays: 7,
        leadTimeSource: 'default',
      },
      {
        feedId: 'far',
        feedCode: 'F',
        feedName: 'Far',
        currentStockKg: 1000,
        dailyConsumptionSeries: series,
        remainingStockSeries: series,
        stockoutDate: '2026-04-11',
        daysOfCover: 100,
        firstConsumptionDate: '2026-01-01',
        coverageFromAdoptionDays: 100,
        reorderDate: '2026-04-04',
        reorderQuantityKg: 99,
        procurementLeadTimeDays: 3,
        leadTimeSource: 'feed',
      },
    ],
    perUnit: [
      {
        unitId: 'u1',
        unitName: 'Tank 1',
        unitCode: 'T1',
        currentFeedId: 'near',
        terminalFeedId: 'x',
        transitions: [
          { fromFeedId: 'near', toFeedId: 'far', estimatedDate: '2026-01-13', daysFromNow: 12 },
          { fromFeedId: 'far', toFeedId: 'x', estimatedDate: '2026-04-11', daysFromNow: 100 },
        ],
      },
    ],
    alerts: [
      { type: 'STOCKOUT_FORECAST', feedId: 'near', days: 5, atDay: 5 },
      { type: 'TRANSITION_COVERAGE_GAP', feedId: 'far', days: 100, atDay: 12 },
      { type: 'STOCKOUT_FORECAST', feedId: 'far', days: 1, atDay: 100 },
    ],
    mortalityAssumption: compileFeedingForecastMortalityProvenanceV1([
      { unitId: 'u1', source: 'none', dailySurvivalRate: 1 },
    ]),
    createdAt: new Date(),
    updatedAt: new Date(),
    version: 1,
  };
}

describe('sliceSnapshotToHorizon (K-10)', () => {
  const view = sliceSnapshotToHorizon(snapshotFixture(), 30, new Date('2026-01-02T07:00:00.000Z'));

  it('serileri ufka keser ve horizonDays istenen değeri taşır', () => {
    expect(view.horizonDays).toBe(30);
    expect(view.perFeed[0]?.dailyConsumptionSeries).toHaveLength(30);
    expect(view.perFeed[1]?.remainingStockSeries).toHaveLength(30);
  });

  it('pencere içindeki tükeniş alanları AYNEN kalır', () => {
    const near = view.perFeed.find((f) => f.feedId === 'near');
    expect(near?.daysOfCover).toBe(5);
    expect(near?.stockoutDate).toBe('2026-01-06');
    expect(near?.reorderQuantityKg).toBe(42);
  });

  it('pencere dışındaki tükeniş alanları null — görünmeyen şey iddia edilmez', () => {
    const far = view.perFeed.find((f) => f.feedId === 'far');
    expect(far?.daysOfCover).toBeNull();
    expect(far?.stockoutDate).toBeNull();
    expect(far?.reorderDate).toBeNull();
    expect(far?.reorderQuantityKg).toBeNull();
  });

  it('dilim dışı geçişler ve alertler elenir, içindekiler kalır', () => {
    expect(view.perUnit[0]?.transitions.map((t) => t.daysFromNow)).toEqual([12]);
    expect(view.alerts).toEqual([
      { type: 'STOCKOUT_FORECAST', feedId: 'near', days: 5, atDay: 5 },
      { type: 'TRANSITION_COVERAGE_GAP', feedId: 'far', days: 100, atDay: 12 },
    ]);
  });

  it('projects pool semantics and deterministic freshness from the supplied clock', () => {
    expect(view.poolScope).toBe('SITE');
    expect(view.stale).toBe(false);
    expect(
      sliceSnapshotToHorizon(snapshotFixture(), 30, new Date('2026-01-02T09:00:00.001Z')).stale,
    ).toBe(true);
  });
});
