/**
 * FeedSelection DataLoader — C-5 v2 re-point.
 *
 * Pinlenen sözleşme:
 *  - Ünitenin AKTİF v2 ataması varsa "güncel yem" protokol bandından çözülür
 *    ve oran 06:00 üreticisiyle AYNI matematikle hesaplanır (band × sıcaklık
 *    çarpanı × (1 + rateAdj/100)); legacy zincir o ünite için HİÇ koşmaz.
 *  - v2 ataması yoksa legacy fallback (batch_feed_assignments) çalışır.
 *  - Context unitId taşımıyorsa v2 sorgusu hiç atılmaz.
 *  - ÖLÜ v1 zinciri geri gelmez: batches_v2 / feeding_protocols (v1) ARTIK
 *    HİÇ sorgulanmaz — o kolonun (batches_v2.protocolId) yazarı hiç olmadı ve
 *    kolon kaldırıldı; geri gelen bir sorgu bu testte kırmızı olur.
 */
import { requestContextStorage } from '@aquaculture/backend-common/logging';
import { ObjectLiteral, Repository } from 'typeorm';

import { createFeedSelectionLoader } from '../feed-selection.dataloader';
import {
  ProtocolRateService,
  derivedBandWeightG,
} from '../../../feeding-protocol/services/protocol-rate.service';
import { UnitProtocolResolverService } from '../../../feeding-protocol/services/unit-protocol-resolver.service';

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
    return []; // batch_feed_assignments / feeds
  });
  return query;
}

function mockRepo(query: jest.Mock): Repository<ObjectLiteral> {
  return { query } as Partial<Repository<ObjectLiteral>> as Repository<ObjectLiteral>;
}

/** Real resolver + real rate math — only the SQL handle is a double. */
function makeLoader(query: jest.Mock): ReturnType<typeof createFeedSelectionLoader> {
  return createFeedSelectionLoader(
    mockRepo(query),
    new UnitProtocolResolverService(new ProtocolRateService()),
  );
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
        protocolId: 'p-1',
        protocolName: 'Std',
        bands: V2_BANDS,
        temperatureAdjustments: [{ minC: 10, maxC: 20, rateMultiplier: 1.2 }],
        settings: { fcrSource: 'band' },
      },
    ]);
    const loader = makeLoader(query);
    // 100 kg / 833.33 balık ≈ 120 g — ünite aggregate'inden türetilmiş band ağırlığı.
    loader.setContext(BATCH, derivedBandWeightG(100, 833.3333333333334), 100, 15, UNIT);

    const row = await inTenantContext(() => loader.load(BATCH));

    // 3% × 1.2 (15°C bandı) × 1.10 (atama +%10) = 3.96; 100kg → 3.96kg/gün.
    expect(row).toEqual({
      feedId: 'feed-s1',
      feedCode: 'S1',
      feedName: 'Starter 1mm',
      feedingRatePercent: 3.96,
      dailyFeedKg: 3.96,
    });
    const sqls = query.mock.calls.map((call) => String(call[0]));
    expect(sqls.some((s) => s.includes('feeding_protocol_assignments'))).toBe(true);
  });

  it('sıcaklık okuması yokken çarpan 1.0 kalır (P-20) ve ağır balık üst banda düşer', async () => {
    const query = makeQuery([
      {
        unitId: UNIT,
        overrides: null,
        protocolId: 'p-1',
        protocolName: 'Std',
        bands: V2_BANDS,
        temperatureAdjustments: [{ minC: 10, maxC: 20, rateMultiplier: 1.2 }],
        settings: { fcrSource: 'band' },
      },
    ]);
    const loader = makeLoader(query);
    // 200 kg / 571.43 balık ≈ 350 g → üst band.
    loader.setContext(BATCH, derivedBandWeightG(200, 571.4285714285714), 200, undefined, UNIT);

    const row = await inTenantContext(() => loader.load(BATCH));

    expect(row).toMatchObject({
      feedCode: 'G4',
      feedingRatePercent: 2,
      dailyFeedKg: 4,
    });
  });

  it('v2 ataması olmayan ünite legacy fallback zincirine düşer', async () => {
    const query = makeQuery([]);
    const loader = makeLoader(query);
    loader.setContext(BATCH, derivedBandWeightG(100, 833.3333333333334), 100, 15, UNIT);

    const row = await inTenantContext(() => loader.load(BATCH));

    // Legacy tablolar da boş → null; ama fallback sorguları KOŞTU.
    expect(row).toBeNull();
    const sqls = query.mock.calls.map((call) => String(call[0]));
    expect(sqls.some((s) => s.includes('batch_feed_assignments'))).toBe(true);
  });

  it('context unitId taşımıyorsa v2 sorgusu hiç atılmaz', async () => {
    const query = makeQuery([]);
    const loader = makeLoader(query);
    loader.setContext(BATCH, derivedBandWeightG(100, 833.3333333333334), 100, 15);

    await inTenantContext(() => loader.load(BATCH));

    const sqls = query.mock.calls.map((call) => String(call[0]));
    expect(sqls.some((s) => s.includes('feeding_protocol_assignments'))).toBe(false);
  });

  it('ölü v1 zincirini (batches_v2 / feeding_protocols) ARTIK sorgulamaz', async () => {
    // Regression pin for the dropped `batches_v2.protocolId` column: a
    // resurrected v1 read would now be a runtime 42703, so it must not exist.
    const query = makeQuery([]);
    const loader = makeLoader(query);
    loader.setContext(BATCH, derivedBandWeightG(100, 833.3333333333334), 100, 15, UNIT);

    await inTenantContext(() => loader.load(BATCH));

    const sqls = query.mock.calls.map((call) => String(call[0]));
    expect(sqls.some((s) => s.includes('batches_v2'))).toBe(false);
    expect(sqls.some((s) => /\bfeeding_protocols\b/.test(s))).toBe(false);
  });
});
