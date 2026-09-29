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
import { createBaseEvent, validateEventBySubject } from '@platform/event-contracts';
import type { IEventBus } from '@platform/event-bus';
import type { MortalityRecordedEvent } from '@platform/event-contracts';

import { Batch } from '../../../batch/entities/batch.entity';
import { MortalityRecord, MortalityCause } from '../../../batch/entities/mortality-record.entity';
import { TankBatch } from '../../../batch/entities/tank-batch.entity';
import type {
  DailyMortality,
  MortalityAlertContextReader,
} from '../mortality-alert-context.reader';
import { MortalityRecordedListener } from '../mortality-recorded.listener';
import { makeMockEventBus } from './make-mock-event-bus';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const BATCH_ID = '22222222-2222-4222-8222-222222222222';
const TANK_ID = '33333333-3333-4333-8333-333333333333';
const SITE_ID = '44444444-4444-4444-8444-444444444444';

/** The alert-context reader double (its real queries run in the Postgres spec). */
type ContextDouble = jest.Mocked<Pick<MortalityAlertContextReader, 'dailyMortality' | 'siteOf'>>;

function quietDay(overrides: Partial<DailyMortality> = {}): DailyMortality {
  return {
    day: '2026-06-10',
    todayCount: 0,
    todayRate: 0,
    weeklyAverage: 0,
    trend: 'stable',
    ...overrides,
  };
}

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
  siteId?: string;
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

function makeEvent(overrides: Partial<MortalityRecordedEvent> = {}): MortalityRecordedEvent {
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
  daily?: DailyMortality;
  siteId?: string | null;
}): {
  listener: MortalityRecordedListener;
  batchRepo: jest.Mocked<import('typeorm').Repository<Batch>>;
  mortalityRepo: jest.Mocked<import('typeorm').Repository<MortalityRecord>>;
  alertContext: ContextDouble;
} {
  const batchRepo = createMockRepository<Batch>();
  batchRepo.findOne.mockResolvedValue(
    opts.batch === null ? null : ({ currentQuantity: 990, ...opts.batch } as Batch),
  );

  const mortalityRepo = createMockRepository<MortalityRecord>();
  mortalityRepo.find.mockResolvedValue((opts.mortalityRecords ?? []) as MortalityRecord[]);

  const tankBatchRepo = createMockRepository<TankBatch>();
  tankBatchRepo.findOne.mockResolvedValue((opts.tankBatch ?? null) as TankBatch | null);

  // makeMockEventBus() returns a fully-typed jest.Mocked<IEventBus>, so it slots
  // straight into the optional EVENT_BUS constructor arg with no cast.
  const alertContext: ContextDouble = {
    dailyMortality: jest.fn().mockResolvedValue(opts.daily ?? quietDay()),
    siteOf: jest.fn().mockResolvedValue(opts.siteId === undefined ? SITE_ID : opts.siteId),
  };

  const listener = new MortalityRecordedListener(
    batchRepo,
    mortalityRepo,
    tankBatchRepo,
    alertContext,
    opts.bus,
    opts.redis,
  );
  return { listener, batchRepo, mortalityRepo, alertContext };
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
      mortalityRecords: [{ count: 250, recordDate: new Date(), cause: MortalityCause.DISEASE }],
    });

    // 250 fish in one event ≥ singleEventQuantity (100) ⇒ critical (≥ 200).
    await listener.handle(makeEvent({ quantity: 250 }));

    const alerts = publishedEvents(bus).filter((e) => e.eventType === 'MortalityAlertRaised');
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

  it('publishes a critical cumulative-rate alert when this record CROSSES the critical threshold', async () => {
    const bus = makeBus();
    const { listener } = makeListener({
      bus,
      batch: { currentQuantity: 8000 },
      mortalityRecords: [],
    });

    // 10 of 50 total deaths: rate before = 12 · 40/50 = 9.6% < 10% ≤ 12% now.
    await listener.handle(makeEvent({ quantity: 10, newMortalityRate: 12 }));

    const cumulative = publishedEvents(bus).find(
      (e) => e.eventType === 'MortalityAlertRaised' && e.alertType === 'cumulative_rate',
    );
    expect(cumulative).toBeDefined();
    expect(cumulative?.severity).toBe('critical');
  });

  it('fires NO alert for a benign low-mortality event', async () => {
    const bus = makeBus();
    const { listener } = makeListener({
      bus,
      batch: { currentQuantity: 10000 },
      mortalityRecords: [{ count: 2, recordDate: new Date(), cause: MortalityCause.UNKNOWN }],
    });

    await listener.handle(makeEvent({ quantity: 2, newMortalityRate: 0.4 }));

    const alerts = publishedEvents(bus).filter((e) => e.eventType === 'MortalityAlertRaised');
    expect(alerts).toHaveLength(0);
  });

  it('rejects an event with an invalid tenantId without touching the bus', async () => {
    const bus = makeBus();
    const { listener } = makeListener({ bus });

    await listener.handle(makeEvent({ tenantId: 'not-a-uuid' }));

    expect(bus.publish).not.toHaveBeenCalled();
  });

  it('reports a downstream failure as a retry outcome (bounded by the bus, then dead-lettered)', async () => {
    const bus = makeBus();
    const { listener, alertContext } = makeListener({ bus });
    alertContext.dailyMortality.mockRejectedValue(new Error('db down'));

    await expect(listener.handle(makeEvent())).resolves.toEqual(
      expect.objectContaining({ kind: 'retry' }),
    );
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

    const alerts = publishedEvents(bus).filter((e) => e.eventType === 'MortalityAlertRaised');
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

    const alert = publishedEvents(bus).find((e) => e.eventType === 'MortalityAlertRaised');
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
    const { listener, alertContext } = makeListener({
      bus,
      batch: { currentQuantity: 8000 },
      redis,
    });
    // Force the side-effecting path to throw inside the try.
    alertContext.dailyMortality.mockRejectedValueOnce(new Error('tenant query boom'));

    await listener.handle(makeEvent({ quantity: 300, newMortalityRate: 12 }));

    expect(redis.del).toHaveBeenCalledTimes(1);
  });

  // ── FARM-HIGH-334: daily rate from the stored-day window ──────────────────
  it('fires a daily-rate alert from the day the triggering record is stored under', async () => {
    // SCENARIO: today's deaths are 1.2% of the population at the start of the day.
    // EXPECTS: a critical daily_rate alert (the old midnight filter saw 0 deaths).
    const bus = makeBus();
    const { listener } = makeListener({
      bus,
      daily: quietDay({ todayCount: 12, todayRate: 1.2 }),
    });

    await listener.handle(makeEvent({ quantity: 12, newMortalityRate: 0.5 }));

    const daily = publishedEvents(bus).find(
      (e) => e.eventType === 'MortalityAlertRaised' && e.alertType === 'daily_rate',
    );
    expect(daily).toMatchObject({ severity: 'critical' });
  });

  it('does not re-fire the cumulative alert for a batch already above the threshold', async () => {
    // SCENARIO: a batch at 10.8% cumulative records 5 more deaths (now 12%).
    // EXPECTS: no cumulative_rate alert — the crossing happened earlier; late-cycle
    //          5–10% mortality must not page on every record.
    const bus = makeBus();
    const { listener } = makeListener({ bus });

    await listener.handle(makeEvent({ quantity: 5, newTotalMortality: 50, newMortalityRate: 12 }));

    const cumulative = publishedEvents(bus).filter(
      (e) => e.eventType === 'MortalityAlertRaised' && e.alertType === 'cumulative_rate',
    );
    expect(cumulative).toHaveLength(0);
  });

  it('names the tank site on every raised alert (ALERT-MEDIUM-007)', async () => {
    // SCENARIO: a breaching record in a tank of a known site.
    // EXPECTS: each MortalityAlertRaised carries the site, so its managers are paged.
    const bus = makeBus();
    const { listener } = makeListener({ bus, siteId: SITE_ID });

    await listener.handle(makeEvent({ quantity: 300, newMortalityRate: 12 }));

    const alerts = publishedEvents(bus).filter((e) => e.eventType === 'MortalityAlertRaised');
    expect(alerts.length).toBeGreaterThan(0);
    for (const alert of alerts) expect(alert.siteId).toBe(SITE_ID);
  });

  it('raises alerts the consumer-side bus schema accepts, with the site (ALERT-MEDIUM-007)', async () => {
    // SCENARIO: alert-engine's bus validates MortalityAlertRaised by subject before
    //           its handler runs; the new siteId must be a declared field.
    // EXPECTS: every raised alert, in its wire form, is valid — a field the schema
    //          does not know would dead-letter the alarm instead of paging anyone.
    const bus = makeBus();
    const { listener } = makeListener({ bus, siteId: SITE_ID });

    await listener.handle(makeEvent({ quantity: 300, newMortalityRate: 12 }));

    const alerts = publishedEvents(bus).filter((e) => e.eventType === 'MortalityAlertRaised');
    expect(alerts.length).toBeGreaterThan(0);
    for (const alert of alerts) {
      const wire: unknown = JSON.parse(JSON.stringify(alert));
      expect(validateEventBySubject(`events.${TENANT_ID}.MortalityAlertRaised`, wire)).toEqual({
        valid: true,
      });
    }
  });

  it('omits the site when the tank resolves to none', async () => {
    const bus = makeBus();
    const { listener } = makeListener({ bus, siteId: null });

    await listener.handle(makeEvent({ quantity: 300, newMortalityRate: 12 }));

    const alert = publishedEvents(bus).find((e) => e.eventType === 'MortalityAlertRaised');
    expect(alert).toBeDefined();
    expect(alert?.siteId).toBeUndefined();
  });
});
