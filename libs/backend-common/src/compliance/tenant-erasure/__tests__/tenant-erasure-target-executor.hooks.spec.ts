/**
 * TenantErasureTargetExecutor — post-erasure hook contract (crypto-shred
 * rollout step 2, docs/plans/2026-07-12-event-store-crypto-shred-design.md)
 * plus the executor's structural table exclusions.
 *
 * Pins the guarantees the GDPR treatment for non-deletable tenant data relies on:
 *   - hooks run inside the erasure transaction AFTER table deletion and BEFORE
 *     the success proof is recorded/enqueued, in registration order
 *   - a hook failure fails the erasure closed: no proof row, no
 *     TenantDataErased — a TenantDataErasureFailed is emitted instead
 *   - dry runs never execute destructive hooks
 *   - services without hooks keep the exact pre-hook behavior
 *   - the proof ledger and outbox are excluded from row deletion by the
 *     EXECUTOR itself, independent of registry excludedTables — a new erasure
 *     operation must never erase the audit/GDPR evidence of prior operations
 */
import {
  createBaseEvent,
  type BaseEvent,
  type TenantErasureRequestedEvent,
} from '@platform/event-contracts';
import { DataSource, EntityManager } from 'typeorm';

import {
  TenantErasureTargetExecutor,
  type TenantErasureTargetDataSource,
  type TenantErasurePostErasureHook,
  type TenantErasureTargetExecutorDependencies,
  type TenantErasureTargetLegalHold,
  type TenantErasureTargetExecutorOptions,
  type TenantErasureTargetOutbox,
} from '../tenant-erasure-target-executor';
import { getTenantErasureTargetOptions } from '../tenant-erasure-target-registry';

const TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OPERATION = '11111111-2222-4333-8444-555555555555';

// The registry entry IS the fixture: the spec exercises the real event-store policy.
const OPTIONS: TenantErasureTargetExecutorOptions =
  getTenantErasureTargetOptions('event-store-service');

/**
 * Tables the fake information_schema reports a tenant column for. The proof
 * ledger and outbox genuinely carry tenantId in production — listing them here
 * is what makes the structural-exclusion test meaningful: if the executor ever
 * lets them into the candidate set, they surface as delete targets.
 */
/** The columns the fake database reports; every column the policy names must be here. */
const TENANT_COLUMN_TABLES = new Set([
  'event_streams',
  'snapshots',
  'projection_checkpoints',
  'projection_rebuilds',
]);

type EnqueueMock = jest.Mock<
  Promise<void>,
  [BaseEvent, EntityManager, { idempotencyKey?: string; aggregateId?: string }?]
>;

interface ExecutorHarness {
  readonly executor: TenantErasureTargetExecutor;
  readonly manager: EntityManager;
  readonly outbox: { readonly enqueue: EnqueueMock };
  readonly logger: {
    readonly log: jest.Mock;
    readonly warn: jest.Mock;
    readonly error: jest.Mock;
    readonly debug: jest.Mock;
  };
}

function makeRequest(
  overrides: Partial<TenantErasureRequestedEvent> = {},
): TenantErasureRequestedEvent {
  return {
    ...createBaseEvent<TenantErasureRequestedEvent>('TenantErasureRequested', TENANT, {
      aggregateId: TENANT,
      aggregateType: 'Tenant',
    }),
    operationId: OPERATION,
    requestedBy: 'admin-user-1',
    requestedAt: '2026-07-12T00:00:00.000Z',
    legalHoldCheckedAt: '2026-07-12T00:00:00.000Z',
    dryRun: false,
    targetServiceCount: 12,
    ...overrides,
  };
}

/**
 * Routes the executor's raw SQL by shape (London-school stand-in for the
 * transaction EntityManager). The tenant-column lookup honours the requested
 * table list, so the delete set observed in `calls` reflects exactly which
 * candidates the executor allowed through its exclusion filter.
 */
function makeManager(calls: string[], storedProof?: Record<string, unknown>): EntityManager {
  const dataSource = new DataSource({
    type: 'postgres',
    database: 'tenant-erasure-target-executor-spec',
  });
  const manager = new EntityManager(dataSource);
  jest.spyOn(manager, 'query').mockImplementation((sql, params) => {
    const norm = sql.replace(/\s+/g, ' ').trim();
    if (norm.includes('pg_advisory_xact_lock')) {
      return Promise.resolve([]);
    }
    if (norm.startsWith('INSERT INTO "event_store"."tenant_erasure_target_proofs"')) {
      calls.push('proof-ledger-insert');
      return Promise.resolve([]);
    }
    if (norm.includes('information_schema.columns')) {
      const requestedRaw: unknown = params?.[1];
      const requested = Array.isArray(requestedRaw) ? requestedRaw : [];
      return Promise.resolve(
        requested
          .filter((table): table is string => typeof table === 'string')
          .filter((table) => TENANT_COLUMN_TABLES.has(table))
          .map((table) => ({ table_name: table, column_name: 'tenantId' })),
      );
    }
    if (norm.includes('information_schema.table_constraints')) {
      return Promise.resolve([]); // no FKs among test tables
    }
    if (norm.includes('"tenant_erasure_target_proofs"')) {
      return Promise.resolve(storedProof ? [storedProof] : []);
    }
    if (norm.startsWith('SELECT COUNT(*)::text AS count')) {
      return Promise.resolve([{ count: '2' }]);
    }
    const deleteMatch = norm.match(/^DELETE FROM "event_store"\."([^"]+)"/);
    if (deleteMatch) {
      calls.push(`table-delete:${deleteMatch[1]}`);
      return Promise.resolve([[], 2]);
    }
    return Promise.reject(new Error(`unrouted query in test manager: ${norm}`));
  });
  return manager;
}

function makeHook(name: string, calls: string[], failWith?: Error): TenantErasurePostErasureHook {
  return {
    hookName: name,
    onTenantErased: jest.fn(() => {
      calls.push(`hook:${name}`);
      return failWith ? Promise.reject(failWith) : Promise.resolve();
    }),
  };
}

function makeHarness(
  calls: string[],
  hooks?: readonly TenantErasurePostErasureHook[],
  options: TenantErasureTargetExecutorOptions = OPTIONS,
  storedProof?: Record<string, unknown>,
): ExecutorHarness {
  const manager = makeManager(calls, storedProof);
  const enqueue: EnqueueMock = jest.fn(
    (
      event: BaseEvent,
      _manager: EntityManager,
      _options?: { idempotencyKey?: string; aggregateId?: string },
    ): Promise<void> => {
      calls.push(`enqueue:${event.eventType}`);
      return Promise.resolve();
    },
  );
  const outbox = {
    enqueue,
  };
  const dataSource: TenantErasureTargetDataSource = {
    transaction: async <T>(work: (transactionManager: EntityManager) => Promise<T>) =>
      work(manager),
    // The executor's pre-transaction proof lookup queries the DataSource
    // directly; route it through the same SQL router as the manager.
    query: (sql, params) => manager.query(sql, params),
  };
  const legalHold: TenantErasureTargetLegalHold = {
    assertNoHold: jest.fn().mockResolvedValue(undefined),
  };
  const logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
  const outboxWriter: TenantErasureTargetOutbox = outbox;
  const deps: TenantErasureTargetExecutorDependencies = {
    dataSource,
    outboxPublisher: outboxWriter,
    legalHoldService: legalHold,
    logger,
    postErasureHooks: hooks,
  };
  return {
    executor: new TenantErasureTargetExecutor(deps, options),
    manager,
    outbox,
    logger,
  };
}

describe('TenantErasureTargetExecutor post-erasure hooks', () => {
  it('invokes hooks after table erasure and before the proof is recorded and enqueued', async () => {
    const calls: string[] = [];
    const hookA = makeHook('shred-a', calls);
    const hookB = makeHook('shred-b', calls);
    const { executor, manager } = makeHarness(calls, [hookA, hookB]);

    const result = await executor.eraseFromRequest(makeRequest());

    expect(result.state).toBe('PURGED');
    expect(hookA.onTenantErased).toHaveBeenCalledTimes(1);
    expect(hookA.onTenantErased).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: TENANT, operationId: OPERATION }),
      manager,
    );
    // Deletion → hooks (registration order) → proof row → proof event.
    expect(calls.indexOf('table-delete:event_streams')).toBeGreaterThanOrEqual(0);
    expect(calls.indexOf('table-delete:event_streams')).toBeLessThan(calls.indexOf('hook:shred-a'));
    expect(calls.indexOf('hook:shred-a')).toBeLessThan(calls.indexOf('hook:shred-b'));
    expect(calls.indexOf('hook:shred-b')).toBeLessThan(calls.indexOf('proof-ledger-insert'));
    expect(calls.indexOf('proof-ledger-insert')).toBeLessThan(
      calls.indexOf('enqueue:EventStoreServiceTenantDataErased'),
    );
  });

  it('fails closed when a hook throws: no proof, TenantDataErasureFailed emitted', async () => {
    const calls: string[] = [];
    const failing = makeHook('shred-fail', calls, new Error('KEK unavailable'));
    const { executor, outbox } = makeHarness(calls, [failing]);

    const result = await executor.eraseFromRequest(makeRequest());

    expect(result.state).toBe('FAILED');
    expect(calls).not.toContain('proof-ledger-insert');
    expect(calls).not.toContain('enqueue:EventStoreServiceTenantDataErased');
    expect(calls).toContain('enqueue:EventStoreServiceTenantDataErasureFailed');
    const failure = outbox.enqueue.mock.calls
      .map((call) => call[0])
      .find((event) => event.eventType === 'EventStoreServiceTenantDataErasureFailed');
    expect(failure).toMatchObject({
      operationId: OPERATION,
      targetService: 'event-store-service',
      errorMessage: 'KEK unavailable',
      retryable: true,
    });
  });

  it('never executes destructive hooks on a dry run (dry-run proof still recorded)', async () => {
    const calls: string[] = [];
    const hook = makeHook('shred-a', calls);
    const { executor } = makeHarness(calls, [hook]);

    const result = await executor.eraseFromRequest(makeRequest({ dryRun: true }));

    expect(result.state).toBe('DRY_RUN_COMPLETED');
    expect(hook.onTenantErased).not.toHaveBeenCalled();
    // Deletes are counted, not run, on a dry run.
    expect(calls.some((entry) => entry.startsWith('table-delete:'))).toBe(false);
    expect(calls).toContain('proof-ledger-insert');
    expect(calls).toContain('enqueue:EventStoreServiceTenantDataErased');
  });

  it('returns the honest dry-run state when replaying a stored dry-run proof', async () => {
    const calls: string[] = [];
    const storedProof = {
      operationId: OPERATION,
      tenantId: TENANT,
      targetService: 'event-store-service',
      eventId: '22222222-2222-4222-8222-222222222222',
      proofHash: 'sha256:stored-dry-run',
      erasedAt: '2026-07-12T00:00:02.000Z',
      dryRun: true,
      matchedRecordCount: 2,
      erasedRecordCount: 0,
    };
    const { executor } = makeHarness(calls, undefined, OPTIONS, storedProof);

    const result = await executor.eraseFromRequest(makeRequest({ dryRun: true }));

    expect(result.state).toBe('DRY_RUN_COMPLETED');
    expect(result.matchedRecordCount).toBe(2);
    expect(result.erasedRecordCount).toBe(0);
    expect(calls.some((entry) => entry.startsWith('table-delete:'))).toBe(false);
  });

  it('rejects a stored proof whose execution mode differs from the request', async () => {
    const calls: string[] = [];
    const storedProof = {
      operationId: OPERATION,
      tenantId: TENANT,
      targetService: 'event-store-service',
      eventId: '22222222-2222-4222-8222-222222222222',
      proofHash: 'sha256:stored-dry-run',
      erasedAt: '2026-07-12T00:00:02.000Z',
      dryRun: true,
      matchedRecordCount: 2,
      erasedRecordCount: 0,
    };
    const { executor } = makeHarness(calls, undefined, OPTIONS, storedProof);

    await expect(executor.eraseFromRequest(makeRequest({ dryRun: false }))).rejects.toThrow(
      'stored proof mode mismatch',
    );
    expect(calls.some((entry) => entry.startsWith('table-delete:'))).toBe(false);
  });

  it('keeps the pre-hook behavior when no hooks are registered', async () => {
    const calls: string[] = [];
    const { executor } = makeHarness(calls, undefined);

    const result = await executor.eraseFromRequest(makeRequest());

    expect(result.state).toBe('PURGED');
    // The fixture reports 2 rows per table; the event-store policy erases four tables.
    expect(result.erasedRecordCount).toBe(8);
    expect(calls).toContain('proof-ledger-insert');
    expect(calls).toContain('enqueue:EventStoreServiceTenantDataErased');
  });
});

describe('TenantErasureTargetExecutor structural table exclusions', () => {
  it('refuses to construct a target whose policy would erase its outbox or proof ledger', () => {
    if (OPTIONS.mode !== 'source-schema-tenant-column')
      throw new Error('fixture is a source-schema target');
    const policyErasingOutbox: TenantErasureTargetExecutorOptions = {
      ...OPTIONS,
      tables: {
        ...OPTIONS.tables,
        event_store_outbox: { kind: 'tenant-column', column: 'tenantId' },
      },
    };
    expect(() => makeHarness([], undefined, policyErasingOutbox)).toThrow(/outbox or proof ledger/);
  });

  it('refuses to construct a target whose policy misses a registered table', () => {
    if (OPTIONS.mode !== 'source-schema-tenant-column')
      throw new Error('fixture is a source-schema target');
    const { snapshots: _dropped, ...withoutSnapshots } = OPTIONS.tables;
    expect(() => makeHarness([], undefined, { ...OPTIONS, tables: withoutSnapshots })).toThrow(
      /'snapshots' has no erasure policy/,
    );
  });

  it("never row-deletes an excluded table: only the policy's erasing tables are touched", async () => {
    const calls: string[] = [];
    const { executor } = makeHarness(calls, undefined, OPTIONS);

    const result = await executor.eraseFromRequest(makeRequest());

    expect(result.state).toBe('PURGED');
    const deletes = calls.filter((entry) => entry.startsWith('table-delete:')).sort();
    expect(deletes).toEqual([
      'table-delete:event_streams',
      'table-delete:projection_checkpoints',
      'table-delete:projection_rebuilds',
      'table-delete:snapshots',
    ]);
  });
});
