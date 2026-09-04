/**
 * Tenant Provisioning Replay Gate — DATA-CRITICAL-010
 * ============================================================================
 *
 * Runs the REAL provisioner against a live database and asserts a new tenant
 * actually gets its tables.
 *
 * # Why this test exists
 *
 * Until it did, no spec in the repository entered the `PROVISION` branch at
 * all. `platform-bootstrap.integration.spec.ts` only ever enqueues a
 * `RECONCILE` job and bails because the schema does not exist;
 * `bootstrap-from-scratch.spec.ts` builds the SOURCE schemas and opens no
 * tenant; `tenant-clone-parity.spec.ts` provisions its fixture through the
 * retired `CREATE TABLE … LIKE` path and says so in its own docblock. So the
 * one thing a super admin does first — create a tenant — was the one thing CI
 * never executed.
 *
 * That is how DATA-CRITICAL-010 survived four months: every tenant-aware
 * Baseline was fully source-schema-qualified, provisioning is migration REPLAY
 * with `search_path` pinned to `tenant_<uuid>`, and a qualified identifier
 * ignores `search_path` — so the replay wrote to the source schema and then
 * aborted on the first duplicate relation. Nothing red anywhere.
 *
 * # What it does
 *
 *   1. Enqueues a real PROVISION job through
 *      `platform.request_tenant_schema_provisioning` — the same SECURITY
 *      DEFINER entry point the admin-api saga calls.
 *   2. Spawns the production entry point,
 *      `apps/db-migrate/src/main.ts tenant-schema-provisioner --once`. Not an
 *      imported function, not a reimplementation: the binary a deploy runs.
 *   3. Asserts the outcome against `MODULE_SCHEMAS`, which is the same registry
 *      the entity layer, the DDL guard and the de-qualification script obey:
 *        - every per-tenant table of every tenant-aware service EXISTS in the
 *          tenant schema;
 *        - every cross-tenant infrastructure table does NOT (an audit ledger or
 *          outbox cloned per tenant silently swallows platform-wide events);
 *        - each `migrations_<source>` ledger exists and its head matches the
 *          source schema's head, so the tenant is not merely non-empty but
 *          actually caught up.
 *
 * The tenant is deliberately LEFT IN PLACE. `schema-invariants.spec.ts` B.5a
 * asserts every tenant-scoped schema has at least one tenant clone, and it runs
 * after this spec in the same job — against zero tenants it was passing
 * vacuously on every CI run, because tenant-clone-parity drops its fixture in
 * `afterAll`. A real tenant makes that assertion mean something.
 *
 * # When this test fails
 *
 *   - `relation "…" already exists`: a migration is writing to the source
 *     schema during a tenant pass — qualified DDL, or a `pinSearchPath` to the
 *     source. `tenant-aware-migration-ddl-guard.spec.ts` catches both spellings
 *     statically; this catches whatever it misses.
 *   - A missing per-tenant table with a SUCCEEDED job: a migration recorded
 *     "applied" without its DDL landing. Give it a `postCondition()`.
 *   - An infrastructure table present in the tenant: it lost its `schema:`
 *     qualifier, or `MODULE_SCHEMAS` moved it out of `infrastructureTables`.
 *   - A ledger head behind the source: the replay stopped early and the job
 *     still reported success.
 */

import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';

import { MODULE_SCHEMAS } from '@aquaculture/backend-common/database';

import { TestDatabase } from '../../helpers/db.helper';

const REPO_ROOT = resolve(__dirname, '..', '..', '..');

/** The services whose migrations are replayed into every tenant schema. */
const TENANT_AWARE_SCHEMAS: ReadonlyArray<string> = [
  'farm',
  'sensor',
  'hr',
  'messaging',
  'hydroponics',
  'ai',
  'alert',
];

interface ModuleRegistry {
  readonly perTenant: readonly string[];
  readonly infrastructure: readonly string[];
}

function registryFor(schema: string): ModuleRegistry {
  const entry = MODULE_SCHEMAS.find((module) => module.sourceSchema === schema);
  if (entry === undefined) {
    throw new Error(`MODULE_SCHEMAS has no entry for source schema "${schema}"`);
  }
  return {
    perTenant: [...entry.tables, ...(entry.referenceDataTables ?? [])],
    infrastructure: [...(entry.infrastructureTables ?? [])],
  };
}

/**
 * `platform.request_tenant_schema_provisioning` derives the schema name from
 * the tenant id and rejects any mismatch, so the two must be generated
 * together. A random uuid also keeps this spec off
 * `bootstrap-from-scratch.spec.ts`'s fixed `tenant_aaaaaaaaaaaaaaaa`.
 */
function newTenant(): { tenantId: string; schemaName: string } {
  const tenantId = randomUUID();
  return {
    tenantId,
    schemaName: `tenant_${tenantId.replace(/-/g, '').slice(0, 16)}`,
  };
}

/**
 * Both identifiers are already constrained — `schemaName` by
 * `^tenant_[a-f0-9]{16}$` and `sourceSchema` by the fixed list above — but the
 * ledger queries below interpolate them, so the constraint is restated at the
 * point of use rather than assumed from three screens away.
 */
function quoteIdent(identifier: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(identifier)) {
    throw new Error(`refusing to interpolate unsafe identifier: ${identifier}`);
  }
  return `"${identifier}"`;
}

/** Run the production provisioner entry point exactly as a deploy does. */
function runProvisionerOnce(): { status: number | null; output: string } {
  const result = spawnSync(
    'npx',
    [
      'ts-node',
      '--project',
      'apps/db-migrate/tsconfig.app.json',
      '-r',
      'tsconfig-paths/register',
      'apps/db-migrate/src/main.ts',
      'tenant-schema-provisioner',
      '--once',
    ],
    { cwd: REPO_ROOT, encoding: 'utf8', env: process.env, maxBuffer: 64 * 1024 * 1024 },
  );
  return {
    status: result.status,
    output: `${result.stdout ?? ''}${result.stderr ?? ''}`,
  };
}

describe('INVARIANT (DATA-CRITICAL-010): a new tenant can actually be provisioned', () => {
  const db = new TestDatabase();
  const { tenantId, schemaName } = newTenant();
  let provisioner: { status: number | null; output: string };

  beforeAll(async () => {
    await db.connect();

    await db.query(
      `SELECT platform.request_tenant_schema_provisioning($1::uuid, $2::uuid, $3::text, '{}'::jsonb)`,
      [randomUUID(), tenantId, schemaName],
    );

    provisioner = runProvisionerOnce();
  }, 900_000);

  afterAll(async () => {
    // Nothing is cleaned up: the tenant schema stays so schema-invariants B.5a
    // has a real clone to assert against, and its job row stays with it so the
    // ledger and the schema remain a coherent pair for anyone reading the
    // database after a failed run.
    await db.close();
  });

  it('the provisioner exits cleanly', () => {
    if (provisioner.status !== 0) {
      // The provisioner's own output is the diagnosis — a qualified identifier
      // shows up here as `relation "…" already exists` naming the table.
      throw new Error(
        `tenant-schema-provisioner exited ${provisioner.status}:\n` +
          provisioner.output.slice(-8000),
      );
    }
    expect(provisioner.status).toBe(0);
  });

  it('records the job as SUCCEEDED rather than merely finishing', async () => {
    const { rows } = await db.query<{ status: string; error_message: string | null }>(
      `SELECT status, error_message FROM platform.tenant_schema_jobs
        WHERE tenant_id = $1::uuid AND job_type = 'PROVISION'
        ORDER BY created_at DESC LIMIT 1`,
      [tenantId],
    );
    expect(rows).toHaveLength(1);
    expect({ status: rows[0]?.status, error: rows[0]?.error_message }).toEqual({
      status: 'SUCCEEDED',
      error: null,
    });
  });

  it('creates the tenant schema', async () => {
    const { rows } = await db.query<{ exists: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM information_schema.schemata WHERE schema_name = $1) AS exists`,
      [schemaName],
    );
    expect(rows[0]?.exists).toBe(true);
  });

  it.each(TENANT_AWARE_SCHEMAS)(
    'lands every per-tenant %s table in the tenant schema',
    async (sourceSchema) => {
      const { perTenant } = registryFor(sourceSchema);
      const { rows } = await db.query<{ table_name: string }>(
        `SELECT table_name FROM information_schema.tables WHERE table_schema = $1`,
        [schemaName],
      );
      const present = new Set(rows.map((row) => row.table_name));
      const missing = perTenant.filter((table) => !present.has(table)).sort();
      expect(missing).toEqual([]);
    },
    120_000,
  );

  it.each(TENANT_AWARE_SCHEMAS)(
    'keeps every cross-tenant %s infrastructure table OUT of the tenant schema',
    async (sourceSchema) => {
      const { infrastructure } = registryFor(sourceSchema);
      // `migrations` is the per-service ledger name in the SOURCE schema; the
      // tenant copy is `migrations_<source>`, asserted separately below.
      const crossTenant = infrastructure.filter((table) => table !== 'migrations');
      if (crossTenant.length === 0) return;
      const { rows } = await db.query<{ table_name: string }>(
        `SELECT table_name FROM information_schema.tables
          WHERE table_schema = $1 AND table_name = ANY($2::text[])`,
        [schemaName, crossTenant],
      );
      expect(rows.map((row) => row.table_name).sort()).toEqual([]);
    },
    120_000,
  );

  it.each(TENANT_AWARE_SCHEMAS)(
    'brings the %s ledger up to the source head rather than stopping early',
    async (sourceSchema) => {
      const ledger = `migrations_${sourceSchema}`;
      const { rows: head } = await db.query<{ name: string }>(
        `SELECT name FROM ${quoteIdent(schemaName)}.${quoteIdent(ledger)}
          ORDER BY timestamp DESC, id DESC LIMIT 1`,
        [],
      );
      const { rows: sourceHead } = await db.query<{ name: string }>(
        `SELECT name FROM ${quoteIdent(sourceSchema)}."migrations"
          ORDER BY timestamp DESC, id DESC LIMIT 1`,
        [],
      );
      expect({ schema: sourceSchema, head: head[0]?.name }).toEqual({
        schema: sourceSchema,
        head: sourceHead[0]?.name,
      });
    },
    120_000,
  );
});
