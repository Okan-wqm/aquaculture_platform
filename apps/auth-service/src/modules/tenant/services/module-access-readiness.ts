/**
 * The module-access readiness report, in counts (PKG-06 "Readiness"; plan §6 R4 entry gate:
 * "readiness counts are zero or the owner signs off").
 *
 * WHY: from R4 the services decide by module grants, and the global users.role stops opening a
 * module. Before that, the operator needs to see who would lose access: members with no grant,
 * members who work in a module without holding its grant, and how payroll's audience changes
 * (D6). Counts only: the report names no member.
 *
 * WHAT: pure functions over the census (module-access-census.ts) and the owners' answers:
 *   - members are the census users without an account role — a TENANT_ADMIN holds every enabled
 *     module through the account role (ADR-051 §1, OQ1) and is never counted as lacking one;
 *   - `membersWithoutGrantIn` groups by users.role the ids an owner module is asked about;
 *   - `buildModuleAccessReadiness` assembles the report. Role counts list every role of their
 *     kind, zeros included, so the report's shape does not depend on the data.
 * Payroll: today the hr payroll and finance resolvers admit @Roles(TENANT_ADMIN, MODULE_MANAGER)
 * against users.role (apps/hr-service/src/hr/hr.resolver.ts:209-211); from enforcement the same
 * @Roles are checked by kind (ADR-051 §1): TENANT_ADMIN while hr is enabled, and the hr
 * MODULE_MANAGER grant.
 */
import {
  MODULE_ROLES,
  OWNER_MODULE,
  PLATFORM_ROLE,
  isModuleRole,
  type ModuleRole,
  type OwnerModuleCode,
  type PlatformRole,
} from '@aquaculture/shared-contracts';
import { RECENT_WRITER_QUERY_LIMITS } from '@platform/event-contracts';

import type { CensusUser, ModuleAccessCensus } from './module-access-census';

/** The plan's window: writes within the last 90 days count. */
export const READINESS_WINDOW_DAYS = RECENT_WRITER_QUERY_LIMITS.MAX_WINDOW_DAYS;

export interface RoleCount {
  readonly role: PlatformRole;
  readonly count: number;
}

/**
 * ANSWERED: the owner counted. NOT_TRACKED: the module has no writer query (the reserved
 * hydroponics, D3). UNAVAILABLE: the owner did not answer; the count is unknown, not zero.
 */
export type RecentWriterStatus = 'ANSWERED' | 'NOT_TRACKED' | 'UNAVAILABLE';

export interface RecentWriterReadiness {
  readonly status: RecentWriterStatus;
  /** By users.role; empty unless ANSWERED. */
  readonly byUserRole: readonly RoleCount[];
}

export interface ModuleReadiness {
  readonly moduleCode: OwnerModuleCode;
  /** The members' live grants in the module, by module role. */
  readonly grantsByRole: readonly RoleCount[];
  /** Members without the module's grant who wrote to it within the window. */
  readonly recentWritersWithoutGrant: RecentWriterReadiness;
}

export interface PayrollViewerReadiness {
  /** Who reaches payroll today, by users.role. */
  readonly byGlobalRole: readonly RoleCount[];
  /** Who reaches it once hr decides by grants: account role, then the hr manager grant. */
  readonly byGrant: readonly RoleCount[];
}

export interface ModuleAccessReadinessReport {
  readonly windowDays: number;
  /** Members holding no grant in any enabled owner module, by users.role. */
  readonly membersWithoutGrants: readonly RoleCount[];
  /** One entry per enabled owner module, in the dictionary's order. */
  readonly modules: readonly ModuleReadiness[];
  readonly payrollViewers: PayrollViewerReadiness;
}

/** A census user without an account role, with the legacy global role users.role holds. */
interface Member {
  readonly id: string;
  readonly role: ModuleRole;
}

function membersOf(census: ModuleAccessCensus): Member[] {
  return census.users.flatMap((user: CensusUser) =>
    isModuleRole(user.role) ? [{ id: user.id, role: user.role }] : [],
  );
}

function grantIn(
  census: ModuleAccessCensus,
  userId: string,
  code: OwnerModuleCode,
): ModuleRole | null {
  if (!census.enabledModules.includes(code)) return null;
  const held = census.grants.get(userId);
  return held === undefined ? null : (held[code] ?? null);
}

function countBy<Role extends PlatformRole>(
  roles: readonly Role[],
  values: readonly Role[],
): RoleCount[] {
  return roles.map((role) => ({ role, count: values.filter((value) => value === role).length }));
}

/** The ids of the members without a grant in `code`, by users.role (what its owner is asked). */
export function membersWithoutGrantIn(
  census: ModuleAccessCensus,
  code: OwnerModuleCode,
): ReadonlyMap<ModuleRole, readonly string[]> {
  const lacking = membersOf(census).filter((member) => grantIn(census, member.id, code) === null);
  return new Map(
    MODULE_ROLES.map((role) => [
      role,
      lacking.filter((member) => member.role === role).map((member) => member.id),
    ]),
  );
}

export function buildModuleAccessReadiness(
  census: ModuleAccessCensus,
  recentWriters: ReadonlyMap<OwnerModuleCode, RecentWriterReadiness>,
): ModuleAccessReadinessReport {
  const members = membersOf(census);
  const tenantAdmins = census.users.filter((user) => user.role === PLATFORM_ROLE.TENANT_ADMIN);
  const hrEnabled = census.enabledModules.includes(OWNER_MODULE.HR);
  const viewerRoles = [PLATFORM_ROLE.TENANT_ADMIN, PLATFORM_ROLE.MODULE_MANAGER] as const;

  return {
    windowDays: READINESS_WINDOW_DAYS,
    membersWithoutGrants: countBy(
      MODULE_ROLES,
      members
        .filter((member) =>
          census.enabledModules.every((code) => grantIn(census, member.id, code) === null),
        )
        .map((member) => member.role),
    ),
    modules: census.enabledModules.map((code) => ({
      moduleCode: code,
      grantsByRole: countBy(
        MODULE_ROLES,
        members.flatMap((member) => {
          const role = grantIn(census, member.id, code);
          return role === null ? [] : [role];
        }),
      ),
      recentWritersWithoutGrant: recentWriters.get(code) ?? {
        status: 'UNAVAILABLE',
        byUserRole: [],
      },
    })),
    payrollViewers: {
      byGlobalRole: countBy(
        viewerRoles,
        census.users.flatMap((user) =>
          user.role === PLATFORM_ROLE.TENANT_ADMIN || user.role === PLATFORM_ROLE.MODULE_MANAGER
            ? [user.role]
            : [],
        ),
      ),
      byGrant: [
        { role: PLATFORM_ROLE.TENANT_ADMIN, count: hrEnabled ? tenantAdmins.length : 0 },
        {
          role: PLATFORM_ROLE.MODULE_MANAGER,
          count: members.filter(
            (member) =>
              grantIn(census, member.id, OWNER_MODULE.HR) === PLATFORM_ROLE.MODULE_MANAGER,
          ).length,
        },
      ],
    },
  };
}
