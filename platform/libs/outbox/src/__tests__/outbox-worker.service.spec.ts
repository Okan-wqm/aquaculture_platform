import { Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { DataSource, EntityManager } from 'typeorm';

import { OUTBOX_ENTITY_CLASS } from '../constants';
import { OutboxEntityBase } from '../outbox-entity.base';
import { OutboxMetricsService } from '../outbox-metrics.service';
import {
  OUTBOX_DELIVERY_POLICY_FIELD,
  OUTBOX_ROUTING_SCOPE_FIELD,
  OUTBOX_SECURITY_RECOVERY_POLICY,
  OUTBOX_SYSTEM_TENANT_ID,
} from '../outbox-routing';
import { OutboxWorkerService } from '../outbox-worker.service';

const TENANT_ID = '550e8400-e29b-41d4-a716-446655440000';

/**
 * ORPHAN-HIGH-321 — the dispatcher is a CROSS-TENANT infrastructure
 * sweeper, but every outbox table carries the forced tenant RLS policy.
 * Without the transaction-scoped `set_config('app.bypass_rls','on',true)`
 * the worker's SELECT saw zero rows, its UPDATEs matched nothing, and the
 * transactional-outbox guarantee was silently void (2026-07-02: 28 farm
 * rows, zero dispatch attempts, zero errors).
 *
 * These tests pin: (1) EVERY table access runs inside a transaction whose
 * FIRST statement is the bypass set_config; (2) the pending gauges are
 * computed in system context (the RLS-blind counts also poisoned the
 * `pendingCount === 0` early exit); (3) the pending-age alarm fires when
 * the oldest unpublished row exceeds the threshold.
 */
class FakeOutbox extends OutboxEntityBase {}

interface TxnTrace {
  statements: string[];
}

describe('OutboxWorkerService system context (ORPHAN-HIGH-321)', () => {
  let worker: OutboxWorkerService;
  let transactions: TxnTrace[];
  let leaseRows: Array<Partial<OutboxEntityBase>>;
  let pendingCount: number;
  let oldestAgeSeconds: number | null;
  let updateCalls: unknown[][];

  const publish = jest.fn<Promise<void>, [Record<string, unknown>]>().mockResolvedValue(undefined);
  const metrics = {
    setPending: jest.fn(),
    setDeadLetterCount: jest.fn(),
    setOldestPendingAge: jest.fn(),
    recordPublishSuccess: jest.fn(),
    recordPublishFailure: jest.fn(),
  };

  // Cast-free EntityManager double: Object.create(prototype) yields a value
  // already typed as EntityManager (no assertion), and Object.assign overlays
  // the four recording fakes the worker actually calls.
  const makeManager = (trace: TxnTrace): EntityManager => {
    const base = Object.create(EntityManager.prototype) as EntityManager;
    return Object.assign(base, {
      query: (sql: string): Promise<unknown[]> => {
        trace.statements.push(sql);
        if (sql.includes('set_config')) return Promise.resolve([]);
        if (sql.includes('FOR UPDATE SKIP LOCKED')) return Promise.resolve(leaseRows);
        if (sql.includes('EXTRACT(EPOCH')) {
          return Promise.resolve([{ age_seconds: oldestAgeSeconds }]);
        }
        return Promise.resolve([]);
      },
      count: (): Promise<number> => {
        trace.statements.push('count');
        // The Promise.all issues the pending (LessThan) count first; the
        // fake returns the scenario's pendingCount for both — dead-letter
        // count is irrelevant to these pins.
        return Promise.resolve(pendingCount);
      },
      update: (
        ...args: unknown[]
      ): Promise<{ affected: number; raw: never[]; generatedMaps: never[] }> => {
        trace.statements.push('update');
        updateCalls.push(args);
        return Promise.resolve({ affected: 1, raw: [], generatedMaps: [] });
      },
      delete: (): Promise<{ affected: number; raw: never[] }> => {
        trace.statements.push('delete');
        return Promise.resolve({ affected: 0, raw: [] });
      },
    });
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    transactions = [];
    leaseRows = [];
    pendingCount = 0;
    oldestAgeSeconds = null;
    updateCalls = [];

    // Cast-free DataSource double — same Object.create idiom as the manager.
    const dataSource: DataSource = Object.assign(
      Object.create(DataSource.prototype) as DataSource,
      {
        transaction: async (cb: (m: EntityManager) => Promise<unknown>): Promise<unknown> => {
          const trace: TxnTrace = { statements: [] };
          transactions.push(trace);
          return cb(makeManager(trace));
        },
        getRepository: (): { metadata: { tableName: string } } => ({
          metadata: { tableName: 'outbox_events' },
        }),
      },
    );

    const moduleRef = await Test.createTestingModule({
      providers: [
        OutboxWorkerService,
        { provide: OUTBOX_ENTITY_CLASS, useValue: FakeOutbox },
        { provide: DataSource, useValue: dataSource },
        {
          provide: 'EVENT_BUS',
          useValue: { publish, isConnected: () => true, connect: jest.fn() },
        },
        { provide: OutboxMetricsService, useValue: metrics },
      ],
    }).compile();

    worker = moduleRef.get(OutboxWorkerService);
    await worker.onApplicationBootstrap();
  });

  it('every transaction opens with the bypass set_config BEFORE any table access', async () => {
    pendingCount = 2;
    oldestAgeSeconds = 30;
    leaseRows = [
      {
        id: 'row-1',
        eventType: 'BatchHarvested',
        // FARM-HIGH-083: the worker dead-letters any row whose tenant of record
        // can't be verified — a real published row always carries a matching
        // column + payload tenant, so the fixture must too.
        tenantId: '550e8400-e29b-41d4-a716-446655440000',
        payload: {
          eventId: 'e1',
          eventType: 'BatchHarvested',
          tenantId: '550e8400-e29b-41d4-a716-446655440000',
          timestamp: new Date().toISOString(),
        },
        retryCount: 0,
        createdAt: new Date(),
      },
    ];

    await worker.pollAndPublish();

    // gauges txn + lease txn + markPublished txn — at minimum 3.
    expect(transactions.length).toBeGreaterThanOrEqual(3);
    for (const txn of transactions) {
      expect(txn.statements.length).toBeGreaterThan(0);
      expect(txn.statements[0]).toContain("set_config('app.bypass_rls', 'on', true)");
    }
    expect(publish).toHaveBeenCalledTimes(1);
  });

  it('computes the pending gauges in system context and still early-exits an EMPTY queue', async () => {
    pendingCount = 0;
    oldestAgeSeconds = null;

    await worker.pollAndPublish();

    expect(metrics.setPending).toHaveBeenCalledWith('fake_outbox', 0);
    expect(metrics.setOldestPendingAge).toHaveBeenCalledWith('fake_outbox', 0);
    // Empty queue → the counts ran (1 txn) but no lease was attempted.
    expect(transactions).toHaveLength(1);
  });

  it('fires the pending-age alarm when the oldest row exceeds the threshold', async () => {
    const errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    pendingCount = 1;
    oldestAgeSeconds = 3 * 60 * 60; // 3 hours — far past the 10-minute alarm
    leaseRows = [];

    await worker.pollAndPublish();

    expect(metrics.setOldestPendingAge).toHaveBeenCalledWith('fake_outbox', 3 * 60 * 60);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('pending-age alarm'));
    errorSpy.mockRestore();
  });

  it('does NOT fire the alarm for a young backlog', async () => {
    const errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    pendingCount = 1;
    oldestAgeSeconds = 30;
    leaseRows = [];

    await worker.pollAndPublish();

    const alarmCalls = errorSpy.mock.calls.filter(
      (c) => typeof c[0] === 'string' && c[0].includes('pending-age alarm'),
    );
    expect(alarmCalls).toHaveLength(0);
    errorSpy.mockRestore();
  });

  it('marks failures in system context too (retry bookkeeping must not be RLS-filtered)', async () => {
    pendingCount = 1;
    oldestAgeSeconds = 10;
    leaseRows = [
      {
        id: 'row-err',
        eventType: 'BatchHarvested',
        tenantId: TENANT_ID,
        payload: {
          eventId: 'e2',
          eventType: 'BatchHarvested',
          tenantId: TENANT_ID,
          timestamp: new Date().toISOString(),
        },
        retryCount: 0,
        createdAt: new Date(),
      },
    ];
    publish.mockRejectedValueOnce(new Error('NATS down'));

    await worker.pollAndPublish();

    // The failure-bookkeeping transaction also opened with set_config and
    // performed an update.
    const failureTxn = transactions[transactions.length - 1];
    if (!failureTxn) {
      throw new Error('expected at least one transaction for failure bookkeeping');
    }
    expect(failureTxn.statements[0]).toContain('set_config');
    expect(failureTxn.statements).toContain('update');
  });

  it('strips storage-only routing metadata before publishing a system event', async () => {
    pendingCount = 1;
    leaseRows = [
      {
        id: 'row-system',
        eventType: 'UserAccessTokenInvalidationRequested',
        tenantId: null,
        payload: {
          eventId: 'event-system',
          eventType: 'UserAccessTokenInvalidationRequested',
          tenantId: OUTBOX_SYSTEM_TENANT_ID,
          timestamp: new Date().toISOString(),
          [OUTBOX_ROUTING_SCOPE_FIELD]: OUTBOX_SYSTEM_TENANT_ID,
          [OUTBOX_DELIVERY_POLICY_FIELD]: OUTBOX_SECURITY_RECOVERY_POLICY,
        },
        retryCount: 0,
        createdAt: new Date(),
      },
    ];

    await worker.pollAndPublish();

    expect(publish).toHaveBeenCalledTimes(1);
    const [publishCall] = publish.mock.calls;
    if (!publishCall) {
      throw new Error('expected the system outbox row to be published');
    }
    const [publishedEvent] = publishCall;
    expect(Object.prototype.hasOwnProperty.call(publishedEvent, OUTBOX_ROUTING_SCOPE_FIELD)).toBe(
      false,
    );
    expect(Object.prototype.hasOwnProperty.call(publishedEvent, OUTBOX_DELIVERY_POLICY_FIELD)).toBe(
      false,
    );
    expect(publishedEvent['tenantId']).toBe(OUTBOX_SYSTEM_TENANT_ID);
  });

  it('keeps a security recovery row retryable after the ordinary retry budget', async () => {
    pendingCount = 1;
    leaseRows = [
      {
        id: 'row-security',
        eventType: 'AccessTokenInvalidationRequested',
        tenantId: TENANT_ID,
        payload: {
          eventId: 'event-security',
          eventType: 'AccessTokenInvalidationRequested',
          tenantId: TENANT_ID,
          timestamp: new Date().toISOString(),
          [OUTBOX_DELIVERY_POLICY_FIELD]: OUTBOX_SECURITY_RECOVERY_POLICY,
        },
        retryCount: 4,
        createdAt: new Date(),
      },
    ];
    publish.mockRejectedValueOnce(new Error('NATS still unavailable'));

    await worker.pollAndPublish();

    const failureUpdate = updateCalls.find(
      (args) => typeof args[2] === 'object' && args[2] !== null && 'lastError' in args[2],
    );
    expect(failureUpdate?.[2]).toMatchObject({
      retryCount: 4,
      leasedAt: null,
      leasedBy: null,
    });
    expect(failureUpdate?.[2]).not.toHaveProperty('isDeadLettered', true);
  });
});
