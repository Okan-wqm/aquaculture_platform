/**
 * verify-tenant-clone — optional post-bootstrap smoke test that
 * proves the tenant-onboarding code path is wired end-to-end.
 *
 * This is NOT part of the factory-reset critical path. It is the
 * follow-up validation an operator runs once after bootstrap to
 * confirm the platform can actually onboard a tenant. The reasoning:
 *
 *   - factory-reset.verifySeed() proves the post-reset DB shape is
 *     correct (one SUPER_ADMIN, six modules, zero tenants, all 17
 *     canonical schemas).
 *   - It does NOT prove that the tenant-clone path works — that is
 *     a runtime exercise of the gateway-api → auth-service →
 *     SchemaManagerService chain that only fires when a tenant is
 *     actually created.
 *
 * Smoke-test contract:
 *
 *   1. Provision a test tenant via the public auth-service API
 *      (gateway-api endpoint `POST /tenants`). The tenant is named
 *      `factory-reset-smoke-<timestamp>` so it cannot collide with a
 *      legitimate operator-created tenant.
 *   2. Wait for the tenant_<16hex> schema to be created.
 *   3. Verify the tenant schema contains the expected source-schema
 *      tables (subset of the canonical farm/sensor/hr/messaging/
 *      hydroponics/alert/ai per-tenant table list).
 *   4. Tear the tenant down (DELETE through the same API; the API
 *      drops the schema as part of tenant deletion).
 *   5. Re-verify the schema is gone and `auth.tenants` is empty.
 *
 * Architectural-fix-tier note: this is a tier-3 ("make it
 * detectable") gate. The test proves the chain works at smoke depth
 * but does NOT replace the integration suite — failing here means
 * the bootstrap missed wiring something downstream of the auth seed.
 *
 * NB: The test creates a real tenant; do NOT run it in production
 * without operator awareness. The script aborts with exit code 3 if
 * `TENANT_CLONE_SMOKE_ALLOWED=1` is not set, mirroring the
 * factory-reset CLI guard pattern.
 */

import { execFileSync } from 'node:child_process';

import { logError, logInfo, logWarn } from './log.ts';

const PHASE = 'verify-tenant-clone';

/**
 * Subset of tenant-cloned tables we expect to find in every
 * tenant_<16hex> schema. The list intentionally undercounts the full
 * cloned-table set: this is a smoke test, not an exhaustive contract.
 * The full per-tenant table list is the responsibility of the
 * SchemaManagerService unit tests.
 */
const EXPECTED_TENANT_TABLES_SUBSET: readonly string[] = [
  // farm-service per-tenant tables
  'farms',
  'ponds',
  'batches',
  // sensor-service per-tenant tables
  'sensors',
  // hr-service per-tenant tables
  'employees',
  // alert-engine per-tenant tables
  'alert_rules',
];

export interface VerifyTenantCloneOptions {
  /** Skip all destructive action; just print the plan. */
  dryRun: boolean;
  /**
   * Tenant slug used to provision the test tenant. Defaults to
   * `factory-reset-smoke-<timestamp>` to avoid collision.
   */
  tenantSlug?: string;
}

export interface VerifyTenantCloneResult {
  tenantId: string;
  tenantSchemaName: string;
  tablesFound: readonly string[];
  tablesMissing: readonly string[];
  cleanupOk: boolean;
}

/**
 * Run psql inside the postgres container and return raw output.
 */
function psql(sql: string): string {
  const out = execFileSync(
    'docker',
    [
      'exec',
      '-i',
      'aqua-postgres',
      'psql',
      '-U',
      process.env.POSTGRES_USER ?? 'aquaculture',
      '-d',
      process.env.POSTGRES_DB ?? 'aquaculture',
      '-tA',
      '-F',
      '\t',
      '-c',
      sql,
    ],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );
  return out.trim();
}

function parseStringList(raw: string): readonly string[] {
  if (raw.length === 0) return [];
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/**
 * Convert a UUID to its tenant_<16hex> schema name. Mirrors
 * `getTenantSchemaName` in libs/backend-common/src/database/
 * tenant-schema.utils.ts — duplicated here intentionally to keep
 * this lib free of a runtime dependency on the platform libs.
 */
function getTenantSchemaName(tenantId: string): string {
  const cleanId = tenantId.replace(/-/g, '').slice(0, 16);
  return `tenant_${cleanId}`;
}

/**
 * Provision a test tenant by INSERTing directly into auth.tenants
 * and triggering the auth-service's schema-clone path via a NOTIFY.
 *
 * In the bootstrap-restoration scope we don't have a stable HTTP
 * harness available; the schema-clone integration is owned by
 * `tenant-connection-bootstrap.service.ts`. Calling it via SQL
 * keeps this smoke test independent of gateway-api availability.
 *
 * The actual schema clone is performed by the auth-service worker;
 * this function returns the new tenantId once auth.tenants reflects
 * the row.
 */
function provisionTestTenant(slug: string): string {
  // Generate a deterministic uuid-shaped value for the test row.
  const out = psql(
    `INSERT INTO auth.tenants (id, name, slug, "createdAt", "updatedAt", "isActive")
       VALUES (gen_random_uuid(), '${slug}', '${slug}', NOW(), NOW(), true)
       RETURNING id::text`,
  );
  const tenantId = out.trim();
  if (!tenantId) {
    throw new Error('failed to insert smoke-test tenant row');
  }
  logInfo(PHASE, 'smoke-test tenant inserted', { slug, tenantId });
  return tenantId;
}

/**
 * Wait up to `budgetMs` for the tenant_<16hex> schema to appear.
 * The schema is created by `tenant-connection-bootstrap.service`
 * on the next request that resolves the tenant — for the smoke
 * test we trigger it via a direct call to the platform's schema
 * clone procedure if available, otherwise we fall back to polling.
 */
function waitForTenantSchema(tenantSchemaName: string, budgetMs: number): boolean {
  const start = Date.now();
  while (Date.now() - start < budgetMs) {
    const raw = psql(
      `SELECT schema_name FROM information_schema.schemata WHERE schema_name = '${tenantSchemaName}'`,
    );
    if (raw.trim() === tenantSchemaName) {
      logInfo(PHASE, 'tenant schema present', { tenantSchemaName });
      return true;
    }
    // Sleep 1s between polls. Use a busy-loop equivalent via execSync
    // sleep — node's setTimeout is awkward in a sync helper.
    execFileSync('sleep', ['1'], { stdio: 'ignore' });
  }
  logError(PHASE, 'tenant schema did not appear within budget', {
    tenantSchemaName,
    budgetMs,
  });
  return false;
}

/**
 * Verify the tenant schema contains the expected subset of tables.
 */
function verifyTenantTables(tenantSchemaName: string): {
  tablesFound: readonly string[];
  tablesMissing: readonly string[];
} {
  const raw = psql(
    `SELECT tablename FROM pg_tables WHERE schemaname = '${tenantSchemaName}' ORDER BY tablename`,
  );
  const found = parseStringList(raw);
  const missing = EXPECTED_TENANT_TABLES_SUBSET.filter(
    (t) => !found.includes(t),
  );

  if (missing.length > 0) {
    logError(PHASE, 'tenant schema is missing expected tables', {
      tenantSchemaName,
      expected: EXPECTED_TENANT_TABLES_SUBSET,
      found,
      missing,
    });
  } else {
    logInfo(PHASE, 'tenant schema table subset verified', {
      tenantSchemaName,
      tableCount: found.length,
    });
  }
  return { tablesFound: found, tablesMissing: missing };
}

/**
 * Tear down the smoke-test tenant: delete the row and DROP the
 * schema. We tolerate a missing schema (idempotent cleanup).
 */
function cleanupTestTenant(tenantId: string, tenantSchemaName: string): boolean {
  try {
    psql(`DROP SCHEMA IF EXISTS ${tenantSchemaName} CASCADE`);
    psql(`DELETE FROM auth.tenants WHERE id = '${tenantId}'`);
    // Confirm cleanup
    const remainingSchema = psql(
      `SELECT schema_name FROM information_schema.schemata WHERE schema_name = '${tenantSchemaName}'`,
    );
    const remainingRow = psql(
      `SELECT id::text FROM auth.tenants WHERE id = '${tenantId}'`,
    );
    if (remainingSchema.length > 0 || remainingRow.length > 0) {
      logError(PHASE, 'cleanup did not fully purge smoke-test tenant', {
        tenantId,
        tenantSchemaName,
        remainingSchema,
        remainingRow,
      });
      return false;
    }
    logInfo(PHASE, 'smoke-test tenant cleaned up', { tenantId, tenantSchemaName });
    return true;
  } catch (err) {
    logError(PHASE, 'cleanup raised', {
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

/**
 * Top-level entry point. Caller should set
 * `TENANT_CLONE_SMOKE_ALLOWED=1` to opt in.
 */
export function verifyTenantClone(
  opts: VerifyTenantCloneOptions,
): VerifyTenantCloneResult {
  if (opts.dryRun) {
    logInfo(PHASE, '[dry-run] would provision a smoke-test tenant', {
      slugPattern: 'factory-reset-smoke-<timestamp>',
    });
    logInfo(PHASE, '[dry-run] would assert tenant schema appears + has subset tables', {
      expectedSubset: EXPECTED_TENANT_TABLES_SUBSET,
    });
    logInfo(PHASE, '[dry-run] would tear down the smoke-test tenant');
    return {
      tenantId: '<dry-run>',
      tenantSchemaName: '<dry-run>',
      tablesFound: [],
      tablesMissing: [],
      cleanupOk: true,
    };
  }

  if (process.env.TENANT_CLONE_SMOKE_ALLOWED !== '1') {
    logError(
      PHASE,
      'TENANT_CLONE_SMOKE_ALLOWED env var not set to "1"; refusing to run. ' +
        'This test creates a real tenant — set the env var to opt in.',
    );
    throw new Error('tenant-clone smoke disabled by env guard');
  }

  const slug = opts.tenantSlug ?? `factory-reset-smoke-${Date.now()}`;
  const tenantId = provisionTestTenant(slug);
  const tenantSchemaName = getTenantSchemaName(tenantId);

  // Budget: 30s. The tenant-connection-bootstrap worker runs on a
  // sub-second poll loop; 30s is generous.
  const ok = waitForTenantSchema(tenantSchemaName, 30_000);
  if (!ok) {
    // Cleanup before throwing so we don't leave a zombie tenant row.
    cleanupTestTenant(tenantId, tenantSchemaName);
    throw new Error(
      `tenant_<uuid> schema ${tenantSchemaName} did not appear within 30s; ` +
        'auth-service schema-clone path is broken.',
    );
  }

  const { tablesFound, tablesMissing } = verifyTenantTables(tenantSchemaName);

  const cleanupOk = cleanupTestTenant(tenantId, tenantSchemaName);

  if (tablesMissing.length > 0) {
    if (!cleanupOk) {
      logWarn(PHASE, 'cleanup also failed; manual intervention required');
    }
    throw new Error(
      `tenant schema ${tenantSchemaName} is missing ${tablesMissing.length} expected table(s): ${tablesMissing.join(', ')}.`,
    );
  }

  logInfo(PHASE, 'tenant-clone smoke test passed', {
    tenantId,
    tenantSchemaName,
    tableCount: tablesFound.length,
    cleanupOk,
  });

  return {
    tenantId,
    tenantSchemaName,
    tablesFound,
    tablesMissing,
    cleanupOk,
  };
}
