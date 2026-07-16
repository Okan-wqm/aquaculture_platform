/**
 * FeedSelection DataLoader — C-5 v2 re-point.
 *
 * Pinlenen sözleşme:
 *  - Ünitenin AKTİF v2 ataması varsa "güncel yem" protokol bandından çözülür
 *    ve oran 06:00 üreticisiyle AYNI matematikle hesaplanır (band × sıcaklık
 *    çarpanı × (1 + rateAdj/100)); legacy zincirler o ünite için HİÇ koşmaz.
 *  - v2 ataması yoksa legacy fallback (v1 protokol → batch_feed_assignments)
 *    çalışmaya devam eder (drain penceresi; Faz 8'de silinir).
 *  - Context unitId taşımıyorsa v2 sorgusu hiç atılmaz.
 */
import { requestContextStorage } from '@aquaculture/backend-common/logging';
import { ObjectLiteral, Repository } from 'typeorm';

import { createFeedSelectionLoader } from '../feed-selection.dataloader';

const TENANT = '11111111-1111-4111-8111-111111111111';
const BATCH = '22222222-2222-4222-8222-222222222222';
const UNIT = '77777777-7777-4777-8777-777777777777';

const V2_BANDS = [
  {
    minWeightG: 0,
    maxWeightG: 200,
    feedId: 'feed-s1',
    feedCode: 'S1',
    feedName: 'Starter 1mm',
    feedingRatePercent: 3,
    expectedFcr: 1.1,
  },
  {
    minWeightG: 200,
    maxWeightG: 1000000,
    feedId: 'feed-g4',
    feedCode: 'G4',
    feedName: 'Grower 4mm',
    feedingRatePercent: 2,
    expectedFcr: 1.3,
  },
];

function makeQuery(v2Rows: unknown[]): jest.Mock {
  const query = jest.fn();
  query.mockImplementation(async (sql: string): Promise<unknown[]> => {
    if (sql.includes('feeding_protocol_assignments')) return v2Rows;
    return []; // batch_feed_assignments / feeds / batches_v2 / feeding_protocols
  });
  return query;
}

function mockRepo(query: jest.Mock): Repository<ObjectLiteral> {
  return { query } as Partial<Repository<ObjectLiteral>> as Repository<ObjectLiteral>;
}

function inTenantContext<T>(fn: () => Promise<T>): Promise<T> {
  return requestContextStorage.run({ tenantId: TENANT }, fn);
}

describe('createFeedSelectionLoader — C-5 v2 protokol çözümü', () => {
  it('aktif v2 atamalı ünitede yemi banddan, oranı üretici matematiğiyle çözer', async () => {
    const query = makeQuery([
      {
        unitId: UNIT,
        overrides: { rateAdjustmentPercent: 10 },
        bands: V2_BANDS,
        temperatureAdjustments: [{ minC: 10, maxC: 20, rateMultiplier: 1.2 }],
        settings: { fcrSource: 'band' },
      },
    ]);
    const loader = createFeedSelectionLoader(mockRepo(query));
    loader.setContext(BATCH, 120, 100, 15, UNIT);

    const row = await inTenantContext(() => loader.load(BATCH));

    // 3% × 1.2 (15°C bandı) × 1.10 (atama +%10) = 3.96; 100kg → 3.96kg/gün.
    expect(row).toEqual({
      feedId: 'feed-s1',
      feedCode: 'S1',
      feedName: 'Starter 1mm',
      feedingRatePercent: 3.96,
      dailyFeedKg: 3.96,
    });
    // v2 çözüldü → legacy sorgular (batch_feed_assignments/batches_v2) yine de
    // toplu koşar ama sonuç v2'den döner; band yemi denormalize olduğundan
    // feeds sorgusu gerekmez.
    const sqls = query.mock.calls.map((call) => String(call[0]));
    expect(sqls.some((s) => s.includes('feeding_protocol_assignments'))).toBe(true);
  });

  it('sıcaklık okuması yokken çarpan 1.0 kalır (P-20) ve ağır balık üst banda düşer', async () => {
    const query = makeQuery([
      {
        unitId: UNIT,
        overrides: null,
        bands: V2_BANDS,
        temperatureAdjustments: [{ minC: 10, maxC: 20, rateMultiplier: 1.2 }],
        settings: { fcrSource: 'band' },
      },
    ]);
    const loader = createFeedSelectionLoader(mockRepo(query));
    loader.setContext(BATCH, 350, 200, undefined, UNIT);

    const row = await inTenantContext(() => loader.load(BATCH));

    expect(row).toMatchObject({
      feedCode: 'G4',
      feedingRatePercent: 2,
      dailyFeedKg: 4,
    });
  });

  it('v2 ataması olmayan ünite legacy fallback zincirine düşer', async () => {
    const query = makeQuery([]);
    const loader = createFeedSelectionLoader(mockRepo(query));
    loader.setContext(BATCH, 120, 100, 15, UNIT);

    const row = await inTenantContext(() => loader.load(BATCH));

    // Legacy tablolar da boş → null; ama fallback sorguları KOŞTU.
    expect(row).toBeNull();
    const sqls = query.mock.calls.map((call) => String(call[0]));
    expect(sqls.some((s) => s.includes('batch_feed_assignments'))).toBe(true);
  });

  it('context unitId taşımıyorsa v2 sorgusu hiç atılmaz', async () => {
    const query = makeQuery([]);
    const loader = createFeedSelectionLoader(mockRepo(query));
    loader.setContext(BATCH, 120, 100, 15);

    await inTenantContext(() => loader.load(BATCH));

    const sqls = query.mock.calls.map((call) => String(call[0]));
    expect(sqls.some((s) => s.includes('feeding_protocol_assignments'))).toBe(false);
  });
});
