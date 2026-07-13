/**
 * Platform-wide invariant — SHARED-SCHEMA-CRITICAL-001 / Faz 4:
 *
 * **The canonical list of `shared` schema tables is the same in ALL
 * three places: `SHARED_SCHEMA_TABLES` in generate-init-schemas.ts,
 * `PROTECTED_TABLES` entries prefixed `shared.` in protected-tables.ts,
 * and the CREATE TABLE statements in the platform-bootstrap atom's
 * `006-shared-schema-tables.sql` (ADR-031).**
 *
 * # WHY
 *
 * Pre-2026-05 audit found a 3-way SSoT drift:
 *
 *   - `scripts/schema-registry/generate-init-schemas.ts` declared 4 tables.
 *   - `infrastructure/docker/init-scripts/10-shared-schema.sql` created 5 tables
 *     (the additional one being `access_logs`, added via the
 *     admin-api migration 1788400-CreateSharedAccessLogs without
 *     updating the init-script SSoT).
 *   - `libs/backend-common/src/constants/protected-tables.ts` listed 6.
 *
 * ADR-031 (2026-05-18) moved the shared-schema CREATE TABLE statements
 * out of the initdb-only init-script `10-shared-schema.sql` and into the
 * restart-survive platform-bootstrap atom at
 * `apps/db-migrate/src/sql/platform-bootstrap/006-shared-schema-tables.sql`.
 * This spec follows the relocation — every reference below now points
 * at the live writer, not the archived shell.
 *
 * The drift is silent until the next reset cycle, at which point the
 * mismatch surfaces as either an orphan table (init script does not
 * recreate the dropped surface) or a missing immutability guard. This
 * invariant catches the divergence at PR time.
 *
 * # CONTRACT
 *
 * 1. Every table name in `SHARED_SCHEMA_TABLES` MUST appear in
 *    `PROTECTED_TABLES` prefixed `shared.`. Conversely, every
 *    `shared.<table>` entry in PROTECTED_TABLES MUST be declared in
 *    SHARED_SCHEMA_TABLES.
 *
 * 2. The set MUST match the CREATE TABLE list in the platform-bootstrap
 *    atom's `006-shared-schema-tables.sql` — SQL-text parse is best-effort
 *    regex (the file is hand-curated; the regex catches
 *    `CREATE TABLE … shared.<table>` and the `SET SCHEMA shared` move pattern).
 *
 * 3. Adding a new shared table requires an ADR per ADR-011 §"shared
 *    schema canonical N-table invariant" and CODEOWNERS approval from
 *    compliance-expert + architectural-arbiter.
 */

import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { PROTECTED_TABLES } from '../../libs/backend-common/src/constants/protected-tables';

const REPO_ROOT = resolve(__dirname, '..', '..');

const GENERATE_INIT_PATH = resolve(
  REPO_ROOT,
  'scripts',
  'schema-registry',
  'generate-init-schemas.ts',
);
// ADR-031 cutover: SHARED_SCHEMA_TABLES creation moved from the
// initdb-only init-script `10-shared-schema.sql` to the restart-survive
// platform-bootstrap atom under apps/db-migrate/src/sql/platform-bootstrap/.
// This spec repoints to the new path so the SSoT parity invariant
// observes the live writer, not the archived shell of the previous one.
const SHARED_SCHEMA_SQL_PATH = resolve(
  REPO_ROOT,
  'apps',
  'db-migrate',
  'src',
  'sql',
  'platform-bootstrap',
  '006-shared-schema-tables.sql',
);

function readSharedTablesFromGenerateInit(): readonly string[] {
  const src = readFileSync(GENERATE_INIT_PATH, 'utf8');
  // const SHARED_SCHEMA_TABLES = [ 'foo', 'bar', ] as const;
  const m = /const\s+SHARED_SCHEMA_TABLES\s*=\s*\[([\s\S]*?)\]\s*as\s+const/m.exec(
    src,
  );
  const body = m?.[1];
  if (body === undefined) {
    throw new Error(
      `[shared-schema-canonical] generate-init-schemas.ts does not expose SHARED_SCHEMA_TABLES in the expected shape; refusing to verify`,
    );
  }
  return body
    .split(',')
    .map((s) => s.trim().replace(/['"]/g, ''))
    .filter((s) => /^[a-z_][a-z0-9_]*$/.test(s));
}

function readSharedTablesFromSql(): readonly string[] {
  const src = readFileSync(SHARED_SCHEMA_SQL_PATH, 'utf8');
  const names = new Set<string>();
  // Match: CREATE TABLE [IF NOT EXISTS] shared.foo (
  const createRe =
    /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?shared\.([a-z_][a-z0-9_]*)/gi;
  let m: RegExpExecArray | null;
  while ((m = createRe.exec(src)) !== null) {
    const name = m[1];
    if (name !== undefined) names.add(name);
  }
  // Match: ALTER TABLE public.foo SET SCHEMA shared
  const moveRe =
    /ALTER\s+TABLE\s+(?:public\.)?([a-z_][a-z0-9_]*)\s+SET\s+SCHEMA\s+shared/gi;
  while ((m = moveRe.exec(src)) !== null) {
    const name = m[1];
    if (name !== undefined) names.add(name);
  }
  return [...names].sort();
}

function readSharedTablesFromProtectedConstants(): readonly string[] {
  return PROTECTED_TABLES.filter((t) => t.startsWith('shared.'))
    .map((t) => t.replace(/^shared\./, ''))
    .sort();
}

function setOf(arr: readonly string[]): Set<string> {
  return new Set(arr.map((s) => s.toLowerCase()));
}

function symmetricDiff(a: Set<string>, b: Set<string>): { onlyInA: string[]; onlyInB: string[] } {
  const onlyInA = [...a].filter((x) => !b.has(x)).sort();
  const onlyInB = [...b].filter((x) => !a.has(x)).sort();
  return { onlyInA, onlyInB };
}

describe('INVARIANT — shared-schema canonical SSoT parity (SHARED-SCHEMA-CRITICAL-001)', () => {
  it('reads all three SSoT sources without parse errors', () => {
    expect(() => readSharedTablesFromGenerateInit()).not.toThrow();
    expect(() => readSharedTablesFromSql()).not.toThrow();
    expect(() => readSharedTablesFromProtectedConstants()).not.toThrow();
  });

  it('SHARED_SCHEMA_TABLES (generate-init-schemas.ts) === PROTECTED_TABLES shared.* (protected-tables.ts)', () => {
    const fromGenerate = setOf(readSharedTablesFromGenerateInit());
    const fromProtected = setOf(readSharedTablesFromProtectedConstants());
    const diff = symmetricDiff(fromGenerate, fromProtected);
    if (diff.onlyInA.length || diff.onlyInB.length) {
      throw new Error(
        `Shared-schema SSoT mismatch between generate-init-schemas.ts and protected-tables.ts:\n` +
          (diff.onlyInA.length
            ? `  only in generate-init-schemas.SHARED_SCHEMA_TABLES: ${diff.onlyInA.join(', ')}\n`
            : '') +
          (diff.onlyInB.length
            ? `  only in protected-tables.PROTECTED_TABLES (shared.*): ${diff.onlyInB.join(', ')}\n`
            : '') +
          `Resolution: align both lists. Adding a new shared table requires an ADR per ADR-011.`,
      );
    }
  });

  it('SHARED_SCHEMA_TABLES (generate-init-schemas.ts) ⊆ tables created in 10-shared-schema.sql', () => {
    const fromGenerate = setOf(readSharedTablesFromGenerateInit());
    const fromSql = setOf(readSharedTablesFromSql());

    // The SQL file may legitimately reference auxiliary tables that are
    // NOT part of the canonical shared list (e.g. legacy archive views,
    // trigger functions). The contract is one-way: every name in
    // SHARED_SCHEMA_TABLES must have a corresponding CREATE in the SQL.
    const missingFromSql = [...fromGenerate].filter((t) => !fromSql.has(t));
    if (missingFromSql.length > 0) {
      throw new Error(
        `SHARED_SCHEMA_TABLES lists ${missingFromSql.join(', ')} but 10-shared-schema.sql does not CREATE them. ` +
          `Either add CREATE TABLE shared.<name> blocks to the SQL or remove the entry from generate-init-schemas.ts.`,
      );
    }
  });

  it('SchemaVersionGate derives its shared-table expectation from PROTECTED_TABLES (no hand-copied literal)', () => {
    // 2026-07-13 outage class (ORPHAN-HIGH-387): the gate carried a numeric
    // literal `EXPECTED_SHARED_TABLE_COUNT = 5`; when ADR-042 retired
    // shared.user_permissions the bootstrap honestly recorded 4 while the
    // gate still demanded 5, crash-looping every backend service. The
    // expectation MUST be derived from the runtime canonical copy.
    const gateSource = readFileSync(
      resolve(REPO_ROOT, 'libs/backend-common/src/database/schema-version-gate.service.ts'),
      'utf8',
    );
    expect(gateSource).not.toMatch(/EXPECTED_SHARED_TABLE_COUNT\s*=\s*\d/);
    expect(gateSource).toMatch(/EXPECTED_SHARED_TABLE_COUNT\s*=\s*PROTECTED_TABLES/);
  });
});
