/**
 * assertExpandContractDependency — R6 runtime gate for @ExpandContract.
 * ============================================================================
 *
 * Called by the migration runner BEFORE executing a contract-phase
 * migration's `up()`. Reads the migration class's @ExpandContract
 * metadata; if phase=contract, queries
 * `observability.migration_backfill_progress` for a row matching
 * `dependsOn`. Throws if the expand-phase migration has not yet been
 * applied in the current environment.
 *
 * # Why at the runner layer, not per-migration body
 *
 * Putting the assertion inside each migration's `up()` requires every
 * contract-phase author to remember to call it — a linting concern
 * masquerading as a semantic invariant. The runner already reads
 * every migration class's decorator metadata (reflect-metadata), so
 * enforcement lives with the layer that SCHEDULES the migration, not
 * the layer that HAS to run DDL.
 *
 * # Fail-safe semantics
 *
 * Three failure modes matter:
 *
 *   1. observability schema does not exist (pre-Phase-0 environments,
 *      fresh clusters before observability-service has ever booted).
 *      → Helper returns `{skipped: true, reason: ...}` without throwing.
 *      The runner logs + continues. Rationale: we cannot gate on a
 *      table that doesn't exist yet; fail-open here is the correct
 *      bootstrap-phase behaviour. Once observability is deployed, the
 *      dependency data begins populating via RecordMigrationEventHandler.
 *
 *   2. observability schema exists but the expand migration is
 *      MISSING from migration_backfill_progress. → Helper THROWS. The
 *      contract-phase migration must not run; the expand migration
 *      has not reached this environment yet.
 *
 *   3. Migration class is expand-phase OR undecorated → no-op.
 *
 * # Environment
 *
 * The gate compares against rows WHERE environment = <env>. The
 * caller supplies the env, typically resolved from AQUA_ENV. Staging
 * and production have independent gates — a staging-only apply does
 * NOT satisfy the production-side contract check.
 */
import type { DataSource } from 'typeorm';

import type { ClassConstructor } from '../types/class-constructor';

import { getExpandContractMetadata } from './expand-contract.decorator';

export interface AssertDependencyOptions {
  readonly dataSource: DataSource;
  readonly migrationClass: ClassConstructor;
  readonly environment: string;
}

export interface AssertDependencyResult {
  /** True when the helper actually performed a lookup (contract phase + DB reachable). */
  readonly checked: boolean;
  /** True when helper returned without checking (skip paths — see docblock). */
  readonly skipped: boolean;
  /** Resolved dependsOn value when available. */
  readonly dependsOn?: string;
  /** Free-form diagnostic. */
  readonly reason?: string;
}

export async function assertExpandContractDependency(
  options: AssertDependencyOptions,
): Promise<AssertDependencyResult> {
  const meta = getExpandContractMetadata(options.migrationClass);
  if (!meta) {
    return { checked: false, skipped: true, reason: 'undecorated' };
  }
  if (meta.phase !== 'contract') {
    return { checked: false, skipped: true, reason: 'expand-phase' };
  }
  if (!meta.dependsOn) {
    // Decorator itself enforces dependsOn for contract phase, but be
    // belt-and-braces — if a hand-crafted metadata object bypassed
    // the decorator, treat missing dependsOn as an error.
    throw new Error(
      `[assertExpandContractDependency] contract-phase migration MUST declare dependsOn`,
    );
  }

  // Probe observability schema existence. A fresh cluster pre-Phase-0
  // returns zero rows — we treat that as a skip (fail-open at
  // bootstrap) rather than a block.
  const schemaProbe: Array<{ exists: boolean }> = await options.dataSource.query(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'observability'
          AND table_name = 'migration_backfill_progress'
     ) AS exists`,
  );
  if (schemaProbe.length === 0 || !schemaProbe[0]?.exists) {
    return {
      checked: false,
      skipped: true,
      dependsOn: meta.dependsOn,
      reason: 'observability.migration_backfill_progress missing — fail-open at bootstrap',
    };
  }

  const rows: Array<{ count: string }> = await options.dataSource.query(
    `SELECT COUNT(*)::text AS count
       FROM observability.migration_backfill_progress
      WHERE migration_name = $1
        AND environment = $2`,
    [meta.dependsOn, options.environment],
  );
  const count = Number.parseInt(rows[0]?.count ?? '0', 10);
  if (count < 1) {
    throw new Error(
      `[assertExpandContractDependency] contract migration cannot run — ` +
        `dependsOn '${meta.dependsOn}' has not been applied in environment '${options.environment}'. ` +
        `Apply the expand migration first; a successful apply records a row in ` +
        `observability.migration_backfill_progress via RecordMigrationEventHandler.`,
    );
  }
  return {
    checked: true,
    skipped: false,
    dependsOn: meta.dependsOn,
  };
}
