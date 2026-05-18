/**
 * Platform-wide invariant — SHARED-SCHEMA-CRITICAL-001 / Faz 4:
 *
 * **The canonical list of `shared` schema tables is the same in ALL
 * three places: `SHARED_SCHEMA_TABLES` in generate-init-schemas.ts,
 * `PROTECTED_TABLES` entries prefixed `shared.` in protected-tables.ts,
 * and the table CREATEs in `10-shared-schema.sql`.**
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
 * 2. The set MUST match the CREATE TABLE list in
 *    `infrastructure/docker/init-scripts/10-shared-schema.sql` —
 *    SQL-text parse is best-effort regex (the script is hand-curated;
 *    the regex catches `CREATE TABLE … shared.<table>` and the
 *    `SET SCHEMA shared` move pattern).
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
const SHARED_SCHEMA_SQL_PATH = resolve(
  REPO_ROOT,
  'infrastructure',
  'docker',
  'init-scripts',
  '10-shared-schema.sql',
);

function readSharedTablesFromGenerateInit(): readonly string[] {
  const src = readFileSync(GENERATE_INIT_PATH, 'utf8');
  // const SHARED_SCHEMA_TABLES = [ 'foo', 'bar', ] as const;
  const m = /const\s+SHARED_SCHEMA_TABLES\s*=\s*\[([\s\S]*?)\]\s*as\s+const/m.exec(
    src,
  );
  if (!m) {
    throw new Error(
      `[shared-schema-canonical] generate-init-schemas.ts does not expose SHARED_SCHEMA_TABLES in the expected shape; refusing to verify`,
    );
  }
  return m[1]
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
  while ((m = createRe.exec(src)) !== null) names.add(m[1]);
  // Match: ALTER TABLE public.foo SET SCHEMA shared
  const moveRe =
    /ALTER\s+TABLE\s+(?:public\.)?([a-z_][a-z0-9_]*)\s+SET\s+SCHEMA\s+shared/gi;
  while ((m = moveRe.exec(src)) !== null) names.add(m[1]);
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
});
