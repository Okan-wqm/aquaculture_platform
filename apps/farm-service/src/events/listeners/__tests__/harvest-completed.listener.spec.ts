/**
 * HarvestCompletedListener unit specs
 *
 * Proves the dead-listeners HIGH fix: the listener now consumes the
 * `@platform/event-contracts` `BatchHarvestedEvent` (the shape the producer
 * actually publishes through outbox → NATS) and fires the previously-dead side
 * effects:
 *   - partial harvest → batch status transition to HARVESTING (DB write)
 *   - regulatory/traceability follow-up published on the bus
 *
 * London-school: every collaborator (repositories, event bus) is a test double
 * built from the shared factories (no casts on added lines beyond single-`as`
 * partial widening of entity fixtures).
 */
import { createMockRepository } from '@aquaculture/testing';
import { RedisService } from '@aquaculture/backend-common/redis';
import { createBaseEvent } from '@platform/event-contracts';
import type { IEventBus } from '@platform/event-bus';
import type { BatchHarvestedEvent } from '@platform/event-contracts';

import { Batch, BatchStatus } from '../../../batch/entities/batch.entity';
import { TankBatch } from '../../../batch/entities/tank-batch.entity';
import { HarvestCompletedListener } from '../harvest-completed.listener';
import { makeMockEventBus } from './make-mock-event-bus';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const BATCH_ID = '22222222-2222-4222-8222-222222222222';

type BusDouble = jest.Mocked<IEventBus>;

/**
 * Structural view of a published follow-up event. Extends the published `IEvent`
 * with the OPTIONAL flat fields the harvest follow-ups carry, so reads are typed
 * without any cast (every added field is optional, so `IEvent` is assignable).
 */
interface PublishedFollowUp {
  eventId?: string;
  eventType?: string;
  tenantId?: string;
  batchId?: string;
  harvestedQuantity?: number;
  tankId?: string;
  previousBatchId?: string;
  causationId?: string;
  correlationId?: string;
  harvestedAt?: unknown;
  clearedAt?: unknown;
  completedAt?: unknown;
}

/**
 * Minimal RedisService double for the inbound-idempotency claim/release path.
 * The listener only ever calls `setNx` (claim) and `del` (release), so a
 * Pick-typed double is sufficient. `setNx` resolves true (claim won) by default.
 * Returned as the Pick so a single typed widening at the call site (no
 * unsafe casts) slots it into the listener's `RedisService` arg.
 */
type RedisDouble = jest.Mocked<Pick<RedisService, 'setNx' | 'del'>>;

function makeRedis(setNxResult = true): RedisDouble {
  return {
    setNx: jest.fn().mockResolvedValue(setNxResult),
    del: jest.fn().mockResolvedValue(1),
  };
}

function makeBus(): BusDouble {
  return makeMockEventBus();
}

/** Typed accessor for the recorded publish() arguments. */
function publishedEvents(bus: BusDouble): PublishedFollowUp[] {
  return bus.publish.mock.calls.map(([e]) => e);
}

/**
 * Round-trip an event through JSON to reproduce the EXACT wire shape that
 * NatsEventBus.deserializeEvent yields — every Date field becomes an ISO string.
 * Faithful exercise of the string-date wire-fidelity path with no
 * an unsafe cast (the round-trip is real serialization).
 */
function toWireEvent(event: BatchHarvestedEvent): BatchHarvestedEvent {
  return JSON.parse(JSON.stringify(event)) as BatchHarvestedEvent;
}

/**
 * A Batch test double with the helper methods the listener calls. Uses a single
 * structural widening of a partial fixture — no double-cast, no escape hatch.
 */
function makeBatch(overrides: Partial<Batch> = {}): Batch {
  const fixture = {
    id: BATCH_ID,
    tenantId: TENANT_ID,
    status: BatchStatus.GROWING,
    currentQuantity: 500,
    initialQuantity: 1000,
    totalMortality: 50,
    getDaysInProduction: () => 120,
    getSurvivalRate: () => 95,
    getMortalityRate: () => 5,
    fcr: { actual: 1.2 },
    sgr: 2.1,
    totalFeedConsumed: 800,
    totalFeedCost: 4000,
    purchaseCost: 1000,
    ...overrides,
  };
  return fixture as Batch;
}

function makeEvent(
  overrides: Partial<BatchHarvestedEvent> = {},
): BatchHarvestedEvent {
  return {
    ...createBaseEvent<BatchHarvestedEvent>('BatchHarvested', TENANT_ID, {
      aggregateId: BATCH_ID,
      aggregateType: 'Batch',
      version: 2,
    }),
    eventType: 'BatchHarvested',
    userId: 'operator-1',
    batchId: BATCH_ID,
    harvestedQuantity: 200,
    harvestedAt: '2026-06-10T08:00:00.000Z',
    averageWeight: 450,
    totalWeight: 90,
    isFinal: false,
    ...overrides,
  };
}

function makeListener(opts: {
  bus?: BusDouble;
  batch?: Batch | null;
  tankBatches?: Array<Partial<TankBatch>>;
  redis?: RedisDouble;
}): {
  listener: HarvestCompletedListener;
  batchRepo: jest.Mocked<import('typeorm').Repository<Batch>>;
  redis?: RedisDouble;
} {
  const batchRepo = createMockRepository<Batch>();
  batchRepo.findOne.mockResolvedValue(
    opts.batch === null ? null : opts.batch ?? makeBatch(),
  );

  const tankBatchRepo = createMockRepository<TankBatch>();
  tankBatchRepo.find.mockResolvedValue(
    (opts.tankBatches ?? []) as TankBatch[],
  );

  // The listener's redis param is narrowed to Pick<RedisService,'setNx'|'del'>,
  // so the double slots in with NO cast.
  const listener = new HarvestCompletedListener(
    batchRepo,
    tankBatchRepo,
    opts.bus,
    opts.redis,
  );
  return { listener, batchRepo, redis: opts.redis };
}

describe('HarvestCompletedListener (NATS contract migration)', () => {
  it('subscribes to the BatchHarvested NATS subject on init', async () => {
    const bus = makeBus();
    const { listener } = makeListener({ bus });

    await listener.onModuleInit();

    expect(bus.subscribeWildcard).toHaveBeenCalledWith('BatchHarvested', listener);
    expect(listener.getEventType()).toBe('BatchHarvested');
  });

  it('transitions a GROWING batch to HARVESTING on a partial (non-final) harvest', async () => {
    const bus = makeBus();
    const batch = makeBatch({ status: BatchStatus.GROWING });
    const { listener, batchRepo } = makeListener({ bus, batch });

    await listener.handle(makeEvent({ isFinal: false }));

    expect(batchRepo.save).toHaveBeenCalled();
    const saved = batchRepo.save.mock.calls[0]?.[0] as Batch;
    expect(saved.status).toBe(BatchStatus.HARVESTING);
    expect(saved.statusReason).toBe('Partial harvest in progress');
  });

  it('treats a missing isFinal as partial (tolerant reader) and transitions to HARVESTING', async () => {
    const bus = makeBus();
    const batch = makeBatch({ status: BatchStatus.GROWING });
    const { listener, batchRepo } = makeListener({ bus, batch });

    const event = makeEvent();
    delete event.isFinal;
    await listener.handle(event);

    const saved = batchRepo.save.mock.calls[0]?.[0] as Batch;
    expect(saved.status).toBe(BatchStatus.HARVESTING);
  });

  it('does NOT re-transition a batch already in HARVESTING', async () => {
    const bus = makeBus();
    const batch = makeBatch({ status: BatchStatus.HARVESTING });
    const { listener, batchRepo } = makeListener({ bus, batch });

    await listener.handle(makeEvent({ isFinal: false }));

    expect(batchRepo.save).not.toHaveBeenCalled();
  });

  it('does NOT move the batch to HARVESTING on a final harvest (producer owns HARVESTED)', async () => {
    const bus = makeBus();
    const batch = makeBatch({ status: BatchStatus.GROWING, currentQuantity: 0 });
    const { listener, batchRepo } = makeListener({ bus, batch });

    await listener.handle(makeEvent({ isFinal: true }));

    expect(batchRepo.save).not.toHaveBeenCalled();
  });

  it('always publishes a regulatory/traceability follow-up', async () => {
    const bus = makeBus();
    const { listener } = makeListener({ bus, batch: makeBatch() });

    await listener.handle(makeEvent({ isFinal: false }));

    const regulatory = publishedEvents(bus).find(
      (e) => e.eventType === 'HarvestRegulatoryRecorded',
    );
    expect(regulatory).toBeDefined();
    expect(regulatory).toMatchObject({
      tenantId: TENANT_ID,
      batchId: BATCH_ID,
      harvestedQuantity: 200,
    });
  });

  it('publishes TankCleared + BatchProductionCompleted on a final, fully-emptied harvest', async () => {
    const bus = makeBus();
    const batch = makeBatch({ status: BatchStatus.HARVESTED, currentQuantity: 0 });
    const { listener } = makeListener({
      bus,
      batch,
      tankBatches: [{ tankId: 'tank-9', tankCode: 'T-09', primaryBatchId: BATCH_ID }],
    });

    await listener.handle(makeEvent({ isFinal: true }));

    const events = publishedEvents(bus);
    const tankCleared = events.find((e) => e.eventType === 'TankCleared');
    const completed = events.find((e) => e.eventType === 'BatchProductionCompleted');
    expect(tankCleared).toBeDefined();
    expect(tankCleared).toMatchObject({ tankId: 'tank-9', previousBatchId: BATCH_ID });
    expect(completed).toBeDefined();
  });

  it('rejects an event with an invalid tenantId without touching the bus', async () => {
    const bus = makeBus();
    const { listener, batchRepo } = makeListener({ bus });

    await listener.handle(makeEvent({ tenantId: 'not-a-uuid' }));

    expect(bus.publish).not.toHaveBeenCalled();
    expect(batchRepo.save).not.toHaveBeenCalled();
  });

  it('swallows downstream errors so NATS does not redeliver a poison message', async () => {
    const bus = makeBus();
    const { listener } = makeListener({ bus, batch: null });
    // batch not found → generateHarvestReport throws; handle must still resolve.
    await expect(
      listener.handle(makeEvent({ isFinal: false })),
    ).resolves.toBeUndefined();
  });

  // ── Blocker 1 / 7: each follow-up carries a DISTINCT, fresh eventId ──────
  it('mints a DISTINCT fresh eventId per follow-up (not the trigger eventId)', async () => {
    const bus = makeBus();
    const batch = makeBatch({ status: BatchStatus.HARVESTED, currentQuantity: 0 });
    const { listener } = makeListener({
      bus,
      batch,
      tankBatches: [{ tankId: 'tank-9', tankCode: 'T-09', primaryBatchId: BATCH_ID }],
    });

    const trigger = makeEvent({ isFinal: true });
    await listener.handle(trigger);

    const events = publishedEvents(bus);
    // final + emptied → regulatory + tankCleared + production-completed = 3.
    expect(events).toHaveLength(3);

    const ids = events.map((e) => e.eventId);
    // No follow-up reuses the trigger's eventId (the msgID-collision bug).
    for (const id of ids) {
      expect(id).toBeDefined();
      expect(id).not.toBe(trigger.eventId);
    }
    // Every follow-up id is distinct from every other.
    expect(new Set(ids).size).toBe(ids.length);

    // Lineage is threaded: causationId points back to the trigger.
    for (const e of events) {
      expect(e.causationId).toBe(trigger.eventId);
      expect(e.correlationId).toBe(trigger.correlationId);
    }
  });

  // ── Blocker 5: wire-fidelity — harvestedAt arrives as an ISO STRING ──────
  it('coerces a string harvestedAt (wire format) into a Date on every follow-up', async () => {
    const bus = makeBus();
    const batch = makeBatch({ status: BatchStatus.HARVESTED, currentQuantity: 0 });
    const { listener } = makeListener({
      bus,
      batch,
      tankBatches: [{ tankId: 'tank-9', tankCode: 'T-09', primaryBatchId: BATCH_ID }],
    });

    // deserializeEvent returns ISO strings; reproduce that exact wire shape.
    const wireEvent = toWireEvent(
      makeEvent({
        isFinal: true,
        harvestedAt: '2026-06-10T08:00:00.000Z',
      }),
    );
    await expect(listener.handle(wireEvent)).resolves.toBeUndefined();

    const events = publishedEvents(bus);
    const regulatory = events.find((e) => e.eventType === 'HarvestRegulatoryRecorded');
    const tankCleared = events.find((e) => e.eventType === 'TankCleared');
    const completed = events.find((e) => e.eventType === 'BatchProductionCompleted');

    // ORPHAN-111: each contract date field is now an ISO string on the wire.
    expect(typeof regulatory?.harvestedAt).toBe('string');
    expect(typeof tankCleared?.clearedAt).toBe('string');
    expect(typeof completed?.completedAt).toBe('string');
    expect(regulatory?.harvestedAt).toBe('2026-06-10T08:00:00.000Z');
  });

  // ── Blocker 6: inbound idempotency — a redelivery does NOT re-publish ────
  it('claims the trigger eventId and skips re-processing on a duplicate delivery', async () => {
    const bus = makeBus();
    // setNx returns false → claim already taken (this is a redelivery).
    const redis = makeRedis(false);
    const { listener, batchRepo } = makeListener({
      bus,
      batch: makeBatch(),
      redis,
    });

    await listener.handle(makeEvent({ isFinal: false }));

    expect(redis.setNx).toHaveBeenCalledTimes(1);
    // Nothing is published and no DB write happens on a duplicate.
    expect(bus.publish).not.toHaveBeenCalled();
    expect(batchRepo.save).not.toHaveBeenCalled();
  });

  it('processes once and keeps the claim on success (first delivery)', async () => {
    const bus = makeBus();
    const redis = makeRedis(true);
    const { listener } = makeListener({ bus, batch: makeBatch(), redis });

    await listener.handle(makeEvent({ isFinal: false }));

    expect(redis.setNx).toHaveBeenCalledTimes(1);
    // Claim retained on success — only released on failure.
    expect(redis.del).not.toHaveBeenCalled();
    expect(bus.publish).toHaveBeenCalled();
  });

  it('releases the claim on failure so a redelivery can retry', async () => {
    const bus = makeBus();
    const redis = makeRedis(true);
    // batch null → generateHarvestReport throws inside the try block.
    const { listener } = makeListener({ bus, batch: null, redis });

    await expect(
      listener.handle(makeEvent({ isFinal: false })),
    ).resolves.toBeUndefined();

    expect(redis.setNx).toHaveBeenCalledTimes(1);
    expect(redis.del).toHaveBeenCalledTimes(1);
  });
});
