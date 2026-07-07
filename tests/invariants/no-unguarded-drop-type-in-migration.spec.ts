import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

/**
 * Bans an unguarded `DROP TYPE` in the `up()` of a tenant-aware migration
 * (production outage 2026-07-07, `DropHarvestQualityGrade1804300000000`).
 *
 * WHY: a source-schema enum (e.g. `farm.harvest_records_qualitygrade_enum`) is
 * created ONCE in the source schema. Tenant schemas are cloned with
 * `CREATE TABLE … LIKE … INCLUDING ALL`, which copies the column but does NOT
 * clone the enum type — every tenant clone's column cross-references the ONE
 * source enum. db-migrate's fan-out runs the SOURCE schema first and aborts the
 * whole run on failure, so a `DROP TYPE` in `up()` fails ("cannot drop type …
 * because other objects depend on it") while any tenant clone still has the
 * column — and a per-schema fan-out cannot express "drop one shared object
 * after all N+1 references are gone". A single such migration aborts db-migrate
 * → every service gated on `db-migrate service_completed_successfully` fails to
 * start → total outage.
 *
 * RULE: the correct forward-only pattern drops the COLUMN across all schemas and
 * LEAVES the now-orphaned (harmless, unused) enum. If a migration genuinely must
 * reclaim the type, it needs a `pg_depend` "no dependents remain" gate AND an
 * explicit `SHARED-ENUM-DROP-REVIEWED` annotation documenting why it is safe.
 * Anything else is a latent outage and fails here.
 */
const REPO_ROOT = resolve(__dirname, '..', '..');

// Services whose migrations fan out into tenant_<uuid> clones (the schemas where
// a source-schema enum becomes a cross-referenced shared type). auth/billing/
// admin/etc. are platform-level (no tenant clones) and out of scope.
const TENANT_AWARE_SERVICES = [
  'farm-service',
  'sensor-service',
  'hr-service',
  'messaging-service',
  'hydroponics-service',
  'ai-service',
  'alert-engine',
];

function migrationFiles(): string[] {
  const files: string[] = [];
  for (const service of TENANT_AWARE_SERVICES) {
    const dir = join(REPO_ROOT, 'apps', service, 'src', 'database', 'migrations');
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir)) {
      if (/^\d.*\.ts$/.test(entry)) files.push(join(dir, entry));
    }
  }
  return files;
}

/** Strip line + block comments so a `DROP TYPE` MENTIONED in an explanatory
 * comment (e.g. this fix's own docblock) is not mistaken for a statement. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

/** The `up()` method body (between `up(` and `down(` / end of file), comments
 * stripped so only actual DDL statements are inspected. */
function upBody(source: string): string {
  const upStart = source.search(/public\s+async\s+up\s*\(/);
  if (upStart < 0) return '';
  const downStart = source.search(/public\s+async\s+down\s*\(/);
  const body = downStart > upStart ? source.slice(upStart, downStart) : source.slice(upStart);
  return stripComments(body);
}

describe('tenant-aware migrations do not drop a shared enum type in up()', () => {
  it('no unguarded DROP TYPE in any tenant-aware migration up()', () => {
    const violations: string[] = [];

    for (const file of migrationFiles()) {
      const up = upBody(readFileSync(file, 'utf8'));
      if (!/\bDROP\s+TYPE\b/i.test(up)) continue;

      // The only sanctioned way to drop a shared source-schema enum is a
      // dependents-count gate (`pg_depend`) PLUS an explicit reviewed annotation.
      const reviewed =
        /SHARED-ENUM-DROP-REVIEWED/.test(up) && /pg_depend/i.test(up);
      if (!reviewed) {
        violations.push(relative(REPO_ROOT, file));
      }
    }

    if (violations.length > 0) {
      throw new Error(
        `Unguarded DROP TYPE in the up() of ${violations.length} tenant-aware migration(s):\n  ` +
          violations.join('\n  ') +
          `\nA source-schema enum is a single shared type that every tenant clone ` +
          `cross-references (CREATE TABLE LIKE does not clone types), so DROP TYPE ` +
          `aborts db-migrate in the source-first fan-out → total outage ` +
          `(DropHarvestQualityGrade1804300000000, 2026-07-07). Drop the COLUMN and ` +
          `LEAVE the orphaned enum, or gate the drop on a pg_depend ` +
          `"no dependents remain" check + a SHARED-ENUM-DROP-REVIEWED annotation.`,
      );
    }
    expect(violations).toEqual([]);
  });
});
