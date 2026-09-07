import { createBaseEvent, type TenantErasureRequestedEvent } from '@platform/event-contracts';
import { DataSource, EntityManager } from 'typeorm';

import { requiredColumns } from '../tenant-erasure-table-policy';
import {
  TenantErasureTargetExecutor,
  type TenantErasureTargetExecutorDependencies,
  type TenantErasureTargetExecutorOptions,
} from '../tenant-erasure-target-executor';
import { getTenantErasureTargetOptions } from '../tenant-erasure-target-registry';

/**
 * ADMIN-CRITICAL-009 — a tenant's rows that hang off a parent (messages of a
 * thread, comments of a ticket, logs of a job) are erased through the
 * declared cascade, in child-before-parent order, without the executor ever
 * asking the database which tables "look" tenant-scoped.
 */
const TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OPERATION = '11111111-2222-4333-8444-555555555555';

function makeRequest(dryRun = false): TenantErasureRequestedEvent {
  return {
    ...createBaseEvent<TenantErasureRequestedEvent>('TenantErasureRequested', TENANT, {
      aggregateId: TENANT,
      aggregateType: 'Tenant',
    }),
    operationId: OPERATION,
    requestedBy: 'admin-user-1',
    requestedAt: '2026-09-05T00:00:00.000Z',
    legalHoldCheckedAt: '2026-09-05T00:00:00.000Z',
    dryRun,
    targetServiceCount: 12,
  };
}

interface Harness {
  readonly executor: TenantErasureTargetExecutor;
  readonly deletes: string[];
  readonly sql: string[];
}

function makeHarness(
  options: TenantErasureTargetExecutorOptions,
  presentColumns: ReadonlyArray<{ table: string; column: string }>,
): Harness {
  const dataSource = new DataSource({ type: 'postgres', database: 'cascade-spec' });
  const manager = new EntityManager(dataSource);
  const deletes: string[] = [];
  const sql: string[] = [];
  jest.spyOn(manager, 'query').mockImplementation((raw: string, params?: unknown[]) => {
    const norm = raw.replace(/\s+/g, ' ').trim();
    sql.push(norm);
    if (norm.includes('pg_advisory_xact_lock')) return Promise.resolve([]);
    if (norm.startsWith('INSERT INTO')) return Promise.resolve([]);
    if (norm.includes('information_schema.columns')) {
      const requested = Array.isArray(params?.[1]) ? (params?.[1] as string[]) : [];
      return Promise.resolve(
        presentColumns
          .filter((entry) => requested.includes(entry.table))
          .map((entry) => ({ table_name: entry.table, column_name: entry.column })),
      );
    }
    // No database-declared foreign keys at all: the order must come from the policy.
    if (norm.includes('information_schema.table_constraints')) return Promise.resolve([]);
    if (norm.includes('"tenant_erasure_target_proofs"')) return Promise.resolve([]);
    if (norm.startsWith('SELECT COUNT(*)::text AS count')) return Promise.resolve([{ count: '1' }]);
    const deleteMatch = norm.match(/^DELETE FROM "admin"\."([^"]+)" WHERE (.*)$/);
    if (deleteMatch) {
      deletes.push(deleteMatch[1] ?? '');
      return Promise.resolve([[], 1]);
    }
    return Promise.reject(new Error(`unrouted query: ${norm}`));
  });
  const deps: TenantErasureTargetExecutorDependencies = {
    dataSource: {
      transaction: async <T>(work: (m: EntityManager) => Promise<T>) => work(manager),
      query: (raw, params) => manager.query(raw, params),
    },
    outboxPublisher: { enqueue: jest.fn().mockResolvedValue(undefined) },
    legalHoldService: { assertNoHold: jest.fn().mockResolvedValue(undefined) },
    logger: { log: jest.fn(), warn: jest.fn(), error: jest.fn() },
  };
  return { executor: new TenantErasureTargetExecutor(deps, options), deletes, sql };
}

describe('TenantErasureTargetExecutor — declared cascade (admin-api-service policy)', () => {
  const options = getTenantErasureTargetOptions('admin-api-service');
  if (options.mode !== 'source-schema-tenant-column')
    throw new Error('admin is a source-schema target');
  const allColumns = requiredColumns(options.tables);

  it('erases cascade children through the parent predicate, before the parent, with no database FK to lean on', async () => {
    const { executor, deletes, sql } = makeHarness(options, allColumns);

    const result = await executor.eraseFromRequest(makeRequest());

    expect(result.state).toBe('PURGED');
    expect(deletes.indexOf('messages')).toBeLessThan(deletes.indexOf('message_threads'));
    expect(deletes.indexOf('ticket_comments')).toBeLessThan(deletes.indexOf('support_tickets'));
    expect(deletes.indexOf('job_execution_logs')).toBeLessThan(deletes.indexOf('background_jobs'));
    expect(deletes.indexOf('tenant_provisioning_steps')).toBeLessThan(
      deletes.indexOf('tenant_provisioning_runs'),
    );
    expect(sql).toContain(
      'DELETE FROM "admin"."messages" WHERE "threadId" IN (SELECT "id" FROM "admin"."message_threads" WHERE "tenantId" = $1)',
    );
    expect(sql).toContain('DELETE FROM "admin"."support_tickets" WHERE "tenantId" = $1');
  });

  it('never touches an excluded table: the WORM ledgers, the operation record, reference data', async () => {
    const { executor, deletes } = makeHarness(options, allColumns);

    await executor.eraseFromRequest(makeRequest());

    for (const table of [
      'audit_logs',
      'activity_logs',
      'tenant_activities',
      'tenant_erasure_operations',
      'tenant_schemas',
      'cleanup_runs',
      'plan_module_assignments',
      'announcements',
      'admin_outbox',
      'tenant_erasure_target_proofs',
    ]) {
      expect(deletes).not.toContain(table);
    }
  });

  it('never derives targets by sniffing tenant-looking columns', async () => {
    const { executor, sql } = makeHarness(options, allColumns);

    await executor.eraseFromRequest(makeRequest());

    expect(sql.some((s) => s.includes("column_name IN ('tenantId'"))).toBe(false);
  });

  it('fails loud when the database lacks a column the policy names, erasing nothing', async () => {
    const withoutThreadColumn = allColumns.filter(
      (entry) => !(entry.table === 'messages' && entry.column === 'threadId'),
    );
    const { executor, deletes } = makeHarness(options, withoutThreadColumn);

    const result = await executor.eraseFromRequest(makeRequest());

    expect(result.state).toBe('FAILED');
    expect(deletes).toEqual([]);
  });

  it('a dry run counts through the same predicates and deletes nothing', async () => {
    const { executor, deletes, sql } = makeHarness(options, allColumns);

    const result = await executor.eraseFromRequest(makeRequest(true));

    expect(result.state).toBe('DRY_RUN_COMPLETED');
    expect(deletes).toEqual([]);
    expect(
      sql.filter((s) =>
        s.startsWith('SELECT COUNT(*)::text AS count FROM "admin"."messages" WHERE'),
      ),
    ).toHaveLength(1);
    expect(result.matchedRecordCount).toBeGreaterThan(0);
  });
});
