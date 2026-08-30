/**
 * Post-fan-out orphan-type reclamation (FARM-MEDIUM-170).
 * ============================================================================
 *
 * A per-schema migration fan-out CANNOT express "clear all N+1 references across
 * every schema, THEN drop one shared object". A shared farm-schema enum/composite
 * type is cross-referenced by every tenant clone — `CREATE TABLE … LIKE …
 * INCLUDING ALL` SHARES a type, it does not clone it — and the fan-out runs the
 * owning-schema (source) pass BEFORE every tenant pass. So when a source-only
 * migration reaches its `DROP TYPE`, tenant columns that have not yet run their
 * own column-drop still reference the shared type, and the migration must DEFER.
 * Nothing re-runs that migration, so the orphaned type lingers until a later
 * release happens to re-probe it.
 *
 * This module is that reclamation, run by aqua-db-migrate AFTER the whole
 * per-service + tenant fan-out completes — the ONLY point at which every
 * dependent column across all schemas is guaranteed gone (a fan-out failure
 * aborts the deploy before this runs, so reaching here means every tenant is at
 * head). Adding a future orphan-type reclamation is a one-line SSoT edit, not a
 * new bespoke migration + deploy hook.
 */
import type { QueryRunner } from 'typeorm';

/** A shared type that a fan-out migration deliberately left orphaned. */
export interface OrphanTypeReclamation {
  /** Schema that OWNS the shared type (where the DROP TYPE must run). */
  schema: string;
  /** The pg_type.typname to reclaim. */
  typeName: string;
  /** The migration that drops the column but defers the shared DROP TYPE. */
  deferredByMigration: string;
  /** Operator-visible rationale, emitted in deploy logs. */
  reason: string;
}

/**
 * SSoT of shared types reclaimed after the fan-out. Edit here and ONLY here when
 * a new source-only migration has to defer a shared DROP TYPE.
 */
export const POST_FANOUT_ORPHAN_TYPE_RECLAMATIONS: readonly OrphanTypeReclamation[] = [
  {
    schema: 'farm',
    typeName: 'harvest_records_qualitygrade_enum',
    deferredByMigration: 'DropOrphanQualityGradeEnum1804400000000',
    reason:
      'harvest_records.qualityGrade was superseded by the stored Norwegian qualityClass ' +
      '(RPT-007 / FARM-CRITICAL-169). Migration 1804300 drops the column per-schema; 1804400 ' +
      'defers the shared DROP TYPE while any tenant clone still references it. This reclaims the ' +
      'orphan once every tenant pass has run 1804300.',
  },
];

/** Structured JSON logger, matching aqua-db-migrate's `log()` shape. */
export type ReclamationLogger = (record: Record<string, unknown>) => void;

export type OrphanTypeReclamationOutcome = 'dropped' | 'deferred_still_referenced' | 'absent';

export interface OrphanTypeReclamationResult {
  schema: string;
  typeName: string;
  outcome: OrphanTypeReclamationOutcome;
  /** Column dependents remaining across ALL schemas at reclamation time. */
  dependents: number;
}

/** Postgres identifier guard — the type/schema names come from the SSoT, never user input, but interpolation into DROP TYPE still gets a hard gate. */
const SAFE_IDENT_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

/**
 * Reclaim every SSoT orphan type whose dependents are all gone. Idempotent and
 * NON-FATAL by contract: a type that is still referenced (a tenant that somehow
 * lags) or already absent is logged and skipped — a harmless orphan is never a
 * deploy-abort. Operates on a caller-owned QueryRunner so it is unit-testable
 * with a mock and shares the deploy's release-wide advisory-lock session.
 */
export async function reclaimPostFanoutOrphanTypes(
  queryRunner: QueryRunner,
  log: ReclamationLogger,
): Promise<OrphanTypeReclamationResult[]> {
  // Session-scoped (not LOCAL): this runs on a dedicated runner outside a
  // transaction, so bound the DROP TYPE's lock wait without a surrounding BEGIN.
  await queryRunner.query(`SET lock_timeout = '2s'`);
  await queryRunner.query(`SET statement_timeout = '30s'`);

  const results: OrphanTypeReclamationResult[] = [];
  for (const entry of POST_FANOUT_ORPHAN_TYPE_RECLAMATIONS) {
    if (!SAFE_IDENT_RE.test(entry.schema) || !SAFE_IDENT_RE.test(entry.typeName)) {
      throw new Error(
        `[db-migrate] Unsafe orphan-type identifier for reclamation: "${entry.schema}"."${entry.typeName}"`,
      );
    }

    const existsRows = (await queryRunner.query(
      `SELECT count(*)::int AS n
         FROM pg_catalog.pg_type t
         JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
        WHERE n.nspname = $1 AND t.typname = $2`,
      [entry.schema, entry.typeName],
    )) as Array<{ n: number }>;
    if ((existsRows[0]?.n ?? 0) === 0) {
      results.push({
        schema: entry.schema,
        typeName: entry.typeName,
        outcome: 'absent',
        dependents: 0,
      });
      log({
        level: 'info',
        message: 'Post-fan-out orphan type already absent — nothing to reclaim',
        context: 'DbMigrateOrphanTypeReclamation',
        schema: entry.schema,
        typeName: entry.typeName,
      });
      continue;
    }

    // Count column dependents on the shared type across ALL schemas — the same
    // pg_depend probe the deferring migration uses. A nonzero count means a
    // schema still legitimately references it, so we defer (never drop).
    const depRows = (await queryRunner.query(
      `SELECT count(*)::int AS n
         FROM pg_catalog.pg_depend d
         JOIN pg_catalog.pg_type t ON t.oid = d.refobjid
         JOIN pg_catalog.pg_namespace tn ON tn.oid = t.typnamespace
         JOIN pg_catalog.pg_attribute a ON a.attrelid = d.objid AND a.attnum = d.objsubid
        WHERE tn.nspname = $1 AND t.typname = $2`,
      [entry.schema, entry.typeName],
    )) as Array<{ n: number }>;
    const dependents = depRows[0]?.n ?? 0;
    if (dependents > 0) {
      results.push({
        schema: entry.schema,
        typeName: entry.typeName,
        outcome: 'deferred_still_referenced',
        dependents,
      });
      log({
        level: 'warn',
        message:
          'Post-fan-out orphan type still referenced — deferring DROP TYPE to a later release',
        context: 'DbMigrateOrphanTypeReclamation',
        schema: entry.schema,
        typeName: entry.typeName,
        dependents,
        deferredByMigration: entry.deferredByMigration,
      });
      continue;
    }

    await queryRunner.query(`DROP TYPE IF EXISTS "${entry.schema}"."${entry.typeName}"`);
    results.push({
      schema: entry.schema,
      typeName: entry.typeName,
      outcome: 'dropped',
      dependents: 0,
    });
    log({
      level: 'info',
      message: 'Post-fan-out orphan type reclaimed',
      context: 'DbMigrateOrphanTypeReclamation',
      schema: entry.schema,
      typeName: entry.typeName,
      reason: entry.reason,
    });
  }
  return results;
}
