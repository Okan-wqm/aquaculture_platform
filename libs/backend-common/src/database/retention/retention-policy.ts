/**
 * RetentionPolicy — declarative data-retention contract.
 * ============================================================================
 *
 * # Why a registry + generic enforcer instead of one service per table?
 *
 * The alternative — a dedicated `XyzRetentionService` per table — was
 * rejected as a copy-paste anti-pattern: every new audit table would
 * require duplicating the cron-wired service, its DI wiring, its tests,
 * AND its per-table retention-days knob. A single pattern mistake
 * propagates to N copies; a single correction has to land N times.
 *
 * The registry turns retention into DATA instead of code. Services
 * register a `RetentionPolicy` at module-init time; a single
 * RetentionEnforcementService iterates the registry daily. Adding a
 * new audit table to the retention regime is a one-line registry
 * entry, not a new service + module + spec suite.
 *
 * # Contract shape
 *
 *   - schema + tableName: the SQL-addressable row source. Identifiers
 *     are inlined into the DELETE statement — callers must pass
 *     SAFE_IDENT_RE-valid names (validated at registration time).
 *   - timestampColumn: the column holding the "age" the policy
 *     compares against a calculated cutoff. Typically
 *     `occurred_at` / `created_at`.
 *   - retentionDays: integer ≥ 1 for fixed day-count policies, or
 *     retentionPeriod: ISO-8601 calendar period for calendar semantics.
 *   - legalHoldClause: optional SQL predicate that SUPPRESSES delete
 *     on matching rows. Used for row-level legal hold (e.g.
 *     `revoked_at IS NULL AND id NOT IN (SELECT ... FROM legal_holds)`).
 *     When omitted, no hold applies — pure age-based delete.
 *
 * # Why legal-hold is a POLICY FIELD not an enforcer option
 *
 * Different tables have different hold semantics: migration_events
 * has none; emergency_overrides suppresses revoked rows; finding
 * registry rows tied to open incidents may hold indefinitely. Putting
 * the predicate on the POLICY makes the hold rule travel WITH the
 * table registration — the enforcer is schema-agnostic.
 */

/** SAFE_IDENT_RE subset — duplicated locally to avoid importing sql-fragments. */
const SAFE_IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

interface RetentionPolicyBase {
  /** Policy id for logs + tests; MUST be unique within the registry. */
  readonly id: string;
  /** PG schema holding the target table. SAFE_IDENT_RE validated. */
  readonly schema: string;
  /** Target table. SAFE_IDENT_RE validated. */
  readonly tableName: string;
  /** Timestamp column for age comparison. SAFE_IDENT_RE validated. */
  readonly timestampColumn: string;
  /**
   * Optional SQL predicate appended to the DELETE's WHERE clause.
   * Rows matching this predicate are PRESERVED (`legal_hold_clause`
   * IS AND'd with NOT) so the predicate's semantic is "should this
   * row be held?". When omitted, no hold applies.
   *
   * Example:
   *   legalHoldClause: `revoked_at IS NULL`
   * → DELETE WHERE <ts column> < cutoff AND NOT (revoked_at IS NULL)
   * = DELETE WHERE ... AND revoked_at IS NOT NULL
   *
   * Use parameterised predicates via $N placeholders; supply
   * `legalHoldParams` in the same order.
   */
  readonly legalHoldClause?: string;
  readonly legalHoldParams?: readonly unknown[];
  /**
   * Free-form owner tag — e.g. `soc2-cc4.1` or `kvkk-breach-window`.
   * Surfaces in enforcement logs for SOC2 evidence chains.
   */
  readonly ownerTag: string;
}

export type RetentionPolicy = RetentionPolicyBase &
  (
    | {
        /** Fixed integer days of retention. ≥ 1. */
        readonly retentionDays: number;
        readonly retentionPeriod?: never;
      }
    | {
        /** ISO-8601 date-only calendar period, for example P90D or P5Y. */
        readonly retentionPeriod: string;
        readonly retentionDays?: never;
      }
  );

const registeredPolicies = new Map<string, RetentionPolicy>();

/**
 * Register a retention policy. Validates identifier safety + positive
 * retention duration + unique id. Call at module-init time.
 */
export function registerRetentionPolicy(policy: RetentionPolicy): void {
  if (!SAFE_IDENT_RE.test(policy.schema)) {
    throw new RangeError(
      `[retention] invalid schema identifier '${policy.schema}' — must match ${SAFE_IDENT_RE.source}`,
    );
  }
  if (!SAFE_IDENT_RE.test(policy.tableName)) {
    throw new RangeError(`[retention] invalid tableName '${policy.tableName}'`);
  }
  if (!SAFE_IDENT_RE.test(policy.timestampColumn)) {
    throw new RangeError(`[retention] invalid timestampColumn '${policy.timestampColumn}'`);
  }
  if (policy.retentionDays !== undefined) {
    if (!Number.isInteger(policy.retentionDays) || policy.retentionDays < 1) {
      throw new RangeError(
        `[retention] retentionDays must be an integer ≥ 1 (got ${policy.retentionDays})`,
      );
    }
  } else if (!/^P(?=\d+[YMD])(?:\d+Y)?(?:\d+M)?(?:\d+D)?$/.test(policy.retentionPeriod)) {
    throw new RangeError(
      `[retention] retentionPeriod must be an ISO-8601 date-only calendar period (got ${policy.retentionPeriod})`,
    );
  }
  if (!policy.id || typeof policy.id !== 'string') {
    throw new TypeError(`[retention] policy.id must be a non-empty string`);
  }
  if (registeredPolicies.has(policy.id)) {
    throw new Error(
      `[retention] policy id '${policy.id}' already registered. Registry ids MUST be unique.`,
    );
  }
  registeredPolicies.set(policy.id, policy);
}

/** Test / module-reset hook. */
export function clearRetentionPolicyRegistry(): void {
  registeredPolicies.clear();
}

export function listRetentionPolicies(): readonly RetentionPolicy[] {
  return Array.from(registeredPolicies.values());
}

export function getRetentionPolicy(id: string): RetentionPolicy | undefined {
  return registeredPolicies.get(id);
}
