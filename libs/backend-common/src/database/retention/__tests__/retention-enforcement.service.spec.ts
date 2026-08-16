import { defined } from '@aquaculture/testing';
import type { DataSource } from 'typeorm';

import { RetentionEnforcementService } from '../retention-enforcement.service';
import { clearRetentionPolicyRegistry, registerRetentionPolicy } from '../retention-policy';

function makeDs(
  behavior: {
    rowsPerQuery?: unknown[];
    throwOn?: RegExp;
    calls?: Array<{ sql: string; params?: unknown[] }>;
  } = {},
): DataSource {
  const calls = behavior.calls ?? [];
  return {
    query: jest.fn((sql: string, params?: unknown[]): Promise<unknown[]> => {
      calls.push({ sql, params });
      if (behavior.throwOn && behavior.throwOn.test(sql)) {
        return Promise.reject(new Error(`DS query failed for sql matching ${behavior.throwOn}`));
      }
      // Emulate RETURNING 1 — return an array whose length is the
      // deletion count.
      return Promise.resolve(behavior.rowsPerQuery ?? []);
    }),
  } as unknown as DataSource;
}

describe('RetentionEnforcementService', () => {
  beforeEach(() => clearRetentionPolicyRegistry());
  afterEach(() => clearRetentionPolicyRegistry());

  it('noop when no policies registered', async () => {
    const calls: Array<{ sql: string; params?: unknown[] }> = [];
    const ds = makeDs({ calls });
    const svc = new RetentionEnforcementService(ds);
    const reports = await svc.enforceAllOnce();
    expect(reports).toEqual([]);
    expect(calls).toEqual([]);
  });

  it('single policy — constructs DELETE with quoted identifiers + cutoff param', async () => {
    registerRetentionPolicy({
      id: 'migration_events.13mo',
      ownerTag: 'soc2-cc4.1',
      schema: 'observability',
      tableName: 'migration_events',
      timestampColumn: 'occurred_at',
      retentionDays: 395,
    });
    const calls: Array<{ sql: string; params?: unknown[] }> = [];
    const ds = makeDs({ rowsPerQuery: Array.from({ length: 7 }), calls });
    const svc = new RetentionEnforcementService(ds);
    const now = new Date('2026-04-21T12:00:00.000Z');
    const reports = await svc.enforceAllOnce(now);
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({
      policyId: 'migration_events.13mo',
      ownerTag: 'soc2-cc4.1',
      deleted: 7,
    });
    expect(calls).toHaveLength(1);
    const call = defined(calls[0], 'Expected retention delete call');
    expect(call.sql).toContain('DELETE FROM "observability"."migration_events"');
    expect(call.sql).toContain('"occurred_at" < $1');
    expect(call.sql).toContain('RETURNING 1');
    // Cutoff = 2026-04-21 - 395d
    const expectedCutoff = new Date(now.getTime() - 395 * 86_400_000).toISOString();
    expect(call.params).toEqual([expectedCutoff]);
  });

  it('legal-hold predicate AND-NOT wraps into WHERE; hold rows preserved', async () => {
    registerRetentionPolicy({
      id: 'emergency_overrides.7y',
      ownerTag: 'soc2-cc6.1',
      schema: 'observability',
      tableName: 'emergency_overrides',
      timestampColumn: 'created_at',
      retentionDays: 2556,
      legalHoldClause: 'revoked_at IS NULL AND expires_at > NOW()',
    });
    const calls: Array<{ sql: string; params?: unknown[] }> = [];
    const ds = makeDs({ rowsPerQuery: [], calls });
    const svc = new RetentionEnforcementService(ds);
    await svc.enforceAllOnce(new Date('2026-04-21T12:00:00.000Z'));
    expect(defined(calls[0], 'Expected legal-hold delete call').sql).toContain(
      'AND NOT (revoked_at IS NULL AND expires_at > NOW())',
    );
  });

  it('policy-level failure does NOT halt subsequent policies', async () => {
    registerRetentionPolicy({
      id: 'first.fail',
      ownerTag: 'test',
      schema: 'observability',
      tableName: 'broken_table',
      timestampColumn: 'occurred_at',
      retentionDays: 30,
    });
    registerRetentionPolicy({
      id: 'second.ok',
      ownerTag: 'test',
      schema: 'observability',
      tableName: 'migration_events',
      timestampColumn: 'occurred_at',
      retentionDays: 90,
    });
    const calls: Array<{ sql: string; params?: unknown[] }> = [];
    const ds = makeDs({
      throwOn: /"broken_table"/,
      rowsPerQuery: Array.from({ length: 3 }),
      calls,
    });
    const svc = new RetentionEnforcementService(ds);
    const reports = await svc.enforceAllOnce();
    expect(reports).toHaveLength(2);
    expect(reports[0]?.error).toBeDefined(); // broken_table
    expect(reports[0]?.deleted).toBe(0);
    expect(reports[1]?.error).toBeUndefined();
    expect(reports[1]?.deleted).toBe(3); // migration_events succeeded
  });

  it('iterates all registered policies in registration order', async () => {
    registerRetentionPolicy({
      id: 'a',
      ownerTag: 't',
      schema: 'observability',
      tableName: 'a_table',
      timestampColumn: 'occurred_at',
      retentionDays: 30,
    });
    registerRetentionPolicy({
      id: 'b',
      ownerTag: 't',
      schema: 'observability',
      tableName: 'b_table',
      timestampColumn: 'occurred_at',
      retentionDays: 60,
    });
    registerRetentionPolicy({
      id: 'c',
      ownerTag: 't',
      schema: 'observability',
      tableName: 'c_table',
      timestampColumn: 'occurred_at',
      retentionDays: 90,
    });
    const calls: Array<{ sql: string; params?: unknown[] }> = [];
    const ds = makeDs({ rowsPerQuery: [], calls });
    const svc = new RetentionEnforcementService(ds);
    const reports = await svc.enforceAllOnce();
    expect(reports.map((r) => r.policyId)).toEqual(['a', 'b', 'c']);
    expect(calls.map((c) => c.sql.match(/"([a-z_]+_table)"/)?.[1])).toEqual([
      'a_table',
      'b_table',
      'c_table',
    ]);
  });

  it('enforceOne — single-policy entry point returns deletion count', async () => {
    registerRetentionPolicy({
      id: 'single',
      ownerTag: 't',
      schema: 'observability',
      tableName: 'x',
      timestampColumn: 'c',
      retentionDays: 30,
    });
    const ds = makeDs({ rowsPerQuery: Array.from({ length: 11 }) });
    const svc = new RetentionEnforcementService(ds);
    const deleted = await svc.enforceOne(
      {
        id: 'single',
        ownerTag: 't',
        schema: 'observability',
        tableName: 'x',
        timestampColumn: 'c',
        retentionDays: 30,
      },
      new Date(),
    );
    expect(deleted).toBe(11);
  });

  it('cutoff = now - retentionDays days (millisecond accurate)', async () => {
    registerRetentionPolicy({
      id: 'cutoff.test',
      ownerTag: 't',
      schema: 'observability',
      tableName: 'x',
      timestampColumn: 'c',
      retentionDays: 7,
    });
    const calls: Array<{ sql: string; params?: unknown[] }> = [];
    const ds = makeDs({ rowsPerQuery: [], calls });
    const svc = new RetentionEnforcementService(ds);
    const now = new Date('2026-04-21T00:00:00.000Z');
    await svc.enforceAllOnce(now);
    expect(defined(calls[0], 'Expected cutoff query').params?.[0]).toBe('2026-04-14T00:00:00.000Z');
  });
});
