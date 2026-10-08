/**
 * DEBT-2026-05-07-001 — the add-column-then-index pair must go through
 * the shared helper.
 *
 * The debt record's root cause: the TypeORM migration generator copies
 * the idempotent ADD COLUMN + CREATE INDEX boilerplate verbatim into
 * each new migration file, so the pattern multiplied across services
 * and silently absorbed maintenance cost. With
 * `addColumnWithIndex` landed in migration-helpers.ts, this invariant
 * bans FUTURE inlined pairs; shipped migrations are immutable
 * (migration-immutability-witness.ts) and are grandfathered in an
 * in-spec allowlist with a stale-exemption test — the ddl-guard idiom
 * (tenant-aware-migration-ddl-guard.spec.ts), never a self-service
 * marker.
 *
 * Detection is per TABLE, not per file: a migration legitimately adds
 * a column WITHOUT an index to table A while creating an index on an
 * EXISTING column of table B — file-level co-occurrence would false-
 * positive on exactly that shape. Comments are stripped and only the
 * up() body is scanned.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');

/**
 * Reviewer-gated allowlist: shipped migrations that inline the pair.
 * A file may leave this set only by becoming a new migration that uses
 * the helper (impossible — migrations are immutable) or by deletion;
 * the stale-exemption test fails when an entry stops violating, so the
 * set cannot silently rot.
 */
const GRANDFATHERED: ReadonlySet<string> = new Set([
  'apps/sensor-service/src/database/migrations/1801100000000-UnifiedTagLifecycle.ts',
  'apps/sensor-service/src/database/migrations/1801200000000-ProgramVariableTenantId.ts',
  'apps/sensor-service/src/database/migrations/1801400000000-DeployLogArtifactColumns.ts',
  'apps/sensor-service/src/database/migrations/1806300000000-ScadaTenantIsolation.ts',
]);

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

function upBody(source: string): string {
  const match = source.match(/async up\([^)]*\)[^{]*\{([\s\S]*?)(?:async down\(|\Z)/);
  return match?.[1] ?? '';
}

function addedTables(body: string): Set<string> {
  const tables = new Set<string>();
  const re = /ALTER TABLE\s+(?:[\w"]+\.)*"?(\w+)"?\s+ADD COLUMN\s+(?:IF NOT EXISTS\s+)?"?(\w+)?/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    if (m[1]) tables.add(m[1]);
  }
  return tables;
}

function indexedTables(body: string): Set<string> {
  const tables = new Set<string>();
  const re = /CREATE INDEX\s+(?:IF NOT EXISTS\s+)?\w+\s+ON\s+(?:[\w"]+\.)*"?(\w+)"?/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    if (m[1]) tables.add(m[1]);
  }
  return tables;
}

function discoverMigrations(): string[] {
  const appsDir = resolve(REPO_ROOT, 'apps');
  const found: string[] = [];
  for (const service of readdirSync(appsDir)) {
    const migrationsDir = resolve(appsDir, service, 'src', 'database', 'migrations');
    if (!existsSync(migrationsDir)) continue;
    for (const entry of readdirSync(migrationsDir)) {
      if (/^[0-9].*-.*\.ts$/.test(entry)) {
        found.push(`apps/${service}/src/database/migrations/${entry}`);
      }
    }
  }
  return found.filter((f) => !f.includes('/.archive/'));
}

describe('DEBT-2026-05-07-001 — add-column+index pairs use the shared helper', () => {
  const migrations = discoverMigrations();

  it('the migration corpus is discovered (a broken glob must not pass silently)', () => {
    // Floor, not a pin: 195 today across 10 services; a glob that
    // silently matches nothing must fail, exact drift is not asserted.
    expect(migrations.length).toBeGreaterThan(150);
  });

  it('no NEW migration inlines the same-table add-column+index pair', () => {
    const violations: string[] = [];
    for (const relPath of migrations) {
      if (GRANDFATHERED.has(relPath)) continue;
      const source = stripComments(readFileSync(resolve(REPO_ROOT, relPath), 'utf8'));
      if (source.includes('addColumnWithIndex')) continue;
      const body = upBody(source);
      const overlap = [...addedTables(body)].filter((t) => indexedTables(body).has(t));
      if (overlap.length > 0) {
        violations.push(`${relPath} (tables: ${overlap.join(', ')})`);
      }
    }
    expect(violations).toEqual([]);
  });

  it('every grandfathered entry still exists and still inlines the pair (no stale exemptions)', () => {
    for (const relPath of GRANDFATHERED) {
      const abs = resolve(REPO_ROOT, relPath);
      expect(existsSync(abs)).toBe(true);
      const source = stripComments(readFileSync(abs, 'utf8'));
      expect(source.includes('addColumnWithIndex')).toBe(false);
      const body = upBody(source);
      const overlap = [...addedTables(body)].filter((t) => indexedTables(body).has(t));
      expect(overlap.length).toBeGreaterThan(0);
    }
  });
});
