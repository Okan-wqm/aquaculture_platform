/**
 * RetentionPolicy — declarative, entity-typed data-retention contract.
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
 * register a policy at module-init time; a single
 * RetentionEnforcementService iterates the registry daily. Adding a
 * new table to the retention regime is a one-line registry entry, not a
 * new service + module + spec suite.
 *
 * # Why the registration is ENTITY-typed (ADR-0012)
 *
 * Until 2026-09-05 a policy named its table and column as strings:
 * `{ schema: 'shared', tableName: 'audit_logs', timestampColumn: 'created_at' }`.
 * The physical column is `"createdAt"`. The enforcer quoted the identifier,
 * PostgreSQL raised `column "created_at" does not exist`, and the per-policy
 * catch swallowed it — the SOC 2 seven-year and ninety-day windows never ran
 * once, and no test could tell, because a string is not checkable against a
 * table.
 *
 * A registration now names the TypeORM entity class and a PROPERTY of it:
 * `{ entity: AuditLogEntity, timestampProperty: 'createdAt' }`. `keyof T`
 * makes a wrong property a compile error. Schema, table and the physical
 * column name are derived from the entity's decorator metadata at
 * registration, so the SQL the enforcer runs is the SQL the entity maps —
 * the same source of truth the ORM writes with.
 *
 * # Legal hold is not optional
 *
 * An entity that declares a `legalHold` column is a ledger under litigation
 * semantics; a policy over it MUST name that property (`legalHoldProperty`)
 * so held rows are excluded from disposal. Registration refuses otherwise.
 * Entities whose hold is a predicate rather than a flag (an override that is
 * still active) pass `legalHoldClause` explicitly.
 */
import { getMetadataArgsStorage } from 'typeorm';

/** SAFE_IDENT_RE subset — duplicated locally to avoid importing sql-fragments. */
const SAFE_IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * A class constructor the ORM decorated with `@Entity`. TypeORM instantiates
 * entities with a parameterless constructor, so the type demands exactly
 * that — an entity with required constructor arguments cannot be registered.
 */
export type EntityClass<T extends object> = new () => T;

export interface RetentionPolicyRegistration<T extends object> {
  /** Policy id for logs + tests; MUST be unique within the registry. */
  readonly id: string;
  /**
   * Free-form owner tag — e.g. `soc2-cc4.1` or `kvkk-breach-window`.
   * Surfaces in enforcement logs for SOC2 evidence chains.
   */
  readonly ownerTag: string;
  /** The decorated entity whose rows the policy disposes. */
  readonly entity: EntityClass<T>;
  /** Entity property holding the age the policy compares against NOW() - retentionDays. */
  readonly timestampProperty: keyof T & string;
  /** Integer days of retention. ≥ 1. */
  readonly retentionDays: number;
  /**
   * Boolean property flagging a row under legal hold. REQUIRED when the
   * entity declares a `legalHold` column. Held rows are never disposed.
   */
  readonly legalHoldProperty?: keyof T & string;
  /**
   * Raw SQL predicate for holds that are not a single boolean column
   * (e.g. `revoked_at IS NULL AND expires_at > NOW()`). Rows matching it
   * are PRESERVED. Use $N placeholders with `legalHoldParams`.
   */
  readonly legalHoldClause?: string;
  readonly legalHoldParams?: readonly unknown[];
  /**
   * Equality predicates narrowing the disposal set, keyed by entity
   * property (e.g. `{ status: 'completed' }` so only finished jobs age out).
   * Resolved to physical columns and bound as parameters.
   */
  readonly where?: Readonly<Partial<Record<keyof T & string, string | number | boolean>>>;
}

/** The resolved, SQL-addressable policy the enforcer runs. */
export interface RetentionPolicy {
  readonly id: string;
  readonly ownerTag: string;
  /** PG schema holding the target table. Derived from `@Entity({ schema })`. */
  readonly schema: string;
  /** Target table. Derived from `@Entity('<name>')`. */
  readonly tableName: string;
  /** Physical timestamp column. Derived from the entity's column metadata. */
  readonly timestampColumn: string;
  readonly retentionDays: number;
  readonly legalHoldClause?: string;
  readonly legalHoldParams?: readonly unknown[];
  /** Physical-column equality filters, in registration order. */
  readonly filters: readonly {
    readonly column: string;
    readonly value: string | number | boolean;
  }[];
  /** True when the entity carries a legalHold column (surfaced for operators). */
  readonly legalHoldAware: boolean;
}

const registeredPolicies = new Map<string, RetentionPolicy>();

function entityTargets(entity: Function): Function[] {
  const targets: Function[] = [];
  let current: Function | null = entity;
  while (current && current !== Function.prototype && current !== Object) {
    targets.push(current);
    current = Object.getPrototypeOf(current) as Function | null;
  }
  return targets;
}

interface ResolvedTable {
  schema: string;
  tableName: string;
}

function resolveTable(entity: Function, policyId: string): ResolvedTable {
  const table = getMetadataArgsStorage().tables.find((t) => t.target === entity);
  if (!table) {
    throw new TypeError(
      `[retention] policy '${policyId}': ${entity.name} is not decorated with @Entity — retention binds to ORM metadata, not to strings`,
    );
  }
  if (typeof table.name !== 'string' || !SAFE_IDENT_RE.test(table.name)) {
    throw new TypeError(
      `[retention] policy '${policyId}': ${entity.name} must declare an explicit @Entity('<table>') name`,
    );
  }
  if (typeof table.schema !== 'string' || !SAFE_IDENT_RE.test(table.schema)) {
    throw new TypeError(
      `[retention] policy '${policyId}': ${entity.name} must declare @Entity({ schema }) — retention runs over cross-tenant tables only`,
    );
  }
  return { schema: table.schema, tableName: table.name };
}

function resolveColumn(entity: Function, property: string, policyId: string): string {
  const targets = entityTargets(entity);
  const column = getMetadataArgsStorage().columns.find(
    (c) => targets.includes(c.target as Function) && c.propertyName === property,
  );
  if (!column) {
    throw new TypeError(
      `[retention] policy '${policyId}': ${entity.name}.${property} is not a mapped column`,
    );
  }
  const physical = column.options.name ?? column.propertyName;
  if (!SAFE_IDENT_RE.test(physical)) {
    throw new RangeError(`[retention] policy '${policyId}': unsafe column name '${physical}'`);
  }
  return physical;
}

function entityDeclaresLegalHold(entity: Function): boolean {
  const targets = entityTargets(entity);
  return getMetadataArgsStorage().columns.some(
    (c) =>
      targets.includes(c.target as Function) &&
      (c.propertyName === 'legalHold' || c.options.name === 'legalHold'),
  );
}

/**
 * Register a retention policy. Resolves the entity's schema, table and
 * physical column names from its decorator metadata, validates the days,
 * enforces legal-hold coverage, and refuses duplicate ids. Call at
 * module-init time.
 */
export function registerRetentionPolicy<T extends object>(
  registration: RetentionPolicyRegistration<T>,
): RetentionPolicy {
  if (!registration.id || typeof registration.id !== 'string') {
    throw new TypeError(`[retention] policy.id must be a non-empty string`);
  }
  if (registeredPolicies.has(registration.id)) {
    throw new Error(
      `[retention] policy id '${registration.id}' already registered. Registry ids MUST be unique.`,
    );
  }
  if (!Number.isInteger(registration.retentionDays) || registration.retentionDays < 1) {
    throw new RangeError(
      `[retention] retentionDays must be an integer ≥ 1 (got ${registration.retentionDays})`,
    );
  }
  const { schema, tableName } = resolveTable(registration.entity, registration.id);
  const timestampColumn = resolveColumn(
    registration.entity,
    registration.timestampProperty,
    registration.id,
  );

  const legalHoldAware = entityDeclaresLegalHold(registration.entity);
  let legalHoldClause = registration.legalHoldClause;
  if (registration.legalHoldProperty) {
    const holdColumn = resolveColumn(
      registration.entity,
      registration.legalHoldProperty,
      registration.id,
    );
    legalHoldClause = legalHoldClause
      ? `("${holdColumn}" = true) OR (${legalHoldClause})`
      : `"${holdColumn}" = true`;
  }
  if (legalHoldAware && !registration.legalHoldProperty) {
    throw new TypeError(
      `[retention] policy '${registration.id}': ${registration.entity.name} declares a legalHold column; the policy must name it via legalHoldProperty so held rows are never disposed`,
    );
  }

  const where: Partial<Record<keyof T & string, string | number | boolean>> =
    registration.where ?? {};
  const filters = (Object.keys(where) as Array<keyof T & string>).map((property) => {
    const value = where[property];
    if (value === undefined) {
      throw new TypeError(
        `[retention] policy '${registration.id}': where.${property} is undefined`,
      );
    }
    return { column: resolveColumn(registration.entity, property, registration.id), value };
  });

  const policy: RetentionPolicy = {
    id: registration.id,
    ownerTag: registration.ownerTag,
    schema,
    tableName,
    timestampColumn,
    retentionDays: registration.retentionDays,
    legalHoldClause,
    legalHoldParams: registration.legalHoldParams,
    filters,
    legalHoldAware,
  };
  registeredPolicies.set(policy.id, policy);
  return policy;
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
