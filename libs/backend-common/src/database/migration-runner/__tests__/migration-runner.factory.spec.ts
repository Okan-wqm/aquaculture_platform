import { Logger } from '@nestjs/common';

import { TENANT_AWARE_SCHEMAS } from '../../tenant-aware-schemas';
import { createMigrationRunnerService } from '../migration-runner.service';

/**
 * Factory-level specs for createMigrationRunnerService (ORPHAN-MEDIUM-386).
 *
 * 1. tenantAware=true is structurally rejected for schemas outside the
 *    TENANT_AWARE_SCHEMAS SSoT — the misconfiguration that would mint a
 *    stray `migrations_<svc>` journal inside every tenant schema throws at
 *    factory time instead of writing to the database at deploy time.
 *
 * 2. The migration journal's location is pinned by EXPLICIT schema
 *    qualification, never by the session search_path or the driver's
 *    default schema. The real TypeORM MigrationExecutor is driven against
 *    a stub DataSource whose driver has NO default schema (the per-tenant
 *    service shape) — without the runner's explicit scoping the ledger
 *    probe would target the bare table name and resolve via search_path.
 */

const TENANT_SCHEMA = 'tenant_00000000000000aa';

interface RecordingHarness {
  dataSource: {
    options: { migrationsTableName?: string };
    driver: {
      options: { type: string; schema?: string };
      database?: string;
      buildTableName: (tableName: string, schema?: string, database?: string) => string;
    };
    migrations: unknown[];
    createQueryRunner: () => unknown;
    query: (sql: string) => Promise<unknown>;
  };
  /** Every table name the executor's ledger-existence probe received. */
  hasTableCalls: string[];
}

function buildHarness(tenantSchemas: string[]): RecordingHarness {
  const hasTableCalls: string[] = [];

  const createQueryRunner = (): unknown => {
    let pinnedSchema = '';
    return {
      connect: (): Promise<void> => Promise.resolve(),
      release: (): Promise<void> => Promise.resolve(),
      query: (sql: string): Promise<unknown> => {
        if (sql.includes('pg_try_advisory_lock')) {
          return Promise.resolve([{ locked: true }]);
        }
        if (sql.includes('pg_advisory_unlock')) {
          return Promise.resolve([]);
        }
        const pinMatch = /SET search_path TO "([^"]+)"/.exec(sql);
        if (pinMatch?.[1] !== undefined) {
          pinnedSchema = pinMatch[1];
          return Promise.resolve([]);
        }
        if (sql.includes('current_schema()')) {
          return Promise.resolve([{ current_schema: pinnedSchema }]);
        }
        return Promise.resolve([]);
      },
      // The REAL MigrationExecutor.getExecutedMigrations probes the ledger
      // table through hasTable — recording its argument pins the exact
      // qualified name the journal is read from / created at. Returning
      // false short-circuits to "no executed migrations" (and with zero
      // registered migrations, zero pending), so the runner completes
      // without touching a database.
      hasTable: (tableName: string): Promise<boolean> => {
        hasTableCalls.push(tableName);
        return Promise.resolve(false);
      },
    };
  };

  return {
    dataSource: {
      options: { migrationsTableName: 'migrations' },
      driver: {
        // Per-tenant service shape: NO default schema on the driver — table
        // resolution normally rides the session search_path. Exactly the
        // configuration where an unqualified journal name would be created
        // in whatever schema the search_path points at.
        options: { type: 'postgres' },
        buildTableName: (tableName: string, schema?: string): string =>
          schema !== undefined && schema !== '' ? `${schema}.${tableName}` : tableName,
      },
      migrations: [],
      createQueryRunner,
      query: (sql: string): Promise<unknown> => {
        if (sql.includes('information_schema.schemata')) {
          return Promise.resolve(tenantSchemas.map((schema) => ({ schema_name: schema })));
        }
        return Promise.resolve([]);
      },
    },
    hasTableCalls,
  };
}

function buildConfigService(): { get: (key: string, def?: string) => string | undefined } {
  return {
    get: (key: string, def?: string): string | undefined => {
      if (key === 'DATABASE_MIGRATIONS_RUN') return 'true';
      return def;
    },
  };
}

beforeAll(() => {
  // Silence the runner's operational logs — the specs assert behavior, not
  // output. Jest gives each spec file its own module registry, so this does
  // not leak into other suites.
  Logger.overrideLogger([]);
});

describe('createMigrationRunnerService — tenantAware SSoT gate (ORPHAN-MEDIUM-386)', () => {
  it('throws at factory time when tenantAware=true is forced on a non-tenant-aware schema', () => {
    expect(() => createMigrationRunnerService('auth', { tenantAware: true })).toThrow(
      /TENANT_AWARE_SCHEMAS/,
    );
    expect(() => createMigrationRunnerService('auth', { tenantAware: true })).toThrow(
      /migrations_auth/,
    );
    expect(() => createMigrationRunnerService('billing', { tenantAware: true })).toThrow(
      /TENANT_AWARE_SCHEMAS/,
    );
  });

  it('accepts tenantAware=true for every schema in the SSoT set', () => {
    for (const schema of TENANT_AWARE_SCHEMAS) {
      expect(() => createMigrationRunnerService(schema, { tenantAware: true })).not.toThrow();
    }
  });

  it('accepts platform-level schemas without an override (single-schema mode)', () => {
    expect(() => createMigrationRunnerService('auth')).not.toThrow();
    expect(() => createMigrationRunnerService('billing')).not.toThrow();
  });

  it('accepts tenantAware=false opt-out on a tenant-aware schema (e2e source-only mode)', () => {
    expect(() => createMigrationRunnerService('messaging', { tenantAware: false })).not.toThrow();
  });
});

describe('createMigrationRunnerService — journal schema-qualification', () => {
  it('probes the SOURCE journal with an explicit schema despite a schema-less driver', async () => {
    const harness = buildHarness([]);
    const Runner = createMigrationRunnerService('auth');
    const runner = new Runner(harness.dataSource, buildConfigService());

    await runner.onApplicationBootstrap();

    expect(harness.hasTableCalls).toEqual(['auth.migrations']);
  });

  it('probes each tenant journal as tenant_<uuid>.migrations_<source> (fan-out phase)', async () => {
    const harness = buildHarness([TENANT_SCHEMA]);
    const Runner = createMigrationRunnerService('farm');
    const runner = new Runner(harness.dataSource, buildConfigService());

    await runner.onApplicationBootstrap();

    expect(harness.hasTableCalls).toEqual(['farm.migrations', `${TENANT_SCHEMA}.migrations_farm`]);
  });

  it('restores the DataSource-level migrationsTableName after the fan-out mutation window', async () => {
    const harness = buildHarness([TENANT_SCHEMA]);
    const Runner = createMigrationRunnerService('farm');
    const runner = new Runner(harness.dataSource, buildConfigService());

    await runner.onApplicationBootstrap();

    expect(harness.dataSource.options.migrationsTableName).toBe('migrations');
  });
});
