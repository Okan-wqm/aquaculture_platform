/**
 * @ExpandContract — declarative marker for blue-green migration phases.
 * ============================================================================
 *
 * Blue-green / expand-contract deployments split a schema change into
 * two coordinated migrations:
 *
 *   1. EXPAND  — add the new shape alongside the old. Safe to deploy
 *                at any time (ADR-012 — new column + old column both
 *                exist until the app rollout finishes).
 *   2. CONTRACT — remove the old shape after the app fully ships the
 *                 new behaviour. MUST NOT run until the expand
 *                 migration is already deployed everywhere.
 *
 * The PR gate (schema-snapshot-diff) treats CONTRACT-phase migrations
 * with breaking changes as ALLOWED only when the decorator is present
 * AND the `dependsOn` chain references a migration that is already on
 * the main branch. Without the decorator, the gate fails on any
 * breaking diff — the default-deny rule that plan v3 R12 established.
 *
 * # Usage
 *
 * ```ts
 * import { ExpandContract } from '@aquaculture/backend-common';
 *
 * (at)ExpandContract({ phase: 'expand' })
 * export class AddEmployeePreferredName1786900000000 implements MigrationInterface {
 *   name = 'AddEmployeePreferredName1786900000000';
 *   async up(qr: QueryRunner) { // add column as NULLABLE
 *   }
 * }
 *
 * (at)ExpandContract({
 *   phase: 'contract',
 *   dependsOn: 'AddEmployeePreferredName1786900000000',
 * })
 * export class DropEmployeeLegacyName1787000000000 implements MigrationInterface {
 *   name = 'DropEmployeeLegacyName1787000000000';
 *   async up(qr: QueryRunner) { // drop the old column
 *   }
 * }
 * ```
 *
 * The PR gate parses the decorator metadata at gate-time to decide
 * whether a breaking diff is authorized. No runtime consumer exists
 * today — it's purely a CI-time marker.
 */
import 'reflect-metadata';

/** Reflect metadata key. Exported so the PR gate + tests can read it. */
export const EXPAND_CONTRACT_META_KEY = Symbol.for(
  '@aquaculture/backend-common:expand-contract',
);

export type ExpandContractPhase = 'expand' | 'contract';

export interface ExpandContractOptions {
  readonly phase: ExpandContractPhase;
  /**
   * For contract migrations: the migration NAME (matching TypeORM's
   * `name` field) of the expand migration that MUST be applied first.
   * The PR gate verifies the referenced migration exists on main
   * before allowing the contract migration's breaking diff.
   */
  readonly dependsOn?: string;
  /**
   * Optional free-form reason recorded with the metadata. Surfaces in
   * PR-gate reports to the reviewer.
   */
  readonly reason?: string;
}

/**
 * Runtime-readable shape attached to a migration class.
 */
export interface ExpandContractMetadata extends ExpandContractOptions {
  /** Class constructor for debug attribution. */
  readonly target: Function;
}

/**
 * Class decorator. Attaches the options to the migration class under
 * EXPAND_CONTRACT_META_KEY.
 */
export function ExpandContract(
  opts: ExpandContractOptions,
): ClassDecorator {
  if (opts.phase !== 'expand' && opts.phase !== 'contract') {
    throw new RangeError(
      `@ExpandContract: phase must be 'expand' or 'contract' (got '${String(opts.phase)}')`,
    );
  }
  if (opts.phase === 'contract') {
    if (!opts.dependsOn || typeof opts.dependsOn !== 'string') {
      throw new TypeError(
        `@ExpandContract: contract-phase migrations REQUIRE a dependsOn: '<expand-migration-name>' field. ` +
          `Without it, the PR gate cannot verify the expand migration is already deployed.`,
      );
    }
  }
  if (opts.dependsOn !== undefined && typeof opts.dependsOn !== 'string') {
    throw new TypeError(
      `@ExpandContract: dependsOn must be a string (got ${typeof opts.dependsOn})`,
    );
  }
  return (target: Function): void => {
    Reflect.defineMetadata(
      EXPAND_CONTRACT_META_KEY,
      { ...opts, target },
      target,
    );
  };
}

/**
 * Read @ExpandContract metadata from a migration class. Returns
 * `undefined` when not decorated — safe to call unconditionally.
 */
export function getExpandContractMetadata(
  ctor: Function,
): ExpandContractMetadata | undefined {
  const raw = Reflect.getMetadata(EXPAND_CONTRACT_META_KEY, ctor);
  if (raw === undefined || raw === null) return undefined;
  return raw as ExpandContractMetadata;
}

/**
 * Convenience: is this migration class authorized to carry breaking
 * diffs? Returns:
 *   - 'yes' when decorated phase=contract with valid dependsOn.
 *   - 'expand' when phase=expand (never breaking by definition, but
 *      the marker means "this is the first half of a pair; the next
 *      contract is coming").
 *   - 'no' when undecorated — breaking diff MUST fail the gate.
 */
export function authorizesBreaking(
  ctor: Function,
): 'yes' | 'expand' | 'no' {
  const meta = getExpandContractMetadata(ctor);
  if (meta === undefined) return 'no';
  return meta.phase === 'contract' ? 'yes' : 'expand';
}
