/**
 * MortalityRecordedListener unit specs
 *
 * Proves the dead-listeners HIGH fix: the listener now consumes the
 * `@platform/event-contracts` `MortalityRecordedEvent` (the shape the producer
 * actually publishes through outbox → NATS) and fires the high-mortality alert
 * side effect — instead of subscribing to a dead in-process @OnEvent payload.
 *
 * London-school: every collaborator (repositories, event bus) is a test double
 * built from the shared @aquaculture/testing factory (repos) and a typed bus
 * interface (no casts on added lines).
 */
import { createMockRepository } from '@aquaculture/testing';
import { RedisService } from '@aquaculture/backend-common/redis';
import { createBaseEvent } from '@platform/event-contracts';
import type { IEventBus } from '@platform/event-bus';
import type { MortalityRecordedEvent } from '@platform/event-contracts';

import { Batch } from '../../../batch/entities/batch.entity';
import {
  MortalityRecord,
  MortalityCause,
} from '../../../batch/entities/mortality-record.entity';
import { TankBatch } from '../../../batch/entities/tank-batch.entity';
import { MortalityRecordedListener } from '../mortality-recorded.listener';
import { makeMockEventBus } from './make-mock-event-bus';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const BATCH_ID = '22222222-2222-4222-8222-222222222222';
const TANK_ID = '33333333-3333-4333-8333-333333333333';

type BusDouble = jest.Mocked<IEventBus>;

/**
 * Structural view of a published follow-up event. Extends the published `IEvent`
 * with the OPTIONAL flat fields the mortality follow-ups carry, so reads are
 * typed without any cast (an `IEvent` is assignable to this supertype-shaped
 * interface — every added field is optional).
 */
interface PublishedFollowUp {
  eventId?: string;
  eventType?: string;
  tenantId?: string;
  batchId?: string;
  alertType?: string;
  severity?: string;
  reason?: string;
  causationId?: string;
  correlationId?: string;
  recordedAt?: unknown;
}

function makeBus(): BusDouble {
  return makeMockEventBus();
}

/** Typed accessor for the recorded publish() arguments. */
function publishedEvents(bus: BusDouble): PublishedFollowUp[] {
  return bus.publish.mock.calls.map(([e]) => e);
}

/**
 * Minimal RedisService double for the inbound-idempotency claim/release path.
 * The listener only calls `setNx` (claim) and `del` (release); a Pick-typed
 * double (no unsafe casts) slots into the listener's narrowed
 * RedisService arg. `setNx` resolves true (claim won) by default.
 */
type RedisDouble = jest.Mocked<Pick<RedisService, 'setNx' | 'del'>>;

function makeRedis(setNxResult = true): RedisDouble {
  return {
    setNx: jest.fn().mockResolvedValue(setNxResult),
    del: jest.fn().mockResolvedValue(1),
  };
}

/**
 * Round-trip an event through JSON to reproduce the EXACT wire shape that
 * NatsEventBus.deserializeEvent yields — every Date field becomes an ISO string.
 * This is the faithful way to exercise the string-date wire-fidelity path
 * without an unsafe cast (the round-trip is real serialization).
 */
function toWireEvent(event: MortalityRecordedEvent): MortalityRecordedEvent {
  return JSON.parse(JSON.stringify(event)) as MortalityRecordedEvent;
}

function makeEvent(
  overrides: Partial<MortalityRecordedEvent> = {},
): MortalityRecordedEvent {
  return {
    ...createBaseEvent<MortalityRecordedEvent>('MortalityRecorded', TENANT_ID, {
      aggregateId: BATCH_ID,
      aggregateType: 'Batch',
    }),
    eventType: 'MortalityRecorded',
    userId: 'operator-1',
    batchId: BATCH_ID,
    tankId: TANK_ID,
    quantity: 10,
    reason: 'DISEASE',
    mortalityDate: '2026-06-10T08:00:00.000Z',
    newTotalMortality: 50,
    newMortalityRate: 1.0,
    ...overrides,
  };
}

function makeListener(opts: {
  bus?: BusDouble;
  batch?: Partial<Batch> | null;
  mortalityRecords?: Array<Partial<MortalityRecord>>;
  tankBatch?: Partial<TankBatch> | null;
  redis?: RedisDouble;
}): {
  listener: MortalityRecordedListener;
  batchRepo: jest.Mocked<import('typeorm').Repository<Batch>>;
  mortalityRepo: jest.Mocked<import('typeorm').Repository<MortalityRecord>>;
} {
  const batchRepo = createMockRepository<Batch>();
  batchRepo.findOne.mockResolvedValue(
    opts.batch === null ? null : ({ currentQuantity: 990, ...opts.batch } as Batch),
  );

  const mortalityRepo = createMockRepository<MortalityRecord>();
  mortalityRepo.find.mockResolvedValue(
    (opts.mortalityRecords ?? []) as MortalityRecord[],
  );

  const tankBatchRepo = createMockRepository<TankBatch>();
  tankBatchRepo.findOne.mockResolvedValue((opts.tankBatch ?? null) as TankBatch | null);

  // makeMockEventBus() returns a fully-typed jest.Mocked<IEventBus>, so it slots
  // straight into the optional EVENT_BUS constructor arg with no cast.
  const listener = new MortalityRecordedListener(
    batchRepo,
    mortalityRepo,
    tankBatchRepo,
    opts.bus,
    opts.redis,
  );
  return { listener, batchRepo, mortalityRepo };
}

describe('MortalityRecordedListener (NATS contract migration)', () => {
  it('subscribes to the MortalityRecorded NATS subject on init', async () => {
    const bus = makeBus();
    const { listener } = makeListener({ bus });

    await listener.onModuleInit();

    expect(bus.subscribeWildcard).toHaveBeenCalledWith('MortalityRecorded', listener);
    expect(listener.getEventType()).toBe('MortalityRecorded');
  });

  it('publishes a high-mortality alert when a single event breaches the singleEventQuantity threshold', async () => {
    const bus = makeBus();
    const { listener } = makeListener({
      bus,
      batch: { currentQuantity: 9000 },
      mortalityRecords: [
        { count: 250, recordDate: new Date(), cause: MortalityCause.DISEASE },
      ],
    });

    // 250 fish in one event ≥ singleEventQuantity (100) ⇒ critical (≥ 200).
    await listener.handle(makeEvent({ quantity: 250 }));

    const alerts = publishedEvents(bus).filter(
      (e) => e.eventType === 'MortalityAlertRaised',
    );
    expect(alerts.length).toBeGreaterThanOrEqual(1);
    const single = alerts.find((e) => e.alertType === 'single_event');
    expect(single).toBeDefined();
    expect(single).toMatchObject({
      tenantId: TENANT_ID,
      batchId: BATCH_ID,
      severity: 'critical',
      reason: 'DISEASE',
    });
  });

  it('publishes a critical cumulative-rate alert when newMortalityRate exceeds the critical threshold', async () => {
    const bus = makeBus();
    const { listener } = makeListener({
      bus,
      batch: { currentQuantity: 8000 },
      mortalityRecords: [],
    });

    // newMortalityRate 12% ≥ cumulativeRateCritical (10%).
    await listener.handle(makeEvent({ quantity: 5, newMortalityRate: 12 }));

    const cumulative = publishedEvents(bus).find(
      (e) =>
        e.eventType === 'MortalityAlertRaised' && e.alertType === 'cumulative_rate',
    );
    expect(cumulative).toBeDefined();
    expect(cumulative?.severity).toBe('critical');
  });

  it('fires NO alert for a benign low-mortality event', async () => {
    const bus = makeBus();
    const { listener } = makeListener({
      bus,
      batch: { currentQuantity: 10000 },
      mortalityRecords: [
        { count: 2, recordDate: new Date(), cause: MortalityCause.UNKNOWN },
      ],
    });

    await listener.handle(makeEvent({ quantity: 2, newMortalityRate: 0.4 }));

    const alerts = publishedEvents(bus).filter(
      (e) => e.eventType === 'MortalityAlertRaised',
    );
    expect(alerts).toHaveLength(0);
  });

  it('rejects an event with an invalid tenantId without touching the bus', async () => {
    const bus = makeBus();
    const { listener } = makeListener({ bus });

    await listener.handle(makeEvent({ tenantId: 'not-a-uuid' }));

    expect(bus.publish).not.toHaveBeenCalled();
  });

  it('swallows downstream errors so NATS does not redeliver a poison message', async () => {
    const bus = makeBus();
    const { listener, mortalityRepo } = makeListener({ bus });
    mortalityRepo.find.mockRejectedValue(new Error('db down'));

    await expect(listener.handle(makeEvent())).resolves.toBeUndefined();
  });

  it('evaluateMortalityAlerts is pure and returns breached alerts', () => {
    const { listener } = makeListener({});
    const alerts = listener.evaluateMortalityAlerts(
      makeEvent({ quantity: 100, newMortalityRate: 6 }),
      { todayRate: 1.5 },
    );
    const types = alerts.map((a) => a.type).sort();
    expect(types).toEqual(['cumulative_rate', 'daily_rate', 'single_event']);
  });

  // ── Blocker 1 / 7: each alert carries a DISTINCT, fresh eventId ──────────
  it('mints a DISTINCT fresh eventId per alert (not the trigger eventId)', async () => {
    const bus = makeBus();
    const { listener } = makeListener({
      bus,
      batch: { currentQuantity: 8000 },
      mortalityRecords: [],
    });

    // quantity 300 (single_event critical) + newMortalityRate 12 (cumulative
    // critical) → at least two alerts published from one trigger.
    const trigger = makeEvent({ quantity: 300, newMortalityRate: 12 });
    await listener.handle(trigger);

    const alerts = publishedEvents(bus).filter(
      (e) => e.eventType === 'MortalityAlertRaised',
    );
    expect(alerts.length).toBeGreaterThanOrEqual(2);

    const ids = alerts.map((e) => e.eventId);
    for (const id of ids) {
      expect(id).toBeDefined();
      // The msgID-collision bug: every alert reused trigger.eventId. Fixed.
      expect(id).not.toBe(trigger.eventId);
    }
    expect(new Set(ids).size).toBe(ids.length);

    for (const e of alerts) {
      expect(e.causationId).toBe(trigger.eventId);
      expect(e.correlationId).toBe(trigger.correlationId);
    }
  });

  // ── Blocker 5: wire-fidelity — mortalityDate arrives as an ISO STRING ────
  it('coerces a string mortalityDate (wire format) into a Date recordedAt', async () => {
    const bus = makeBus();
    const { listener } = makeListener({
      bus,
      batch: { currentQuantity: 8000 },
      mortalityRecords: [],
    });

    const wireEvent = toWireEvent(
      makeEvent({
        quantity: 300,
        newMortalityRate: 12,
        mortalityDate: '2026-06-10T08:00:00.000Z',
      }),
    );
    await listener.handle(wireEvent);

    const alert = publishedEvents(bus).find(
      (e) => e.eventType === 'MortalityAlertRaised',
    );
    // ORPHAN-111: recordedAt is now an ISO string on the wire.
    expect(typeof alert?.recordedAt).toBe('string');
    expect(alert?.recordedAt).toBe('2026-06-10T08:00:00.000Z');
  });

  // ── Inbound idempotency (symmetric with HarvestCompletedListener) ─────────
  it('claims the trigger eventId and skips re-processing on a duplicate delivery', async () => {
    const bus = makeBus();
    const redis = makeRedis(false); // setNx false → claim already taken (redelivery)
    const { listener } = makeListener({
      bus,
      batch: { currentQuantity: 8000 },
      redis,
    });

    // A breaching event that WOULD publish an alert is fully skipped on redelivery,
    // so no duplicate AlertHistory row is created downstream.
    await listener.handle(makeEvent({ quantity: 300, newMortalityRate: 12 }));

    expect(redis.setNx).toHaveBeenCalledTimes(1);
    expect(bus.publish).not.toHaveBeenCalled();
  });

  it('keeps the idempotency claim on a successful first delivery', async () => {
    const bus = makeBus();
    const redis = makeRedis(true);
    const { listener } = makeListener({
      bus,
      batch: { currentQuantity: 8000 },
      redis,
    });

    await listener.handle(makeEvent({ quantity: 300, newMortalityRate: 12 }));

    expect(redis.setNx).toHaveBeenCalledTimes(1);
    expect(redis.del).not.toHaveBeenCalled(); // released only on failure
    expect(bus.publish).toHaveBeenCalled();
  });

  it('releases the claim on failure so a redelivery can retry', async () => {
    const bus = makeBus();
    const redis = makeRedis(true);
    const { listener, mortalityRepo } = makeListener({
      bus,
      batch: { currentQuantity: 8000 },
      redis,
    });
    // Force the side-effecting path to throw inside the try.
    mortalityRepo.find.mockRejectedValueOnce(new Error('tenant query boom'));

    await listener.handle(makeEvent({ quantity: 300, newMortalityRate: 12 }));

    expect(redis.del).toHaveBeenCalledTimes(1);
  });
});
