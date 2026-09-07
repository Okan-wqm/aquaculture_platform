import 'reflect-metadata';
import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';
import type { DataSource } from 'typeorm';

import { clearRetentionPolicyRegistry, registerRetentionPolicy } from '../retention-policy';
import { RetentionEnforcementService } from '../retention-enforcement.service';

@Entity('migration_events', { schema: 'observability' })
class MigrationEventFixture {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'timestamptz', name: 'occurred_at' })
  occurredAt!: Date;
}

@Entity('emergency_overrides', { schema: 'observability' })
class EmergencyOverrideFixture {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;
}

@Entity('background_jobs', { schema: 'admin' })
class JobFixture {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar' })
  status!: string;

  @Column({ type: 'timestamptz', nullable: true })
  completedAt?: Date;
}

@Entity('broken_table', { schema: 'observability' })
class BrokenTableFixture {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'timestamptz', name: 'occurred_at' })
  occurredAt!: Date;
}

@Entity('a_table', { schema: 'observability' })
class ATableFixture {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'timestamptz', name: 'occurred_at' })
  occurredAt!: Date;
}

@Entity('b_table', { schema: 'observability' })
class BTableFixture {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'timestamptz', name: 'occurred_at' })
  occurredAt!: Date;
}

@Entity('c_table', { schema: 'observability' })
class CTableFixture {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'timestamptz', name: 'occurred_at' })
  occurredAt!: Date;
}

@Entity('x', { schema: 'observability' })
class XFixture {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'timestamptz' })
  c!: Date;
}

function makeDs(
  behavior: {
    rowsPerQuery?: unknown[];
    throwOn?: RegExp;
    calls?: Array<{ sql: string; params?: unknown[] }>;
  } = {},
): DataSource {
  const calls = behavior.calls ?? [];
  return {
    query: jest.fn(async (sql: string, params?: unknown[]) => {
      calls.push({ sql, params });
      if (behavior.throwOn && behavior.throwOn.test(sql)) {
        throw new Error(`DS query failed for sql matching ${behavior.throwOn}`);
      }
      // Emulate RETURNING 1 — return an array whose length is the
      // deletion count.
      return behavior.rowsPerQuery ?? [];
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
      entity: MigrationEventFixture,
      timestampProperty: 'occurredAt',
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
    expect(calls[0]!.sql).toContain('DELETE FROM "observability"."migration_events"');
    expect(calls[0]!.sql).toContain('"occurred_at" < $1');
    expect(calls[0]!.sql).toContain('RETURNING 1');
    // Cutoff = 2026-04-21 - 395d
    const expectedCutoff = new Date(now.getTime() - 395 * 86_400_000).toISOString();
    expect(calls[0]!.params).toEqual([expectedCutoff]);
  });

  it('legal-hold predicate AND-NOT wraps into WHERE; hold rows preserved', async () => {
    registerRetentionPolicy({
      id: 'emergency_overrides.7y',
      ownerTag: 'soc2-cc6.1',
      entity: EmergencyOverrideFixture,
      timestampProperty: 'createdAt',
      retentionDays: 2556,
      legalHoldClause: 'revoked_at IS NULL AND expires_at > NOW()',
    });
    const calls: Array<{ sql: string; params?: unknown[] }> = [];
    const ds = makeDs({ rowsPerQuery: [], calls });
    const svc = new RetentionEnforcementService(ds);
    await svc.enforceAllOnce(new Date('2026-04-21T12:00:00.000Z'));
    expect(calls[0]!.sql).toContain('AND NOT (revoked_at IS NULL AND expires_at > NOW())');
  });

  it('policy-level failure does NOT halt subsequent policies', async () => {
    registerRetentionPolicy({
      id: 'first.fail',
      ownerTag: 'test',
      entity: BrokenTableFixture,
      timestampProperty: 'occurredAt',
      retentionDays: 30,
    });
    registerRetentionPolicy({
      id: 'second.ok',
      ownerTag: 'test',
      entity: MigrationEventFixture,
      timestampProperty: 'occurredAt',
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
      entity: ATableFixture,
      timestampProperty: 'occurredAt',
      retentionDays: 30,
    });
    registerRetentionPolicy({
      id: 'b',
      ownerTag: 't',
      entity: BTableFixture,
      timestampProperty: 'occurredAt',
      retentionDays: 60,
    });
    registerRetentionPolicy({
      id: 'c',
      ownerTag: 't',
      entity: CTableFixture,
      timestampProperty: 'occurredAt',
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
    const policy = registerRetentionPolicy({
      id: 'single',
      ownerTag: 't',
      entity: XFixture,
      timestampProperty: 'c',
      retentionDays: 30,
    });
    const ds = makeDs({ rowsPerQuery: Array.from({ length: 11 }) });
    const svc = new RetentionEnforcementService(ds);
    const deleted = await svc.enforceOne(policy, new Date());
    expect(deleted).toBe(11);
  });

  it('cutoff = now - retentionDays days (millisecond accurate)', async () => {
    registerRetentionPolicy({
      id: 'cutoff.test',
      ownerTag: 't',
      entity: XFixture,
      timestampProperty: 'c',
      retentionDays: 7,
    });
    const calls: Array<{ sql: string; params?: unknown[] }> = [];
    const ds = makeDs({ rowsPerQuery: [], calls });
    const svc = new RetentionEnforcementService(ds);
    const now = new Date('2026-04-21T00:00:00.000Z');
    await svc.enforceAllOnce(now);
    expect(calls[0]!.params?.[0]).toBe('2026-04-14T00:00:00.000Z');
  });
});

describe('RetentionEnforcementService — equality filters (ADR-0012)', () => {
  beforeEach(() => clearRetentionPolicyRegistry());
  afterEach(() => clearRetentionPolicyRegistry());

  it('binds where-filters as parameters after the cutoff and the hold params', async () => {
    registerRetentionPolicy({
      id: 'jobs.completed.30d',
      ownerTag: 'ops',
      entity: JobFixture,
      timestampProperty: 'completedAt',
      retentionDays: 30,
      where: { status: 'completed' },
    });
    const calls: Array<{ sql: string; params?: unknown[] }> = [];
    const svc = new RetentionEnforcementService(makeDs({ calls }));
    const now = new Date('2026-09-05T12:00:00.000Z');
    await svc.enforceAllOnce(now);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.sql).toContain('DELETE FROM "admin"."background_jobs"');
    expect(calls[0]!.sql).toContain('"completedAt" < $1');
    expect(calls[0]!.sql).toContain('AND "status" = $2');
    expect(calls[0]!.params).toEqual([
      new Date(now.getTime() - 30 * 86_400_000).toISOString(),
      'completed',
    ]);
  });
});
