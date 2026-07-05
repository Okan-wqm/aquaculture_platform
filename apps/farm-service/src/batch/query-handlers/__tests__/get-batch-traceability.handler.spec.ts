/**
 * GetBatchTraceabilityHandler — composition + aggregation semantics (Phase 6).
 *
 * runInTenantRead is mocked to run the callback against a fake EntityManager;
 * the QueryBus double returns a canned event timeline (the handler must reuse
 * the existing batchHistory assembler, not re-derive events).
 */
import { DataSource, EntityManager } from 'typeorm';
import { QueryBus } from '@platform/cqrs';

const runInTenantRead = jest.fn();

jest.mock('@aquaculture/backend-common/database', () => ({
  ...jest.requireActual('@aquaculture/backend-common/database'),
  runInTenantRead: (ds: unknown, schema: string, tenantId: string, cb: unknown) =>
    runInTenantRead(ds, schema, tenantId, cb),
}));

import { GetBatchTraceabilityHandler } from '../get-batch-traceability.handler';
import { GetBatchTraceabilityQuery } from '../../queries/get-batch-traceability.query';
import { Batch } from '../../entities/batch.entity';
import { BatchLocation } from '../../entities/batch-location.entity';
import { Tank } from '../../../tank/entities/tank.entity';
import { Feed } from '../../../feed/entities/feed.entity';
import { FeedingProtocol } from '../../../feed/entities/feeding-protocol.entity';
import { FeedingRecord } from '../../../feeding/entities/feeding-record.entity';

function mock<T>(impl: Partial<T>): T {
  return impl as T;
}

const TENANT = '11111111-1111-4111-8111-111111111111';
const BATCH = '22222222-2222-4222-8222-222222222222';
const T1 = 'aaaaaaa1-0000-4000-8000-000000000001';
const T2 = 'aaaaaaa2-0000-4000-8000-000000000002';

const D0 = new Date('2026-06-01T00:00:00.000Z');
const D10 = new Date('2026-06-11T00:00:00.000Z');

/** Chainable QB stub: every builder method returns itself; raw getters canned. */
function qbStub(rawMany: unknown[], rawOne: unknown): Record<string, jest.Mock> {
  const qb: Record<string, jest.Mock> = {};
  for (const m of ['select', 'addSelect', 'where', 'andWhere', 'groupBy']) {
    qb[m] = jest.fn().mockReturnValue(qb);
  }
  qb['getRawMany'] = jest.fn().mockResolvedValue(rawMany);
  qb['getRawOne'] = jest.fn().mockResolvedValue(rawOne);
  return qb;
}

function makeManager(): EntityManager {
  const batch = mock<Batch>({
    id: BATCH,
    batchNumber: 'B-1',
    status: 'active' as Batch['status'],
    createdAt: new Date('2026-05-30T00:00:00.000Z'), // row-creation ≠ stocking
    stockedAt: D0,
    getDaysInProduction: () => 34,
    initialQuantity: 1000,
    currentQuantity: 900,
    protocolId: 'p-1',
    weight: mock<Batch['weight']>({
      initial: { avgWeight: 50, totalBiomass: 50, measuredAt: D0 },
      theoretical: { avgWeight: 120, totalBiomass: 108, lastCalculatedAt: D10, basedOnFCR: 1.2 },
    }),
    fcr: mock<Batch['fcr']>({ actual: 1.2 }),
    species: mock<Batch['species']>({ commonName: 'Salmon' }),
  });
  const locations = [
    mock<BatchLocation>({ tankId: T1, quantity: 1000, avgWeight: 50, movedAt: D0, exitedAt: D10, isCurrentLocation: false }),
    mock<BatchLocation>({ tankId: T2, quantity: 950, avgWeight: 90, movedAt: D10, exitedAt: undefined, isCurrentLocation: true }),
  ];
  const findOne = jest.fn().mockImplementation((entity: unknown) => {
    if (entity === Batch) return Promise.resolve(batch);
    if (entity === FeedingProtocol) return Promise.resolve({ name: 'Std Protocol' });
    return Promise.resolve(null);
  });
  const find = jest.fn().mockImplementation((entity: unknown) => {
    if (entity === BatchLocation) return Promise.resolve(locations);
    if (entity === Tank) {
      return Promise.resolve([
        { id: T1, name: 'Tank 1', code: 'T-1' },
        { id: T2, name: 'Tank 2', code: 'T-2' },
      ]);
    }
    if (entity === Feed) return Promise.resolve([{ id: 'f-1', name: 'Pellet 3mm', code: 'P3' }]);
    return Promise.resolve([]);
  });
  const createQueryBuilder = jest.fn().mockImplementation((entity: unknown) => {
    if (entity === FeedingRecord) {
      return qbStub([{ feedId: 'f-1', totalKg: '100.505', totalCost: '250.129' }], undefined);
    }
    // water aggregate
    return qbStub([], { tmin: '10', tavg: '12.34', tmax: '14', cnt: '5' });
  });
  return mock<EntityManager>({ findOne, find, createQueryBuilder });
}

function makeHandler(events: unknown[]): GetBatchTraceabilityHandler {
  const queryBus = mock<QueryBus>({ execute: jest.fn().mockResolvedValue(events) });
  return new GetBatchTraceabilityHandler(mock<DataSource>({}), queryBus);
}

beforeEach(() => {
  runInTenantRead.mockReset();
  runInTenantRead.mockImplementation(
    async (_ds, _s, _t, cb: (qr: { manager: EntityManager }) => Promise<unknown>) =>
      cb({ manager: makeManager() }),
  );
});

describe('GetBatchTraceabilityHandler', () => {
  it('composes summary + residencies + feed + water + reused event timeline', async () => {
    const events = [{ id: 'e-1', eventType: 'created' }];
    const handler = makeHandler(events);

    const result = await handler.execute(new GetBatchTraceabilityQuery(TENANT, BATCH));

    // Summary numbers
    expect(result.summary.batchNumber).toBe('B-1');
    // Canonical stocking date + entity-SSoT DIP — NOT the row-creation time.
    expect(result.summary.stockedAt).toEqual(D0);
    expect(result.summary.daysInProduction).toBe(34);
    expect(result.summary.speciesName).toBe('Salmon');
    expect(result.summary.protocolName).toBe('Std Protocol');
    expect(result.summary.survivalRatePercent).toBe(90);
    expect(result.summary.initialAvgWeightG).toBe(50);
    expect(result.summary.currentAvgWeightG).toBe(120);
    expect(result.summary.fcrActual).toBe(1.2);
    expect(result.summary.totalFeedKg).toBe(100.51); // SUM rounded to 2dp
    expect(result.summary.totalFeedCost).toBe(250.13);

    // Residencies: closed first interval (10 days) + open current one
    expect(result.residencies).toHaveLength(2);
    const [first, second] = result.residencies;
    if (!first || !second) {
      throw new Error('expected two residencies');
    }
    expect(first).toMatchObject({
      tankId: T1,
      tankName: 'Tank 1',
      tankCode: 'T-1',
      isCurrent: false,
      durationDays: 10,
      quantityAtEntry: 1000,
    });
    expect(second.isCurrent).toBe(true);
    expect(second.exitedAt).toBeUndefined();
    expect(second.durationDays).toBeGreaterThan(0);

    // Water aggregate rounded to 1dp
    expect(first.water).toEqual({
      temperatureMinC: 10,
      temperatureAvgC: 12.3,
      temperatureMaxC: 14,
      measurementCount: 5,
    });

    // Feed names resolved through the single Feed lookup
    expect(result.feedTotals).toEqual([
      { feedId: 'f-1', feedName: 'Pellet 3mm', feedCode: 'P3', totalKg: 100.51, totalCost: 250.13 },
    ]);
    expect(first.feedTotalKg).toBe(100.51);

    // Events come from the existing batchHistory assembler via the bus
    expect(result.events).toBe(events);
  });

  it('throws NotFound for an unknown batch', async () => {
    runInTenantRead.mockImplementation(
      async (_ds, _s, _t, cb: (qr: { manager: EntityManager }) => Promise<unknown>) =>
        cb({
          manager: mock<EntityManager>({
            findOne: jest.fn().mockResolvedValue(null),
            find: jest.fn().mockResolvedValue([]),
          }),
        }),
    );
    const handler = makeHandler([]);

    await expect(handler.execute(new GetBatchTraceabilityQuery(TENANT, BATCH))).rejects.toThrow(
      'bulunamadı',
    );
  });
});
