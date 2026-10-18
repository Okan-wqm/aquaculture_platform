/**
 * The orphan-type reclamation authority: whether a tenant-aware migration's
 * `up()` drops a shared enum type without the reviewed reclamation gate.
 *
 * WHY (production outage 2026-07-07, `DropHarvestQualityGrade1804300000000`):
 * a source-schema enum (e.g. `farm.harvest_records_qualitygrade_enum`) is
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
 *
 * ONE OWNER, TWO READERS (ARIA-HIGH-011): the invariant
 * `tests/invariants/no-unguarded-drop-type-in-migration.spec.ts` fails the
 * build on a violation, and ARIA's `sql-migration-safety-adapter` observes the
 * same verdict on the whole tree. Both import this module, so the rule cannot
 * drift between the gate and the observation.
 */
import { dirname, posix } from 'node:path';

import { tenantAwareMigrationGlobs } from '../../platform/libs/service-catalog/src';

/** The rule id this authority reports under (the adapter's finding rule). */
export const UNGUARDED_SHARED_ENUM_DROP_RULE = 'unguarded-shared-enum-drop';

/**
 * Directories holding tenant-aware migrations — DERIVED from the platform
 * catalog's `migrationGlobs` (via `tenantAwareMigrationGlobs()`), never a
 * hand-copied service list + path. WHY: the gate once hard-coded
 * `src/database/migrations` and was 100% blind to messaging-service, whose
 * live migrations sit in `src/migrations` (ORPHAN-HIGH-406). The catalog is the
 * SSoT the runtime + migration-runner already use, and it carries messaging's
 * dual path. Each glob is reduced to its directory prefix (the glob's file
 * pattern is always numeric-prefixed migrations).
 */
export function tenantAwareMigrationDirs(): readonly string[] {
  const dirs = new Set<string>();
  for (const glob of tenantAwareMigrationGlobs()) {
    // glob e.g. `apps/messaging-service/src/migrations/[0-9]*{.ts,.js}` →
    // directory prefix is everything up to the last path segment.
    dirs.add(dirname(glob));
  }
  return [...dirs];
}

/** A file name the catalog's numeric-prefixed migration glob names. */
export function isTenantAwareMigrationName(fileName: string): boolean {
  return /^\d.*\.ts$/.test(fileName);
}

/** Whether a workspace-relative POSIX path is a tenant-aware migration. */
export function isTenantAwareMigrationPath(relPath: string): boolean {
  return (
    tenantAwareMigrationDirs().includes(posix.dirname(relPath)) &&
    isTenantAwareMigrationName(posix.basename(relPath))
  );
}

/**
 * Blank line + block comments so a `DROP TYPE` MENTIONED in an explanatory
 * comment (e.g. this rule's own docblock in a migration) is not mistaken for a
 * statement. Comment text becomes spaces and newlines stay, so an offset in the
 * result is the same offset in the source and a verdict can name its line.
 */
function blankComments(source: string): string {
  const blank = (text: string): string => text.replace(/[^\n]/g, ' ');
  return source.replace(/\/\*[\s\S]*?\*\//g, blank).replace(/\/\/[^\n]*/g, blank);
}

/** One unguarded shared-enum drop: where the first `DROP TYPE` of `up()` is. */
export interface UnguardedSharedEnumDrop {
  readonly line: number;
  readonly snippet: string;
}

/**
 * The first unguarded `DROP TYPE` in the migration's `up()` (between `up(` and
 * `down(` / end of file, comments blanked), or null when `up()` drops no type
 * or the drop carries both the `pg_depend` gate and the
 * `SHARED-ENUM-DROP-REVIEWED` annotation.
 */
export function findUnguardedSharedEnumDrop(source: string): UnguardedSharedEnumDrop | null {
  const upStart = source.search(/public\s+async\s+up\s*\(/);
  if (upStart < 0) return null;
  const downStart = source.search(/public\s+async\s+down\s*\(/);
  const up = blankComments(
    downStart > upStart ? source.slice(upStart, downStart) : source.slice(upStart),
  );
  const drop = /\bDROP\s+TYPE\b/i.exec(up);
  if (drop === null) return null;

  // The only sanctioned way to drop a shared source-schema enum is a
  // dependents-count gate (`pg_depend`) PLUS an explicit reviewed annotation.
  if (/SHARED-ENUM-DROP-REVIEWED/.test(up) && /pg_depend/i.test(up)) return null;

  const offset = upStart + drop.index;
  const lineStart = source.lastIndexOf('\n', offset - 1) + 1;
  const lineEnd = source.indexOf('\n', offset);
  return {
    line: source.slice(0, offset).split('\n').length,
    snippet: source
      .slice(lineStart, lineEnd === -1 ? source.length : lineEnd)
      .trim()
      .slice(0, 160),
  };
}
