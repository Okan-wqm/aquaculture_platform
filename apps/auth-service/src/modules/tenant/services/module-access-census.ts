/**
 * What auth knows for the module-access readiness report (PKG-06 "Readiness"; ADR-051 §2): one
 * tenant's members, administrators, enabled owner modules and live grants.
 *
 * WHY: the readiness report counts who would lose a module once the services decide by grants
 * (R4). The answer must use the same definition of a grant the token carries, so the grants are
 * read through the module-access reader's predicate (liveGrantRowsSql: active, unexpired, module
 * enabled) and narrowed as the claim is (owner modules and module roles only).
 *
 * WHAT: `readModuleAccessCensus` runs three reads through the caller's query function, which the
 * caller has bound to the tenant (RLS): the active users with their users.role, the tenant's
 * enabled modules (the reader's TENANT_MODULES_SQL), and every live grant in the tenant. It keeps
 * ids only to join and to ask the owner modules; the report built from it holds counts only.
 */
import {
  OWNER_MODULE_CODES,
  isModuleRole,
  isOwnerModuleCode,
  isPlatformRole,
  platformRoleSatisfies,
  type ModuleAccess,
  type ModuleRole,
  type OwnerModuleCode,
  type PlatformRole,
} from '@aquaculture/shared-contracts';

import {
  TENANT_MODULES_SQL,
  liveGrantRowsSql,
  type ModuleAccessQuery,
} from '../../authentication/services/module-access-reader';

/** The tenant's active users with their users.role. */
export const CENSUS_USERS_SQL = `
  SELECT u.id, u.role
    FROM auth.users u
   WHERE u."tenantId" = $1 AND u."isActive" = true`;

/** Every live grant in the tenant, as the claim reads one. */
export const CENSUS_GRANTS_SQL = liveGrantRowsSql(
  'uma."userId", m.code, uma."role"',
  'uma."tenantId" = $1',
);

export interface CensusUser {
  readonly id: string;
  /** users.role: an account role, or the legacy global MODULE_MANAGER / MODULE_USER. */
  readonly role: PlatformRole;
}

export interface ModuleAccessCensus {
  readonly users: readonly CensusUser[];
  /** The enabled owner modules, in the dictionary's order. */
  readonly enabledModules: readonly OwnerModuleCode[];
  /** Each user's live grants (an absent user holds none). */
  readonly grants: ReadonlyMap<string, ModuleAccess>;
}

function rowsOf(result: unknown, read: string): readonly unknown[] {
  if (!Array.isArray(result)) throw new TypeError(`module-access census: ${read} returned no rows`);
  return result;
}

function field(row: unknown, key: string): unknown {
  return typeof row === 'object' && row !== null ? Reflect.get(row, key) : undefined;
}

function censusUserOf(row: unknown, index: number): CensusUser {
  const id = field(row, 'id');
  const role = field(row, 'role');
  if (typeof id !== 'string' || !isPlatformRole(role)) {
    // Fail loud: a report that skipped a user would undercount who loses access.
    throw new TypeError(`module-access census: user row ${index} has no id or platform role`);
  }
  return { id, role };
}

export async function readModuleAccessCensus(
  query: ModuleAccessQuery,
  tenantId: string,
): Promise<ModuleAccessCensus> {
  const users = rowsOf(await query(CENSUS_USERS_SQL, [tenantId]), 'users').map(censusUserOf);

  const enabledCodes = new Set(
    rowsOf(await query(TENANT_MODULES_SQL, [tenantId]), 'tenant modules').map((row) =>
      field(row, 'code'),
    ),
  );
  const enabledModules = OWNER_MODULE_CODES.filter((code) => enabledCodes.has(code));

  const grants = new Map<string, { [Code in OwnerModuleCode]?: ModuleRole }>();
  for (const row of rowsOf(await query(CENSUS_GRANTS_SQL, [tenantId]), 'grants')) {
    const userId = field(row, 'userId');
    const code = field(row, 'code');
    const role = field(row, 'role');
    // The claim's narrowing: alert, ai, unknown codes and roleless rows grant nothing.
    if (typeof userId !== 'string' || !isOwnerModuleCode(code) || !isModuleRole(role)) continue;
    const held = grants.get(userId) ?? {};
    const current = held[code];
    if (current === undefined || !platformRoleSatisfies(current, role)) held[code] = role;
    grants.set(userId, held);
  }
  return { users, enabledModules, grants };
}
