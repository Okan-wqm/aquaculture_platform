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
 * import { ExpandContract } from '@aquaculture/backend-common/expand-contract.decorator.ts';
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

import { ClassConstructor, isClassConstructor } from '../types/class-constructor';

/** Reflect metadata key. Exported so the PR gate + tests can read it. */
export const EXPAND_CONTRACT_META_KEY = Symbol.for('@aquaculture/backend-common:expand-contract');

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
  readonly target: ClassConstructor;
}

export type ExpandContractDecorator = <TConstructor extends ClassConstructor>(
  target: TConstructor,
) => void;

/**
 * Class decorator. Attaches the options to the migration class under
 * EXPAND_CONTRACT_META_KEY.
 */
export function ExpandContract(opts: ExpandContractOptions): ExpandContractDecorator {
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
  return <TConstructor extends ClassConstructor>(target: TConstructor): void => {
    Reflect.defineMetadata(EXPAND_CONTRACT_META_KEY, { ...opts, target }, target);
  };
}

/**
 * Read @ExpandContract metadata from a migration class. Returns
 * `undefined` when not decorated — safe to call unconditionally.
 */
export function getExpandContractMetadata(
  ctor: ClassConstructor,
): ExpandContractMetadata | undefined {
  const raw: unknown = Reflect.getMetadata(EXPAND_CONTRACT_META_KEY, ctor);
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new TypeError('@ExpandContract metadata must be an object');
  }

  const record = raw as Record<string, unknown>;
  const phase = record['phase'];
  const target = record['target'];
  const dependsOn = record['dependsOn'];
  const reason = record['reason'];
  if (phase !== 'expand' && phase !== 'contract') {
    throw new TypeError('@ExpandContract metadata has an invalid phase');
  }
  if (!isClassConstructor(target)) {
    throw new TypeError('@ExpandContract metadata has an invalid target');
  }
  if (dependsOn !== undefined && typeof dependsOn !== 'string') {
    throw new TypeError('@ExpandContract metadata has an invalid dependsOn');
  }
  if (reason !== undefined && typeof reason !== 'string') {
    throw new TypeError('@ExpandContract metadata has an invalid reason');
  }

  return {
    phase,
    target,
    ...(dependsOn !== undefined ? { dependsOn } : {}),
    ...(reason !== undefined ? { reason } : {}),
  };
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
export function authorizesBreaking(ctor: ClassConstructor): 'yes' | 'expand' | 'no' {
  const meta = getExpandContractMetadata(ctor);
  if (meta === undefined) return 'no';
  return meta.phase === 'contract' ? 'yes' : 'expand';
}

export interface MigrationClassification {
  readonly name: string;
  readonly authorization: 'yes' | 'expand' | 'no';
  readonly phase?: ExpandContractPhase;
  readonly dependsOn?: string;
}

export interface BatchClassificationResult {
  /**
   * True iff every class in the input set carries EITHER an expand
   * decorator (non-breaking) OR a contract decorator with valid
   * dependsOn. A single 'no' classification in the set flips this
   * to false.
   */
  readonly allAuthorized: boolean;
  readonly classifications: readonly MigrationClassification[];
  readonly undecorated: readonly string[];
}

/**
 * Batch classification for PR-gate orchestration. The GHA workflow
 * collects the migration classes added in the PR, imports each, and
 * passes them here to decide whether the breaking-diff allowance
 * should fire.
 *
 * Returns structured data (never boolean-only) so the gate's log
 * output can name exactly which migration lacks authorization — the
 * reviewer sees the concrete fix required.
 */
export function classifyMigrationsForBreaking(
  migrations: ReadonlyArray<{ name: string; ctor: ClassConstructor }>,
): BatchClassificationResult {
  const classifications: MigrationClassification[] = [];
  const undecorated: string[] = [];
  for (const m of migrations) {
    const meta = getExpandContractMetadata(m.ctor);
    const authorization = authorizesBreaking(m.ctor);
    const base: MigrationClassification = {
      name: m.name,
      authorization,
      ...(meta?.phase !== undefined ? { phase: meta.phase } : {}),
      ...(meta?.dependsOn !== undefined ? { dependsOn: meta.dependsOn } : {}),
    };
    classifications.push(base);
    if (authorization === 'no') undecorated.push(m.name);
  }
  return {
    allAuthorized: undecorated.length === 0,
    classifications,
    undecorated,
  };
}
