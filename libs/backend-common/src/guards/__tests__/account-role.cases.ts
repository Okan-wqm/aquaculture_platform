import { member, type FixtureUser } from './access-context.fixture';

/**
 * RolesGuard's outcomes before ADR-051, read from roles.guard.ts at the base of PKG-05
 * (`canActivate` and `extractUserRoles`): `@Public()` passes; no `@Roles` admits any
 * authenticated user; `@Roles` is checked against `role` and `roles` through the one hierarchy,
 * case-insensitively, SUPER_ADMIN passing everything; no user or no recognisable role is denied.
 * An `account-role` guard must answer every row exactly so (plan PKG-05 accept: services not yet
 * enrolled behave exactly as before).
 */
export interface AccountRoleCase {
  readonly name: string;
  readonly handler: string;
  readonly user: FixtureUser | undefined;
  readonly allowed: boolean;
}

export const ACCOUNT_ROLE_CASES: readonly AccountRoleCase[] = [
  { name: 'a public handler, unauthenticated', handler: 'health', user: undefined, allowed: true },
  { name: 'no @Roles, a member', handler: 'noRoles', user: member(), allowed: true },
  { name: 'no @Roles, unauthenticated', handler: 'noRoles', user: undefined, allowed: false },
  {
    name: 'no @Roles nor @Access, a member (RBAC-HIGH-030 shape, unchanged here)',
    handler: 'unclassified',
    user: member(),
    allowed: true,
  },
  {
    name: 'TENANT_ADMIN required, a global MODULE_MANAGER',
    handler: 'adminOnly',
    user: member({ roles: ['MODULE_MANAGER'] }),
    allowed: false,
  },
  {
    name: 'TENANT_ADMIN required, a TENANT_ADMIN',
    handler: 'adminOnly',
    user: member({ roles: ['TENANT_ADMIN'] }),
    allowed: true,
  },
  {
    name: 'TENANT_ADMIN required, a SUPER_ADMIN',
    handler: 'adminOnly',
    user: member({ roles: ['SUPER_ADMIN'], tenantId: null }),
    allowed: true,
  },
  {
    name: 'MODULE_MANAGER required, a global MODULE_MANAGER (the global role decides)',
    handler: 'managerOrHigher',
    user: member({ roles: ['MODULE_MANAGER'] }),
    allowed: true,
  },
  {
    name: 'MODULE_MANAGER required, a MODULE_USER holding a farm manager grant',
    handler: 'managerOrHigher',
    user: member({ roles: ['MODULE_USER'], moduleAccess: { farm: 'MODULE_MANAGER' } }),
    allowed: false,
  },
  {
    name: 'MODULE_USER required, the deprecated single role TENANT_ADMIN',
    handler: 'moduleUserOrHigher',
    user: { sub: 'user-1', tenantId: 'tenant-1', role: 'TENANT_ADMIN' },
    allowed: true,
  },
  {
    name: 'TENANT_ADMIN required, a lower-case tenant_admin (case-normalised)',
    handler: 'adminOnly',
    user: member({ roles: ['tenant_admin'] }),
    allowed: true,
  },
  {
    name: 'MODULE_USER required, an unknown role',
    handler: 'moduleUserOrHigher',
    user: member({ roles: ['VIEWER'] }),
    allowed: false,
  },
  {
    name: 'MODULE_USER required, no roles at all',
    handler: 'moduleUserOrHigher',
    user: { sub: 'user-1', tenantId: 'tenant-1' },
    allowed: false,
  },
  {
    name: 'hr payrolls, a global MODULE_MANAGER who manages farm only (RBAC-HIGH-031, unchanged here)',
    handler: 'payrolls',
    user: member({ roles: ['MODULE_MANAGER'], moduleAccess: { farm: 'MODULE_MANAGER' } }),
    allowed: true,
  },
];
