/**
 * verify-seed — assert the post-reset DB state matches the canonical
 * "ilk gun" (day-one) shape of every droplet bootstrap.
 *
 * Architectural contract being enforced (tier-3 "make it detectable"):
 *
 *   A. auth.users:
 *      - Exactly one row
 *      - email == by-okan@live.com (the platform-owner's account)
 *      - role == SUPER_ADMIN
 *      - tenantId IS NULL (super-admin has no tenant scope)
 *
 *   B. auth.modules:
 *      - Exactly six rows (the canonical module list seeded by
 *        auth-service SeedService): farm, hr, sensor, hydroponics,
 *        alert, ai. Anything else means seed drift.
 *
 *   C. Tenant cleanliness:
 *      - auth.tenants count == 0 (no tenant rows survive the reset)
 *      - zero schemas matching `tenant_%` (no tenant-clone schemas
 *        survive). This catches the case where compose-down + volume
 *        purge succeeded but a stray tenant_<uuid> schema was
 *        re-introduced via an out-of-band psql session before verify.
 *
 *   D. Canonical service-schema presence:
 *      - All 17 expected schemas exist: 14 service schemas (auth,
 *        farm, sensor, hr, messaging, hydroponics, alert, billing,
 *        notification, ai, admin, observability, event_store, config)
 *        + gateway + shared + public. Missing any one means a
 *        migration runner failed silently.
 *
 * Any deviation aborts with a diagnostic dump of the actual table
 * contents — the operator can then choose to either fix the
 * SUPER_ADMIN_EMAIL/PASSWORD env and re-run, or accept the state.
 *
 * Implementation choice — `docker exec aqua-postgres psql` rather
 * than the `pg` driver:
 *   The droplet does NOT publish the postgres port to the host. The
 *   only reachable path from the CLI host is `docker exec`. Using
 *   psql also avoids pulling a runtime DB driver dependency for what
 *   is fundamentally a one-off operator tool.
 */

import { execFileSync } from 'node:child_process';

import { logError, logInfo } from './log.ts';

const PHASE = 'verify-seed';

const EXPECTED_EMAIL = 'by-okan@live.com';
const EXPECTED_ROLE = 'SUPER_ADMIN';

/**
 * Canonical module names seeded by auth-service `SeedService`. Order
 * is irrelevant — we compare as a Set. Adding a 7th module requires a
 * matching update here AND an ADR amendment per ADR-011.
 */
const EXPECTED_MODULES: readonly string[] = [
  'farm',
  'hr',
  'sensor',
  'hydroponics',
  'alert',
  'ai',
];

/**
 * Canonical schemas every healthy droplet must carry post-bootstrap.
 * 14 service schemas + gateway + shared + public = 17 total.
 *
 * `gateway` is included because gateway-api owns its own audit trail
 * (`gateway.access_log`) even though it has no service-owned data
 * tables otherwise.
 */
const EXPECTED_SCHEMAS: readonly string[] = [
  'auth',
  'farm',
  'sensor',
  'hr',
  'messaging',
  'hydroponics',
  'alert',
  'billing',
  'notification',
  'ai',
  'admin',
  'observability',
  'event_store',
  'config',
  'gateway',
  'shared',
  'public',
];

export interface VerifySeedOptions {
  dryRun: boolean;
}

export interface VerifySeedResult {
  superAdminUserId: string;
  rowCount: number;
  moduleCount: number;
  tenantRowCount: number;
  tenantSchemaCount: number;
  schemaPresenceOk: boolean;
}

interface UserRow {
  id: string;
  email: string;
  role: string;
  tenantId: string | null;
}

/**
 * Execute psql inside the postgres container. Returns the raw
 * tab-delimited output (no header). Throws on non-zero exit.
 *
 * `-tA` — tuples-only, no aligned formatting. `-F$'\t'` — explicit
 * tab field separator so we can split safely even if a value
 * contains spaces.
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

function parseRows(raw: string): readonly UserRow[] {
  if (raw.length === 0) return [];
  return raw
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => {
      const parts = line.split('\t');
      return {
        id: parts[0] ?? '',
        email: parts[1] ?? '',
        role: parts[2] ?? '',
        tenantId: parts[3] && parts[3] !== '' ? parts[3] : null,
      };
    });
}

/**
 * Parse a single integer from a one-row, one-column psql output.
 * Throws if the value cannot be parsed — silent zero would mask a
 * malformed query.
 */
function parseScalarInt(raw: string, label: string): number {
  if (raw.length === 0) {
    throw new Error(`psql returned empty result for ${label}`);
  }
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) {
    throw new Error(`psql returned non-numeric value "${raw}" for ${label}`);
  }
  return n;
}

/**
 * Parse a multi-row, single-column list of identifiers from psql.
 */
function parseStringList(raw: string): readonly string[] {
  if (raw.length === 0) return [];
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/**
 * A.1 — auth.modules row count + name set match.
 *
 * We compare names rather than relying on the count alone: a hand-
 * inserted 6th row with the wrong name (e.g. `farms` plural) would
 * pass a count check but break gateway-api routing.
 */
function verifyModules(): { moduleCount: number; modules: readonly string[] } {
  const raw = psql('SELECT name FROM auth.modules ORDER BY name');
  const modules = parseStringList(raw);
  const expected = [...EXPECTED_MODULES].sort();
  const actual = [...modules].sort();

  const sameLength = actual.length === expected.length;
  const sameContents =
    sameLength && actual.every((m, i) => m === expected[i]);

  if (!sameContents) {
    logError(PHASE, 'auth.modules drift', {
      expected,
      actual,
      missing: expected.filter((m) => !actual.includes(m)),
      unexpected: actual.filter((m) => !expected.includes(m)),
    });
    throw new Error(
      `auth.modules has ${actual.length} rows; expected exactly ${expected.length} ` +
        `(canonical seed: ${expected.join(', ')}). Check auth-service SeedService.`,
    );
  }

  logInfo(PHASE, 'auth.modules verified', { moduleCount: modules.length, modules });
  return { moduleCount: modules.length, modules };
}

/**
 * A.2 — tenant cleanliness.
 *
 * A clean reset has zero tenant rows AND zero `tenant_<uuid>` schemas.
 * The two checks are independent: a tenant row in auth.tenants without
 * a matching schema indicates a half-rolled-back tenant create; a
 * schema without a tenant row indicates a half-deleted tenant. Both
 * must be absent post-bootstrap.
 */
function verifyTenantCleanliness(): {
  tenantRowCount: number;
  tenantSchemaCount: number;
} {
  const tenantRowsRaw = psql('SELECT COUNT(*) FROM auth.tenants');
  const tenantRowCount = parseScalarInt(tenantRowsRaw, 'auth.tenants COUNT');

  const tenantSchemasRaw = psql(
    "SELECT COUNT(*) FROM information_schema.schemata WHERE schema_name LIKE 'tenant_%'",
  );
  const tenantSchemaCount = parseScalarInt(
    tenantSchemasRaw,
    'tenant_% schema COUNT',
  );

  if (tenantRowCount !== 0) {
    // Dump the tenant ids for the operator's diagnostic record.
    const tenantList = psql('SELECT id::text FROM auth.tenants ORDER BY id');
    logError(PHASE, 'auth.tenants is not empty after reset', {
      tenantRowCount,
      tenants: parseStringList(tenantList),
    });
    throw new Error(
      `auth.tenants has ${tenantRowCount} rows after reset; expected 0.`,
    );
  }

  if (tenantSchemaCount !== 0) {
    const schemaList = psql(
      "SELECT schema_name FROM information_schema.schemata WHERE schema_name LIKE 'tenant_%' ORDER BY schema_name",
    );
    logError(PHASE, 'tenant_<uuid> schemas survived the reset', {
      tenantSchemaCount,
      schemas: parseStringList(schemaList),
    });
    throw new Error(
      `Found ${tenantSchemaCount} tenant_<uuid> schema(s) after reset; expected 0.`,
    );
  }

  logInfo(PHASE, 'tenant cleanliness verified', {
    tenantRowCount,
    tenantSchemaCount,
  });
  return { tenantRowCount, tenantSchemaCount };
}

/**
 * A.3 — every canonical schema is present.
 *
 * A missing schema means a service migration runner failed silently
 * during boot — the schema is supposed to be CREATEd by either the
 * service's first migration or the postgres init scripts. If we find
 * the gap here, the operator must investigate the relevant service's
 * boot logs before any tenant onboarding is attempted.
 */
function verifySchemasPresent(): { ok: boolean; missing: readonly string[] } {
  const placeholders = EXPECTED_SCHEMAS.map((s) => `'${s}'`).join(', ');
  const raw = psql(
    `SELECT schema_name FROM information_schema.schemata WHERE schema_name IN (${placeholders}) ORDER BY schema_name`,
  );
  const present = parseStringList(raw);
  const missing = EXPECTED_SCHEMAS.filter((s) => !present.includes(s));

  if (missing.length > 0) {
    logError(PHASE, 'canonical schema(s) missing', {
      expected: EXPECTED_SCHEMAS,
      present,
      missing,
    });
    throw new Error(
      `Missing ${missing.length} canonical schema(s): ${missing.join(', ')}. ` +
        'Investigate the relevant service migration runner output.',
    );
  }

  logInfo(PHASE, 'canonical schemas present', {
    count: present.length,
    schemas: present,
  });
  return { ok: true, missing: [] };
}

export function verifySeed(opts: VerifySeedOptions): VerifySeedResult {
  if (opts.dryRun) {
    logInfo(PHASE, '[dry-run] would query auth.users and assert single SUPER_ADMIN row', {
      expectedEmail: EXPECTED_EMAIL,
      expectedRole: EXPECTED_ROLE,
    });
    logInfo(PHASE, '[dry-run] would assert auth.modules row count + names', {
      expectedModules: EXPECTED_MODULES,
    });
    logInfo(PHASE, '[dry-run] would assert tenant cleanliness', {
      expectedTenantRows: 0,
      expectedTenantSchemas: 0,
    });
    logInfo(PHASE, '[dry-run] would assert canonical schema presence', {
      expectedSchemas: EXPECTED_SCHEMAS,
    });
    return {
      superAdminUserId: '<dry-run>',
      rowCount: 0,
      moduleCount: 0,
      tenantRowCount: 0,
      tenantSchemaCount: 0,
      schemaPresenceOk: true,
    };
  }

  // ---- A.0: SUPER_ADMIN row ----
  logInfo(PHASE, 'querying auth.users');
  const raw = psql('SELECT id, email, role, "tenantId"::text FROM auth.users ORDER BY email');
  const rows = parseRows(raw);

  logInfo(PHASE, 'auth.users snapshot', { rowCount: rows.length, rows });

  if (rows.length !== 1) {
    logError(PHASE, 'expected exactly one row in auth.users', {
      actualRowCount: rows.length,
      rows,
    });
    throw new Error(
      `auth.users has ${rows.length} rows after factory reset; expected 1 (the SUPER_ADMIN seed).`,
    );
  }

  const [user] = rows;
  if (!user) {
    throw new Error('auth.users row exists but parsed as undefined');
  }
  if (user.email !== EXPECTED_EMAIL) {
    throw new Error(
      `Sole auth.users row email is "${user.email}"; expected "${EXPECTED_EMAIL}". ` +
        'Check the auth-service SUPER_ADMIN_EMAIL env var.',
    );
  }
  if (user.role !== EXPECTED_ROLE) {
    throw new Error(
      `Sole auth.users row role is "${user.role}"; expected "${EXPECTED_ROLE}".`,
    );
  }
  if (user.tenantId !== null) {
    throw new Error(
      `SUPER_ADMIN tenantId is "${user.tenantId}"; expected NULL ` +
        '(super-admin has no tenant scope).',
    );
  }

  logInfo(PHASE, 'SUPER_ADMIN row verified', {
    userId: user.id,
    email: user.email,
    role: user.role,
  });

  // ---- A.1: module count + names ----
  const { moduleCount } = verifyModules();

  // ---- A.2: tenant cleanliness ----
  const { tenantRowCount, tenantSchemaCount } = verifyTenantCleanliness();

  // ---- A.3: canonical schema presence ----
  verifySchemasPresent();

  logInfo(PHASE, 'seed verified (all checks passed)', {
    userId: user.id,
    email: user.email,
    role: user.role,
    moduleCount,
    tenantRowCount,
    tenantSchemaCount,
    schemaCount: EXPECTED_SCHEMAS.length,
  });
  return {
    superAdminUserId: user.id,
    rowCount: 1,
    moduleCount,
    tenantRowCount,
    tenantSchemaCount,
    schemaPresenceOk: true,
  };
}
