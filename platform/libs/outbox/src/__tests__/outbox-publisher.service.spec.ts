/**
 * OutboxPublisher unit tests (PROC-MEDIUM-008 — closed by PR-39)
 *
 * # Why this file exists
 *
 * `@platform/outbox` had ZERO test coverage anywhere in the monorepo
 * prior to this PR. The library was migrated INTO from per-service
 * local outbox workers (messaging-service in particular, see
 * messaging-outbox.module.ts:20-25) but the test surface didn't follow.
 * Surfaced as a gap during PR-28 (PROC-MEDIUM-007 ratchet §30).
 *
 * # What this spec pins
 *
 * The OutboxPublisher.enqueue() contract is the LOAD-BEARING boundary
 * between command handlers and the at-least-once delivery pipeline.
 * Three classes of invariant must hold for every call:
 *
 *   1. Validation — eventType must be PascalCase, tenantId must be a
 *      UUID. Both become NATS subject segments downstream; malformed
 *      values inject wildcards (`*`, `>`) or cross-tenant leak via
 *      Socket.IO room collision. Tests cover EVERY branch of the
 *      validator (empty string, lowercase, dot-injection, newline,
 *      etc.).
 *
 *   2. Transaction binding — the `manager` arg MUST come from a
 *      queryRunner with an active transaction. Otherwise the outbox
 *      INSERT runs in autocommit mode and silently violates the
 *      atomicity guarantee (domain write rolls back → orphan outbox
 *      row lives forever, fired even though the user-facing operation
 *      failed).
 *
 *   3. Persistence shape — payload is JSON round-tripped (drops class
 *      metadata, becomes JSONB-safe), retryCount=0, publishedAt=null,
 *      isDeadLettered=false, and the configured idempotencyKey /
 *      aggregateId pass through. The `manager.save(entityClass, …)`
 *      call site is the ONLY persistence hop; a regression here is a
 *      data-loss bug.
 *
 * # What this spec does NOT cover (yet)
 *
 *   - OutboxWorkerService — polling, leasing, NATS publish, retry +
 *     backoff. Substantially larger surface; deserves its own spec.
 *     Tracked as a follow-up. This spec proves the publisher-side
 *     contract — the per-service usage that motivated this PR
 *     (PROC-MEDIUM-008) is unblocked even though worker coverage
 *     is still missing.
 *   - OutboxNotifyListenerService — pg LISTEN/NOTIFY reconnection.
 *     Connection-pool dependent; integration-style spec needed.
 *   - OutboxMetricsService — Prometheus counters, low-risk pure logic.
 */

import type { BaseEvent } from '@platform/event-contracts';
import { EntityManager, type QueryRunner } from 'typeorm';

import { OutboxEntityBase } from '../outbox-entity.base';
import { OutboxPublisher } from '../outbox-publisher.service';
import {
  OUTBOX_DELIVERY_POLICY_FIELD,
  OUTBOX_ROUTING_SCOPE_FIELD,
  OUTBOX_SECURITY_RECOVERY_POLICY,
  OUTBOX_SYSTEM_TENANT_ID,
} from '../outbox-routing';

// Concrete test entity. Subclassing OutboxEntityBase lets the publisher
// tag its INSERT with the right TypeORM metadata target — the same
// shape every consuming service uses. `declare` keeps the TS-only narrowing
// without emitting an `override` keyword (which strict-tsc rejects in
// the ambient context that `declare` introduces).
class TestOutbox extends OutboxEntityBase {
  declare id: string;
}

interface SaveCall {
  entityClass: typeof TestOutbox;
  payload: Record<string, unknown>;
}

interface InsertCall {
  entityClass: typeof TestOutbox;
  payload: Record<string, unknown>;
}

/**
 * Minimal EntityManager test double. Satisfies what the publisher
 * actually touches: `save(entityClass, row)` + the `queryRunner`
 * accessor. The transaction-active assertion in the publisher reads
 * `manager.queryRunner.isTransactionActive`; the double exposes a
 * mutable boolean so each test sets the precondition explicitly.
 */
function makeManager(opts: { isTransactionActive: boolean; hasQueryRunner?: boolean }): {
  manager: EntityManager;
  saveCalls: SaveCall[];
  insertCalls: InsertCall[];
} {
  const saveCalls: SaveCall[] = [];
  const insertCalls: InsertCall[] = [];
  const queryRunner =
    opts.hasQueryRunner === false
      ? undefined
      : ({ isTransactionActive: opts.isTransactionActive } as Partial<QueryRunner>);
  const queryBuilder = {
    insert: jest.fn(),
    into: jest.fn(),
    values: jest.fn(),
    orIgnore: jest.fn(),
    execute: jest.fn(),
  };
  queryBuilder.insert.mockReturnValue(queryBuilder);
  queryBuilder.into.mockImplementation((entityClass: typeof TestOutbox) => {
    insertCalls.push({ entityClass, payload: {} });
    return queryBuilder;
  });
  queryBuilder.values.mockImplementation((row: Record<string, unknown>) => {
    const call = insertCalls.at(-1);
    if (!call) throw new Error('values called before into');
    call.payload = row;
    return queryBuilder;
  });
  queryBuilder.orIgnore.mockReturnValue(queryBuilder);
  queryBuilder.execute.mockResolvedValue({ identifiers: [], generatedMaps: [], raw: [] });

  const manager = Object.assign(Object.create(EntityManager.prototype) as EntityManager, {
    queryRunner: queryRunner as QueryRunner | undefined,
    createQueryBuilder: jest.fn().mockReturnValue(queryBuilder),
    save: jest
      .fn()
      .mockImplementation((entityClass: typeof TestOutbox, row: Record<string, unknown>) => {
        saveCalls.push({ entityClass, payload: row });
        return Promise.resolve(row);
      }),
  });
  return { manager, saveCalls, insertCalls };
}

const VALID_TENANT = '11111111-1111-4111-8111-111111111111';

function firstSaveCall(saveCalls: readonly SaveCall[]): SaveCall {
  const call = saveCalls.at(0);
  if (!call) {
    throw new Error('Expected one outbox save call');
  }
  return call;
}

// BaseEvent.eventId is a branded `string & { __brand }` type — the
// brand is enforced at the constructor boundary in production
// (createBaseEvent), but the publisher itself never reads the brand
// structurally. Loosen the override type so test fixtures don't have
// to import the brand-tag generator from the events lib.
type EventOverrides = Partial<{
  eventId: string;
  eventType: string;
  timestamp: string;
  tenantId: string;
  version: number;
}>;

function makeEvent(overrides: EventOverrides = {}): BaseEvent {
  return {
    eventId: 'evt-test-001',
    eventType: 'TestEventOccurred',
    timestamp: '2026-04-27T00:00:00.000Z',
    tenantId: VALID_TENANT,
    version: 1,
    ...overrides,
  } as unknown as BaseEvent;
}

describe('OutboxPublisher', () => {
  let publisher: OutboxPublisher;

  beforeEach(() => {
    publisher = new OutboxPublisher(TestOutbox);
  });

  describe('enqueue() — happy path', () => {
    it('persists the event with default values when called inside an active transaction', async () => {
      const { manager, saveCalls } = makeManager({ isTransactionActive: true });

      await publisher.enqueue(makeEvent(), manager);

      expect(saveCalls).toHaveLength(1);
      const row = firstSaveCall(saveCalls);
      expect(row.entityClass).toBe(TestOutbox);
      expect(row.payload).toMatchObject({
        eventType: 'TestEventOccurred',
        tenantId: VALID_TENANT,
        retryCount: 0,
        publishedAt: null,
        isDeadLettered: false,
        lastError: null,
        nextAttemptAt: null,
        idempotencyKey: null,
        aggregateId: null,
      });
    });

    it('round-trips the payload through JSON to drop class metadata', async () => {
      const { manager, saveCalls } = makeManager({ isTransactionActive: true });

      // Class instance — must NOT leak prototype into the JSONB column.
      class FancyEvent {
        eventId = 'evt-002';
        eventType = 'FancyEventOccurred';
        timestamp = '2026-04-27T00:00:00.000Z';
        tenantId = VALID_TENANT;
        version = 1;
      }
      await publisher.enqueue(new FancyEvent() as unknown as BaseEvent, manager);

      const row = firstSaveCall(saveCalls);
      // After JSON.parse(JSON.stringify(...)), the prototype is Object —
      // not FancyEvent. This is the load-bearing JSONB-safety property.
      expect(Object.getPrototypeOf(row.payload['payload'])).toBe(Object.prototype);
    });

    it('passes idempotencyKey + aggregateId from options through to the row', async () => {
      const { manager, saveCalls, insertCalls } = makeManager({ isTransactionActive: true });

      await publisher.enqueue(makeEvent(), manager, {
        idempotencyKey: 'idem-abc-123',
        aggregateId: 'aggregate-xyz-789',
      });

      expect(saveCalls).toHaveLength(0);
      const [row] = insertCalls;
      if (!row) {
        throw new Error('expected one idempotent outbox insert');
      }
      expect(row.payload['idempotencyKey']).toBe('idem-abc-123');
      expect(row.payload['aggregateId']).toBe('aggregate-xyz-789');
    });

    it('uses an idempotent INSERT for a repeated logical event', async () => {
      const { manager, insertCalls } = makeManager({ isTransactionActive: true });

      await publisher.enqueue(makeEvent(), manager, { idempotencyKey: 'same-operation' });

      expect(insertCalls).toHaveLength(1);
      expect(manager.createQueryBuilder).toHaveBeenCalledTimes(1);
    });
  });

  describe('enqueue() — privileged routing capabilities', () => {
    it('denies system routing unless the consuming module explicitly owns it', async () => {
      const { manager } = makeManager({ isTransactionActive: true });

      await expect(
        publisher.enqueue(makeEvent({ tenantId: OUTBOX_SYSTEM_TENANT_ID }), manager, {
          routingScope: 'system',
          idempotencyKey: 'system-event',
        }),
      ).rejects.toThrow(/explicit service capability/);
    });

    it('stores an attested NULL-tenant system row and strips no tenant identity from its payload', async () => {
      publisher = new OutboxPublisher(TestOutbox, {
        allowSystemRouting: true,
        allowSecurityRecovery: true,
      });
      const { manager, insertCalls } = makeManager({ isTransactionActive: true });

      await publisher.enqueue(makeEvent({ tenantId: OUTBOX_SYSTEM_TENANT_ID }), manager, {
        routingScope: 'system',
        deliveryPolicy: OUTBOX_SECURITY_RECOVERY_POLICY,
        idempotencyKey: 'system-event',
      });

      const [insertCall] = insertCalls;
      if (!insertCall) {
        throw new Error('expected one system-routing outbox insert');
      }
      const row = insertCall.payload;
      expect(row['tenantId']).toBeNull();
      expect(row['payload']).toMatchObject({
        tenantId: OUTBOX_SYSTEM_TENANT_ID,
        [OUTBOX_ROUTING_SCOPE_FIELD]: OUTBOX_SYSTEM_TENANT_ID,
        [OUTBOX_DELIVERY_POLICY_FIELD]: OUTBOX_SECURITY_RECOVERY_POLICY,
      });
    });

    it('denies the infinite security recovery policy by default', async () => {
      const { manager } = makeManager({ isTransactionActive: true });

      await expect(
        publisher.enqueue(makeEvent(), manager, {
          deliveryPolicy: OUTBOX_SECURITY_RECOVERY_POLICY,
        }),
      ).rejects.toThrow(/explicit service capability/);
    });

    it('rejects caller-forged storage metadata', async () => {
      const { manager } = makeManager({ isTransactionActive: true });
      const forgedEvent = Object.assign(makeEvent(), {
        [OUTBOX_ROUTING_SCOPE_FIELD]: OUTBOX_SYSTEM_TENANT_ID,
      });

      await expect(publisher.enqueue(forgedEvent, manager)).rejects.toThrow(
        /reserved outbox storage metadata/,
      );
    });
  });

  describe('enqueue() — eventType validation', () => {
    it('rejects empty eventType', async () => {
      const { manager } = makeManager({ isTransactionActive: true });
      await expect(publisher.enqueue(makeEvent({ eventType: '' }), manager)).rejects.toThrow(
        /eventType is required/,
      );
    });

    it('rejects camelCase eventType (would break NATS PascalCase discriminator)', async () => {
      const { manager } = makeManager({ isTransactionActive: true });
      await expect(
        publisher.enqueue(makeEvent({ eventType: 'orderShipped' }), manager),
      ).rejects.toThrow(/PascalCase/);
    });

    it('rejects eventType with dots (would inject NATS subject wildcards)', async () => {
      const { manager } = makeManager({ isTransactionActive: true });
      await expect(
        publisher.enqueue(makeEvent({ eventType: 'Order.Shipped' }), manager),
      ).rejects.toThrow(/PascalCase/);
    });

    it('rejects eventType with NATS wildcards (* and >)', async () => {
      const { manager } = makeManager({ isTransactionActive: true });
      await expect(publisher.enqueue(makeEvent({ eventType: 'Order*' }), manager)).rejects.toThrow(
        /PascalCase/,
      );
      await expect(publisher.enqueue(makeEvent({ eventType: 'Order>' }), manager)).rejects.toThrow(
        /PascalCase/,
      );
    });

    it('accepts valid PascalCase eventType', async () => {
      const { manager, saveCalls } = makeManager({ isTransactionActive: true });
      await publisher.enqueue(makeEvent({ eventType: 'OrderShipped' }), manager);
      await publisher.enqueue(makeEvent({ eventType: 'BatchHarvested' }), manager);
      await publisher.enqueue(makeEvent({ eventType: 'V1' }), manager);
      expect(saveCalls).toHaveLength(3);
    });
  });

  describe('enqueue() — tenantId validation (cross-tenant safety)', () => {
    it('rejects empty tenantId', async () => {
      const { manager } = makeManager({ isTransactionActive: true });
      await expect(publisher.enqueue(makeEvent({ tenantId: '' }), manager)).rejects.toThrow(
        /tenantId is required/,
      );
    });

    it('rejects non-UUID tenantId (would inject NATS subject wildcards / Socket.IO room collision)', async () => {
      const { manager } = makeManager({ isTransactionActive: true });
      await expect(publisher.enqueue(makeEvent({ tenantId: 'tenant-1' }), manager)).rejects.toThrow(
        /UUID/,
      );
    });

    it('rejects tenantId with embedded newline (log-injection vector)', async () => {
      const { manager } = makeManager({ isTransactionActive: true });
      const newlineTenant = `${VALID_TENANT}\nINJECTED LOG LINE`;
      await expect(
        publisher.enqueue(makeEvent({ tenantId: newlineTenant }), manager),
      ).rejects.toThrow(/UUID/);
    });

    it('rejects tenantId with embedded NATS wildcard', async () => {
      const { manager } = makeManager({ isTransactionActive: true });
      await expect(publisher.enqueue(makeEvent({ tenantId: '*.evil' }), manager)).rejects.toThrow(
        /UUID/,
      );
    });

    it('accepts UUID v4 tenantId in any case', async () => {
      const { manager, saveCalls } = makeManager({ isTransactionActive: true });
      await publisher.enqueue(makeEvent({ tenantId: VALID_TENANT.toLowerCase() }), manager);
      await publisher.enqueue(makeEvent({ tenantId: VALID_TENANT.toUpperCase() }), manager);
      expect(saveCalls).toHaveLength(2);
    });
  });

  describe('enqueue() — transaction binding (atomicity guarantee)', () => {
    it('rejects when manager has no queryRunner (root dataSource manager)', async () => {
      const { manager } = makeManager({ isTransactionActive: false, hasQueryRunner: false });
      await expect(publisher.enqueue(makeEvent(), manager)).rejects.toThrow(
        /must be from an active.*transaction/,
      );
    });

    it('rejects when queryRunner exists but transaction is not active', async () => {
      const { manager } = makeManager({ isTransactionActive: false });
      await expect(publisher.enqueue(makeEvent(), manager)).rejects.toThrow(
        /must be from an active.*transaction/,
      );
    });

    it('does NOT call manager.save when validation fails — no orphan rows', async () => {
      const { manager, saveCalls } = makeManager({ isTransactionActive: false });
      await expect(publisher.enqueue(makeEvent(), manager)).rejects.toThrow();
      expect(saveCalls).toHaveLength(0);
      expect(manager.save).not.toHaveBeenCalled();
    });
  });

  describe('enqueue() — payload contract', () => {
    it('forwards eventType + tenantId from the event into top-level row columns', async () => {
      const { manager, saveCalls } = makeManager({ isTransactionActive: true });
      await publisher.enqueue(makeEvent({ eventType: 'BatchClosed' }), manager);
      const row = firstSaveCall(saveCalls);
      expect(row.payload['eventType']).toBe('BatchClosed');
      expect(row.payload['tenantId']).toBe(VALID_TENANT);
    });

    it('the JSONB payload preserves all event fields after the round-trip', async () => {
      const { manager, saveCalls } = makeManager({ isTransactionActive: true });
      const event = makeEvent({
        eventId: 'evt-payload-001',
        eventType: 'PayloadCheck',
        version: 3,
      });
      await publisher.enqueue(event, manager);
      const row = firstSaveCall(saveCalls);
      const payload = row.payload['payload'] as Record<string, unknown>;
      expect(payload['eventId']).toBe('evt-payload-001');
      expect(payload['eventType']).toBe('PayloadCheck');
      expect(payload['tenantId']).toBe(VALID_TENANT);
      expect(payload['version']).toBe(3);
      expect(payload['timestamp']).toBe('2026-04-27T00:00:00.000Z');
    });
  });
});
