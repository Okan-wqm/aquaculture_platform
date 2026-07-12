/**
 * TenantErasureTargetExecutor — post-erasure hook contract (crypto-shred
 * rollout step 2, docs/plans/2026-07-12-event-store-crypto-shred-design.md).
 *
 * Pins the extension-point guarantees the GDPR treatment for non-deletable
 * tenant data relies on:
 *   - hooks run inside the erasure transaction AFTER table deletion and BEFORE
 *     the success proof is recorded/enqueued, in registration order
 *   - a hook failure fails the erasure closed: no proof row, no
 *     TenantDataErased — a TenantDataErasureFailed is emitted instead
 *   - dry runs never execute destructive hooks
 *   - services without hooks keep the exact pre-hook behavior
 */
import {
  createBaseEvent,
  type TenantErasureRequestedEvent,
} from '@platform/event-contracts';

import {
  TenantErasureTargetExecutor,
  type TenantErasurePostErasureHook,
  type TenantErasureTargetExecutorDependencies,
  type TenantErasureTargetExecutorOptions,
} from '../tenant-erasure-target-executor';

const TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OPERATION = '11111111-2222-4333-8444-555555555555';

const OPTIONS: TenantErasureTargetExecutorOptions = {
  targetService: 'event-store-service',
  moduleName: 'event_store',
  sourceSchema: 'event_store',
  mode: 'source-schema-tenant-column',
  excludedTables: ['event_store_outbox', 'stored_events', 'tenant_payload_keys'],
  outbox: { schema: 'event_store', table: 'event_store_outbox' },
  proofLedger: { schema: 'event_store', table: 'tenant_erasure_target_proofs' },
};

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
 * transaction EntityManager). One erasable table (event_streams) keeps the
 * flow single-table so ordering assertions stay unambiguous.
 */
function makeManager(calls: string[]) {
  return {
    query: jest.fn((sql: string) => {
      const norm = sql.replace(/\s+/g, ' ').trim();
      if (norm.includes('pg_advisory_xact_lock')) {
        return Promise.resolve([]);
      }
      if (norm.startsWith('INSERT INTO "event_store"."tenant_erasure_target_proofs"')) {
        calls.push('proof-ledger-insert');
        return Promise.resolve([]);
      }
      if (norm.includes('information_schema.columns')) {
        return Promise.resolve([{ table_name: 'event_streams', column_name: 'tenantId' }]);
      }
      if (norm.includes('"tenant_erasure_target_proofs"')) {
        return Promise.resolve([]); // no stored proof — first execution
      }
      if (norm.startsWith('SELECT COUNT(*)::text AS count')) {
        return Promise.resolve([{ count: '2' }]);
      }
      if (norm.startsWith('DELETE FROM')) {
        calls.push('table-delete');
        return Promise.resolve([[], 2]);
      }
      return Promise.reject(new Error(`unrouted query in test manager: ${norm}`));
    }),
  };
}

function makeHook(
  name: string,
  calls: string[],
  failWith?: Error,
): TenantErasurePostErasureHook {
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
) {
  const manager = makeManager(calls);
  const outbox = {
    enqueue: jest.fn((event: { eventType: string } & Record<string, unknown>) => {
      calls.push(`enqueue:${event.eventType}`);
      return Promise.resolve();
    }),
  };
  const dataSource = {
    transaction: jest.fn((cb: (m: unknown) => Promise<unknown>) => cb(manager)),
    // The executor's pre-transaction proof lookup queries the DataSource
    // directly; route it through the same SQL router as the manager.
    query: jest.fn((sql: string) => manager.query(sql)),
  };
  const legalHold = { assertNoHold: jest.fn(() => Promise.resolve()) };
  const logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
  const deps: TenantErasureTargetExecutorDependencies = {
    dataSource: dataSource as never,
    outboxPublisher: outbox as never,
    legalHoldService: legalHold as never,
    logger: logger as never,
    postErasureHooks: hooks,
  };
  return {
    executor: new TenantErasureTargetExecutor(deps, OPTIONS),
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
    expect(calls.indexOf('table-delete')).toBeGreaterThanOrEqual(0);
    expect(calls.indexOf('table-delete')).toBeLessThan(calls.indexOf('hook:shred-a'));
    expect(calls.indexOf('hook:shred-a')).toBeLessThan(calls.indexOf('hook:shred-b'));
    expect(calls.indexOf('hook:shred-b')).toBeLessThan(calls.indexOf('proof-ledger-insert'));
    expect(calls.indexOf('proof-ledger-insert')).toBeLessThan(
      calls.indexOf('enqueue:TenantDataErased'),
    );
  });

  it('fails closed when a hook throws: no proof, TenantDataErasureFailed emitted', async () => {
    const calls: string[] = [];
    const failing = makeHook('shred-fail', calls, new Error('KEK unavailable'));
    const { executor, outbox } = makeHarness(calls, [failing]);

    const result = await executor.eraseFromRequest(makeRequest());

    expect(result.state).toBe('FAILED');
    expect(calls).not.toContain('proof-ledger-insert');
    expect(calls).not.toContain('enqueue:TenantDataErased');
    expect(calls).toContain('enqueue:TenantDataErasureFailed');
    const failure = outbox.enqueue.mock.calls
      .map((call) => call[0])
      .find((event) => event.eventType === 'TenantDataErasureFailed');
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

    expect(result.state).toBe('PURGED');
    expect(hook.onTenantErased).not.toHaveBeenCalled();
    expect(calls).not.toContain('table-delete'); // deletes are counted, not run
    expect(calls).toContain('proof-ledger-insert');
    expect(calls).toContain('enqueue:TenantDataErased');
  });

  it('keeps the pre-hook behavior when no hooks are registered', async () => {
    const calls: string[] = [];
    const { executor } = makeHarness(calls, undefined);

    const result = await executor.eraseFromRequest(makeRequest());

    expect(result.state).toBe('PURGED');
    expect(result.erasedRecordCount).toBe(2);
    expect(calls).toContain('proof-ledger-insert');
    expect(calls).toContain('enqueue:TenantDataErased');
  });
});
