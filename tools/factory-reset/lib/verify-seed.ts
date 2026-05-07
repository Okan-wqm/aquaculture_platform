/**
 * verify-seed — assert that the post-reset auth.users table contains
 * exactly the canonical SUPER_ADMIN row and nothing else.
 *
 * Architectural contract being enforced (tier-3 "make it detectable"):
 *   - Exactly one row in auth.users
 *   - email == by-okan@live.com (the platform-owner's account)
 *   - role == SUPER_ADMIN
 *   - tenantId IS NULL (super-admin has no tenant scope)
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

export interface VerifySeedOptions {
  dryRun: boolean;
}

export interface VerifySeedResult {
  superAdminUserId: string;
  rowCount: number;
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

export function verifySeed(opts: VerifySeedOptions): VerifySeedResult {
  if (opts.dryRun) {
    logInfo(PHASE, '[dry-run] would query auth.users and assert single SUPER_ADMIN row', {
      expectedEmail: EXPECTED_EMAIL,
      expectedRole: EXPECTED_ROLE,
    });
    return { superAdminUserId: '<dry-run>', rowCount: 0 };
  }

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

  logInfo(PHASE, 'seed verified', { userId: user.id, email: user.email, role: user.role });
  return { superAdminUserId: user.id, rowCount: 1 };
}
