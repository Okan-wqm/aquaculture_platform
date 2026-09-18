/**
 * Tenant-erasure table policy — every table of a source-schema erasure
 * target says, by name, how a tenant's rows are reached (ADMIN-CRITICAL-009).
 *
 * WHY: the executor used to DERIVE its targets by sniffing
 * `information_schema.columns` for a column called `tenantId` / `tenant_id`.
 * A table whose tenant rows hang off a parent (`messages` → `message_threads`,
 * `ticket_comments` → `support_tickets`, `job_execution_logs` →
 * `background_jobs`) has no such column and was silently skipped; a ledger that
 * happens to carry the column was silently deleted. Erasure was structurally
 * incomplete and nothing could say so.
 *
 * A policy is one of three explicit statements:
 *   - `tenant-column`: rows are `WHERE "<column>" = $tenant`.
 *   - `cascade-via`:   rows are reached through a parent table's tenant rows
 *                      (`WHERE "<foreignKey>" IN (SELECT "<parentKey>" FROM parent
 *                      WHERE <parent's predicate>)`), recursively.
 *   - `excluded`:      rows are not erased, and the policy says why (a WORM
 *                      ledger, platform reference data, an archive the
 *                      retention authority prunes, the erasure operation
 *                      itself).
 *
 * The registry is complete by construction: {@link tenantErasurePolicyProblems}
 * refuses a policy set that misses a registered table, names an unregistered
 * one, cascades into an excluded or missing parent, or cycles — at boot
 * (executor construction) and in CI (`tests/invariants/tenant-erasure-table-policy.spec.ts`).
 */
import { MODULE_SCHEMAS } from '../../database/schema-manager.service';
import { validateSqlIdentifier } from '../../database/sql-identifier.util';

export interface TenantColumnPolicy {
  readonly kind: 'tenant-column';
  /** The database column holding the tenant id (`tenantId` or `tenant_id`). */
  readonly column: string;
}

export interface CascadeViaPolicy {
  readonly kind: 'cascade-via';
  /** The table whose tenant rows this table's rows belong to. */
  readonly parent: string;
  /** This table's column that references the parent. */
  readonly foreignKey: string;
  /** The parent column the foreign key references. Default `id`. */
  readonly parentKey?: string;
}

export interface ExcludedPolicy {
  readonly kind: 'excluded';
  /** Why a tenant's erasure leaves this table alone. Read by auditors; never empty. */
  readonly reason: string;
}

export type TenantErasureTablePolicy = TenantColumnPolicy | CascadeViaPolicy | ExcludedPolicy;

export type TenantErasureTablePolicies = Readonly<Record<string, TenantErasureTablePolicy>>;

/** The tables a MODULE_SCHEMAS entry registers for a module — data and infrastructure alike. */
export function registeredTables(moduleName: string): readonly string[] | null {
  const entry = MODULE_SCHEMAS.find((candidate) => candidate.moduleName === moduleName);
  if (!entry) return null;
  return [...new Set([...entry.tables, ...(entry.infrastructureTables ?? [])])].sort();
}

/**
 * Everything wrong with a policy set for a module. Empty means complete:
 * the policy names exactly the registered tables, every cascade resolves to a
 * table that is itself erased, and no cascade cycles.
 */
export function tenantErasurePolicyProblems(
  moduleName: string,
  policies: TenantErasureTablePolicies,
  structuralExclusions: readonly string[],
): string[] {
  const problems: string[] = [];
  const registered = registeredTables(moduleName);
  if (registered === null) {
    return [`no MODULE_SCHEMAS entry for module '${moduleName}'`];
  }
  const declared = Object.keys(policies).sort();
  for (const table of registered) {
    if (!(table in policies)) problems.push(`registered table '${table}' has no erasure policy`);
  }
  for (const table of declared) {
    if (!registered.includes(table)) {
      problems.push(
        `policy names '${table}', which MODULE_SCHEMAS does not register for '${moduleName}'`,
      );
    }
  }
  for (const table of structuralExclusions) {
    const policy = policies[table];
    if (policy && policy.kind !== 'excluded') {
      problems.push(
        `'${table}' is the target's outbox or proof ledger and must be 'excluded', not '${policy.kind}'`,
      );
    }
  }
  for (const [table, policy] of Object.entries(policies)) {
    try {
      validateSqlIdentifier(table, 'table');
    } catch {
      problems.push(`'${table}' is not a valid table identifier`);
      continue;
    }
    if (policy.kind === 'tenant-column') {
      if (!isIdentifier(policy.column))
        problems.push(`'${table}': column '${policy.column}' is not an identifier`);
    } else if (policy.kind === 'cascade-via') {
      if (!isIdentifier(policy.foreignKey)) {
        problems.push(`'${table}': foreignKey '${policy.foreignKey}' is not an identifier`);
      }
      if (policy.parentKey !== undefined && !isIdentifier(policy.parentKey)) {
        problems.push(`'${table}': parentKey '${policy.parentKey}' is not an identifier`);
      }
      const parent = policies[policy.parent];
      if (!parent) {
        problems.push(`'${table}' cascades via '${policy.parent}', which has no policy`);
      } else if (parent.kind === 'excluded') {
        problems.push(
          `'${table}' cascades via '${policy.parent}', which is excluded — its rows would never be reached`,
        );
      }
    } else if (policy.reason.trim().length === 0) {
      problems.push(`'${table}' is excluded without a reason`);
    }
  }
  for (const table of Object.keys(policies)) {
    const seen = new Set<string>();
    let current: string | undefined = table;
    while (current !== undefined) {
      if (seen.has(current)) {
        problems.push(`cascade cycle through '${table}'`);
        break;
      }
      seen.add(current);
      const policy: TenantErasureTablePolicy | undefined = policies[current];
      current = policy?.kind === 'cascade-via' ? policy.parent : undefined;
    }
  }
  return problems;
}

/** Tables a tenant's erasure deletes from, in declaration order (the executor FK-sorts them). */
export function erasedTables(policies: TenantErasureTablePolicies): string[] {
  return Object.entries(policies)
    .filter(([, policy]) => policy.kind !== 'excluded')
    .map(([table]) => table);
}

/**
 * The SQL predicate selecting one tenant's rows of `table`, with the tenant id
 * bound as `$1`. Cascades nest a sub-select per hop; every identifier passes
 * through the same validator the executor uses for schema and table names.
 */
export function tenantRowPredicate(
  schemaName: string,
  table: string,
  policies: TenantErasureTablePolicies,
): string {
  const schema = validateSqlIdentifier(schemaName, 'schema');
  const policy = policies[table];
  if (!policy || policy.kind === 'excluded') {
    throw new Error(`'${table}' has no erasing policy`);
  }
  if (policy.kind === 'tenant-column') {
    return `"${validateSqlIdentifier(policy.column, 'column')}" = $1`;
  }
  const parent = validateSqlIdentifier(policy.parent, 'table');
  const parentKey = validateSqlIdentifier(policy.parentKey ?? 'id', 'column');
  const foreignKey = validateSqlIdentifier(policy.foreignKey, 'column');
  return `"${foreignKey}" IN (SELECT "${parentKey}" FROM "${schema}"."${parent}" WHERE ${tenantRowPredicate(schema, policy.parent, policies)})`;
}

/** The (table, column) pairs the database must actually have for the policy to be true. */
export function requiredColumns(
  policies: TenantErasureTablePolicies,
): Array<{ table: string; column: string }> {
  const required: Array<{ table: string; column: string }> = [];
  for (const [table, policy] of Object.entries(policies)) {
    if (policy.kind === 'tenant-column') required.push({ table, column: policy.column });
    if (policy.kind === 'cascade-via') {
      required.push({ table, column: policy.foreignKey });
      required.push({ table: policy.parent, column: policy.parentKey ?? 'id' });
    }
  }
  return required;
}

function isIdentifier(value: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(value);
}
