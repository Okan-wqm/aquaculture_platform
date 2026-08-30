import { TENANT_AWARE_SCHEMAS } from '@aquaculture/backend-common/database';
import type { QueryRunner } from 'typeorm';

import { healStrayTenantMigrationJournals } from '../stray-tenant-journal-heal';

/**
 * London-school unit tests for the stray tenant-journal self-heal
 * (ORPHAN-MEDIUM-386). The heal operates on a caller-owned QueryRunner, so a
 * scripted mock pins the classification + drop-guard decisions without a
 * live DB:
 *
 *   - stray journal (source NOT tenant-aware, source journal present) → DROP
 *   - tenant-aware fan-out ledger → NEVER touched
 *   - unattributable candidate (no source journal) → kept, warned
 *   - healed DB → no DROP issued (idempotent)
 */

const TENANT = 'tenant_7f6b08ab90e246d3';

interface ScriptedResponse {
  match: (sql: string, params?: unknown[]) => boolean;
  rows: unknown;
}

function mockRunner(responses: ScriptedResponse[]): {
  runner: QueryRunner;
  executed: Array<{ sql: string; params?: unknown[] }>;
} {
  const executed: Array<{ sql: string; params?: unknown[] }> = [];
  const query = jest.fn((sql: string, params?: unknown[]) => {
    executed.push({ sql, ...(params !== undefined ? { params } : {}) });
    const hit = responses.find((r) => r.match(sql, params));
    return Promise.resolve(hit ? hit.rows : []);
  });
  return { runner: { query } as Partial<QueryRunner> as QueryRunner, executed };
}

const matchEnumeration = (sql: string): boolean =>
  sql.includes(`table_name ~ '^migrations_[a-z_]+$'`);
const matchSourceJournalProbe = (sql: string, params?: unknown[]): boolean =>
  sql.includes('SELECT EXISTS') && Array.isArray(params);

describe('healStrayTenantMigrationJournals', () => {
  it('drops a stray journal when the owning source schema has its authoritative journal', async () => {
    const { runner, executed } = mockRunner([
      {
        match: matchEnumeration,
        rows: [{ tenant_schema: TENANT, table_name: 'migrations_auth' }],
      },
      {
        match: (sql, params) => matchSourceJournalProbe(sql, params) && params?.[0] === 'auth',
        rows: [{ exists: true }],
      },
      {
        match: (sql) => sql.includes(`FROM "${TENANT}"."migrations_auth"`),
        rows: [{ name: 'Baseline1800000000000' }],
      },
    ]);
    const log = jest.fn();

    const results = await healStrayTenantMigrationJournals(runner, log);

    expect(results).toEqual([
      {
        tenantSchema: TENANT,
        table: 'migrations_auth',
        sourceSchema: 'auth',
        outcome: 'dropped',
        droppedEntries: ['Baseline1800000000000'],
      },
    ]);
    expect(executed.map((e) => e.sql)).toContain(
      `DROP TABLE IF EXISTS "${TENANT}"."migrations_auth"`,
    );
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({
        level: 'warn',
        message: expect.stringContaining('Stray tenant-schema migration journal dropped'),
        tenantSchema: TENANT,
        table: 'migrations_auth',
        sourceSchema: 'auth',
        authoritativeJournal: 'auth.migrations',
        droppedEntryCount: 1,
        droppedEntries: ['Baseline1800000000000'],
      }),
    );
  });

  it('NEVER drops a tenant-aware fan-out ledger (migrations_farm and friends)', async () => {
    const tenantAwareLedgers = [...TENANT_AWARE_SCHEMAS].map((source) => ({
      tenant_schema: TENANT,
      table_name: `migrations_${source}`,
    }));
    const { runner, executed } = mockRunner([
      { match: matchEnumeration, rows: tenantAwareLedgers },
    ]);
    const log = jest.fn();

    const results = await healStrayTenantMigrationJournals(runner, log);

    expect(results).toHaveLength(TENANT_AWARE_SCHEMAS.size);
    for (const result of results) {
      expect(result.outcome).toBe('kept_tenant_aware_ledger');
    }
    expect(executed.some((e) => e.sql.startsWith('DROP TABLE'))).toBe(false);
    // Legitimate ledgers are routine — the heal stays silent about them.
    expect(log).not.toHaveBeenCalled();
  });

  it('keeps + warns when the owning source schema has no authoritative journal (fail-closed)', async () => {
    const { runner, executed } = mockRunner([
      {
        match: matchEnumeration,
        rows: [{ tenant_schema: TENANT, table_name: 'migrations_farm_old' }],
      },
      {
        match: (sql, params) => matchSourceJournalProbe(sql, params) && params?.[0] === 'farm_old',
        rows: [{ exists: false }],
      },
    ]);
    const log = jest.fn();

    const results = await healStrayTenantMigrationJournals(runner, log);

    expect(results).toEqual([
      {
        tenantSchema: TENANT,
        table: 'migrations_farm_old',
        sourceSchema: 'farm_old',
        outcome: 'kept_missing_source_journal',
        droppedEntries: [],
      },
    ]);
    expect(executed.some((e) => e.sql.startsWith('DROP TABLE'))).toBe(false);
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({
        level: 'warn',
        message: expect.stringContaining('provenance cannot be proven'),
        sourceSchema: 'farm_old',
      }),
    );
  });

  it('is idempotent — a healed database issues no DROP and returns no results', async () => {
    const { runner, executed } = mockRunner([{ match: matchEnumeration, rows: [] }]);
    const log = jest.fn();

    const results = await healStrayTenantMigrationJournals(runner, log);

    expect(results).toEqual([]);
    expect(executed.some((e) => e.sql.startsWith('DROP TABLE'))).toBe(false);
    expect(log).not.toHaveBeenCalled();
  });

  it('bounds lock/statement wait on the session before touching anything', async () => {
    const { runner, executed } = mockRunner([{ match: matchEnumeration, rows: [] }]);

    await healStrayTenantMigrationJournals(runner, jest.fn());

    expect(executed[0]?.sql).toBe(`SET lock_timeout = '2s'`);
    expect(executed[1]?.sql).toBe(`SET statement_timeout = '30s'`);
  });

  it('rejects enumeration rows with unsafe identifiers (defense-in-depth before interpolation)', async () => {
    const { runner } = mockRunner([
      {
        match: matchEnumeration,
        rows: [{ tenant_schema: 'tenant_evil"; DROP SCHEMA auth', table_name: 'migrations_auth' }],
      },
    ]);

    await expect(healStrayTenantMigrationJournals(runner, jest.fn())).rejects.toThrow(
      /Unsafe stray-journal identifier/,
    );
  });

  it('never classifies the live stray (migrations_auth) as tenant-aware', () => {
    // Pins the SSoT relationship the guard depends on: auth must stay out of
    // TENANT_AWARE_SCHEMAS for the heal (and the runner factory gate) to hold.
    expect(TENANT_AWARE_SCHEMAS.has('auth')).toBe(false);
  });
});
