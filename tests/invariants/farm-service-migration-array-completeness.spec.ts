/**
 * farm-service migration array completeness invariant — FARM-LOW-001 follow-up
 * ============================================================================
 *
 * Farm-service has TWO migration discovery paths:
 *
 *   a. The aqua-db-migrate orchestrator's glob
 *      'apps/farm-service/src/database/migrations/*{.ts,.js}'
 *      used by production deploys.
 *
 *   b. The explicit `migrations: [...]` array in
 *      'apps/farm-service/src/app.module.ts' consulted by farm-service's
 *      in-process MigrationRunnerService when DATABASE_MIGRATIONS_RUN=true
 *      (dev / E2E paths).
 *
 * The two paths drift the moment a developer adds a migration file
 * without remembering to import it into the explicit array. Production
 * keeps applying the new migration via glob; dev / E2E silently skip
 * it and run against pre-N schema state.
 *
 * FARM-LOW-001 (PR-53) closed the existing drift — 8 migrations
 * between 1786000000000 and 1788100000000 were on disk but missing
 * from the array. This invariant freezes the parity going forward:
 * any new on-disk migration without a matching `import { ... } from
 * '...'` line in app.module.ts AND a matching entry in the
 * `migrations: [...]` literal fails CI before merge.
 *
 * # When this spec fails
 *
 *   - On-disk file 'NNNN-Name.ts' exists, app.module.ts does NOT
 *     import it → add the import + array entry.
 *   - app.module.ts imports a migration class that is not on disk →
 *     remove the dead import or restore the file.
 *   - app.module.ts imports a migration class but does NOT include
 *     it in the `migrations: [...]` array literal → add the array
 *     entry.
 *
 * # What this invariant does NOT check
 *
 *   - Whether the imported class actually implements
 *     MigrationInterface — that's tsc's job.
 *   - The order of entries in the array. The runner orders by the
 *     timestamp embedded in the class name, not by array position;
 *     timestamp-ascending is a code-style preference enforced by
 *     review, not by this invariant.
 *   - Whether the in-process registration matches the orchestrator's
 *     glob discovery — both are read from the same file system, so
 *     parity with the orchestrator is implicit if parity with disk
 *     is enforced (this invariant's contract).
 *   - Other services. Each tenant-aware service owns its own
 *     migrations array; this invariant is scoped to farm-service
 *     because that is where FARM-LOW-001 surfaced. A platform-wide
 *     generalisation could come later if other services exhibit
 *     the same drift class.
 */

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const MIGRATIONS_DIR = path.resolve(
  REPO_ROOT,
  'apps/farm-service/src/database/migrations',
);
const APP_MODULE_PATH = path.resolve(
  REPO_ROOT,
  'apps/farm-service/src/app.module.ts',
);

/**
 * Class name pattern: `<Name><13-digit-timestamp>`. Every migration
 * file in the canonical farm-service layout exports a class whose
 * name starts with a capital letter, contains arbitrary CamelCase,
 * and ends in a 13-digit timestamp. The same identifier appears in
 * app.module.ts twice — once in the import, once in the array.
 */
const MIGRATION_CLASS_REGEX = /^([A-Z][A-Za-z0-9]*\d{13})$/;

/**
 * Discover every '.ts' file in the migrations directory whose
 * filename matches the canonical 'NNNN-Name.ts' pattern. Returns
 * the canonical class name for each (parsed from the file's
 * `export class` declaration) so the comparison is identifier-based
 * rather than filename-based.
 */
function listOnDiskMigrationClasses(): string[] {
  const entries = readdirSync(MIGRATIONS_DIR, { withFileTypes: true });
  const classNames: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith('.ts')) continue;
    // Exclude `.spec.ts` (test files for migrations) and `.d.ts`
    // (type declarations) — both can legitimately live alongside a
    // migration but are not migrations themselves.
    if (entry.name.endsWith('.spec.ts')) continue;
    if (entry.name.endsWith('.d.ts')) continue;
    if (!/^\d{13}-/.test(entry.name)) continue;
    const source = readFileSync(path.join(MIGRATIONS_DIR, entry.name), 'utf8');
    const match = source.match(/export\s+class\s+([A-Z][A-Za-z0-9]*\d{13})\b/);
    if (!match || !match[1]) {
      throw new Error(
        `Migration file ${entry.name} does not export a class matching ` +
          'the canonical `<Name><13-digit-timestamp>` pattern. Either ' +
          "rename the class to match the file's timestamp or move the " +
          'file out of the migrations directory.',
      );
    }
    classNames.push(match[1]);
  }
  return classNames.sort();
}

/**
 * Extract the names of every class imported from
 * './database/migrations/...' in app.module.ts. The import block
 * captures multiple classes per `import { X, Y } from '...';`
 * statement (rare for migrations but cheap to support).
 */
function listImportedMigrationClasses(): string[] {
  const source = readFileSync(APP_MODULE_PATH, 'utf8');
  const importRegex =
    /import\s*\{([^}]+)\}\s*from\s*['"]\.\/database\/migrations\/[^'"]+['"]\s*;/g;
  const names: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = importRegex.exec(source)) !== null) {
    const inner = m[1]!;
    for (const raw of inner.split(',')) {
      const ident = raw.trim().replace(/^type\s+/, '').replace(/\s+as\s+\w+$/, '');
      if (MIGRATION_CLASS_REGEX.test(ident)) {
        names.push(ident);
      }
    }
  }
  return names.sort();
}

/**
 * Extract the names listed inside the `migrations: [...]` array of
 * the `createServiceTypeOrmConfig({...})` call. The regex narrowly
 * matches the array contents to avoid catching unrelated `migrations`
 * occurrences elsewhere in the file (none today, but defence-in-
 * depth).
 */
function listArrayMigrationClasses(): string[] {
  const source = readFileSync(APP_MODULE_PATH, 'utf8');
  // The literal `migrations: [...]` string appears in two places:
  // (a) a docblock illustrating the registration pattern, and
  // (b) the real array inside createServiceTypeOrmConfig({...}).
  // The docblock copy is short and contains a literal '...' so the
  // captured group has length ~3 with no class identifiers. Picking
  // the LAST match (greedy reverse) selects the real array.
  const matches = [...source.matchAll(/migrations:\s*\[([\s\S]*?)\]/g)];
  // Choose the longest match — the real array is much larger than
  // the docblock placeholder (whichever match captures > 100 chars
  // is the real one; the placeholder is < 10).
  const realMatch = matches
    .filter((m) => m[1] && m[1].length > 100)
    .sort((a, b) => b[1]!.length - a[1]!.length)[0];
  if (!realMatch || !realMatch[1]) {
    throw new Error(
      `Could not locate the real \`migrations: [...]\` array in ${APP_MODULE_PATH}. ` +
        'Either the array was renamed/moved (update this invariant) or ' +
        'the file is unreadable.',
    );
  }
  const body = realMatch[1];
  const names: string[] = [];
  // Each line that contains a class identifier is a migration entry.
  // Lines that are pure comments are ignored — the regex requires the
  // identifier to be preceded by start-of-line whitespace, not a `//`.
  const entryRegex = /^\s*([A-Z][A-Za-z0-9]*\d{13})\s*,/gm;
  let m: RegExpExecArray | null;
  while ((m = entryRegex.exec(body)) !== null) {
    names.push(m[1]!);
  }
  return names.sort();
}

describe('farm-service migration array completeness (FARM-LOW-001 follow-up)', () => {
  let onDisk: string[];
  let imported: string[];
  let inArray: string[];

  beforeAll(() => {
    onDisk = listOnDiskMigrationClasses();
    imported = listImportedMigrationClasses();
    inArray = listArrayMigrationClasses();
  });

  it('finds at least 20 on-disk migrations (sanity — confirms the scan works)', () => {
    expect(onDisk.length).toBeGreaterThanOrEqual(20);
  });

  it('every on-disk migration class is imported in app.module.ts', () => {
    const missing = onDisk
      .filter((cls) => !imported.includes(cls))
      .sort();
    expect(missing).toEqual([]);
  });

  it('every imported migration class exists on disk', () => {
    const stale = imported
      .filter((cls) => !onDisk.includes(cls))
      .sort();
    expect(stale).toEqual([]);
  });

  it('every imported migration class appears in the migrations: [] array', () => {
    const orphaned = imported
      .filter((cls) => !inArray.includes(cls))
      .sort();
    expect(orphaned).toEqual([]);
  });

  it('every entry in the migrations: [] array is imported', () => {
    const phantom = inArray
      .filter((cls) => !imported.includes(cls))
      .sort();
    expect(phantom).toEqual([]);
  });
});
