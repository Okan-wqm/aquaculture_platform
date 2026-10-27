/**
 * The platform roles and their one hierarchy (RBAC-MEDIUM-024; ADR-051 §1).
 *
 * WHY: the hierarchy was written seven times — backend-common's `ROLE_HIERARCHY`, the web copy
 * "matching backend", auth's unused `ROLE_LEVELS`, the invite check's ranks, the user entity's and
 * the messaging resolver's privilege-ordered lists, aquamobil's `ROLE_RANK` — and the web declared
 * `UserRole` three times. Every surface now reads this file, and
 * `tests/invariants/role-hierarchy-single-owner.spec.ts` fails any copy.
 *
 * WHAT:
 *   - PLATFORM_ROLES_BY_PRIVILEGE is the hierarchy: each role holds every role after it. The
 *     inheritance map and `platformRoleSatisfies` derive from the order, so the hierarchy cannot
 *     hold a cycle or a gap. backend-common's `Role` enum spells exactly these roles (its
 *     compile-time parity sits beside it) and `roleHasPermission` delegates here.
 *   - PLATFORM_ROLE_KIND splits them by ADR-051 §1: SUPER_ADMIN and TENANT_ADMIN are ACCOUNT roles
 *     (`users.role`, satisfied only by the caller's account role); MODULE_MANAGER and MODULE_USER
 *     are MODULE roles (values of the `moduleAccess` claim, satisfied only by the caller's role in
 *     the spec's module). `decideAccess` applies the hierarchy within a kind only; services not
 *     yet enrolled (`account-role`, ADR-051 §3) keep today's check across kinds.
 *
 * Zero-dependency and no `enum` (shared-contracts-no-enum-drift.spec.ts).
 */

export const PLATFORM_ROLES_BY_PRIVILEGE = Object.freeze([
  'SUPER_ADMIN',
  'TENANT_ADMIN',
  'MODULE_MANAGER',
  'MODULE_USER',
] as const);

export type PlatformRole = (typeof PLATFORM_ROLES_BY_PRIVILEGE)[number];

/** The platform roles by name, for `PLATFORM_ROLE.TENANT_ADMIN` call sites. */
export const PLATFORM_ROLE = Object.freeze({
  SUPER_ADMIN: 'SUPER_ADMIN',
  TENANT_ADMIN: 'TENANT_ADMIN',
  MODULE_MANAGER: 'MODULE_MANAGER',
  MODULE_USER: 'MODULE_USER',
} as const satisfies { readonly [R in PlatformRole]: R });

export type PlatformRoleKind = 'account' | 'module';

/** One kind per role, keyed by the role: a missing or extra role does not compile. */
export const PLATFORM_ROLE_KIND = Object.freeze({
  SUPER_ADMIN: 'account',
  TENANT_ADMIN: 'account',
  MODULE_MANAGER: 'module',
  MODULE_USER: 'module',
} as const satisfies { readonly [R in PlatformRole]: PlatformRoleKind });

type RoleKinds = typeof PLATFORM_ROLE_KIND;

/** The roles `users.role` carries power as: SUPER_ADMIN, TENANT_ADMIN. */
export type AccountRole = {
  [R in PlatformRole]: RoleKinds[R] extends 'account' ? R : never;
}[PlatformRole];

/** The roles a `moduleAccess` grant holds: MODULE_MANAGER, MODULE_USER. */
export type ModuleRole = {
  [R in PlatformRole]: RoleKinds[R] extends 'module' ? R : never;
}[PlatformRole];

export function isPlatformRole(value: unknown): value is PlatformRole {
  return PLATFORM_ROLES_BY_PRIVILEGE.some((role) => role === value);
}

export function isAccountRole(value: unknown): value is AccountRole {
  return isPlatformRole(value) && PLATFORM_ROLE_KIND[value] === 'account';
}

export function isModuleRole(value: unknown): value is ModuleRole {
  return isPlatformRole(value) && PLATFORM_ROLE_KIND[value] === 'module';
}

export const ACCOUNT_ROLES: readonly AccountRole[] = Object.freeze(
  PLATFORM_ROLES_BY_PRIVILEGE.filter(isAccountRole),
);

export const MODULE_ROLES: readonly ModuleRole[] = Object.freeze(
  PLATFORM_ROLES_BY_PRIVILEGE.filter(isModuleRole),
);

/**
 * True when `held` is `required` or above it in the one hierarchy. Roles reach this from token
 * claims, so a string that is no platform role satisfies nothing and is satisfied by nothing
 * (fail closed), whatever its static type said.
 */
export function platformRoleSatisfies(held: PlatformRole, required: PlatformRole): boolean {
  const heldRank = PLATFORM_ROLES_BY_PRIVILEGE.indexOf(held);
  const requiredRank = PLATFORM_ROLES_BY_PRIVILEGE.indexOf(required);
  return heldRank !== -1 && requiredRank !== -1 && heldRank <= requiredRank;
}

/** Each role and the roles it inherits, derived from the order. */
export const PLATFORM_ROLE_HIERARCHY: { readonly [R in PlatformRole]: readonly PlatformRole[] } =
  Object.freeze({
    SUPER_ADMIN: inheritedBy('SUPER_ADMIN'),
    TENANT_ADMIN: inheritedBy('TENANT_ADMIN'),
    MODULE_MANAGER: inheritedBy('MODULE_MANAGER'),
    MODULE_USER: inheritedBy('MODULE_USER'),
  });

function inheritedBy(role: PlatformRole): readonly PlatformRole[] {
  return Object.freeze(
    PLATFORM_ROLES_BY_PRIVILEGE.filter(
      (other) => other !== role && platformRoleSatisfies(role, other),
    ),
  );
}

/**
 * The most privileged platform role among the role strings a verified identity carries
 * (`users.role` and `roles[]`), or null when none is one. Roles reach this from token claims, so
 * it takes them as `unknown`: anything but an array holds nothing, and each element must equal a
 * role exactly. A role in another case, an unknown name, or a string that merely contains a role
 * name (`'NOT_A_SUPER_ADMIN_ROLE'`, which `String.prototype.includes` would match) holds nothing
 * (fail closed).
 */
export function highestPlatformRole(roles: unknown): PlatformRole | null {
  if (!Array.isArray(roles)) return null;
  const held: readonly unknown[] = roles;
  return PLATFORM_ROLES_BY_PRIVILEGE.find((role) => held.some((entry) => entry === role)) ?? null;
}

/**
 * The account role among the roles a verified identity carries, or null for a member: the
 * legacy global MODULE_MANAGER and MODULE_USER carry no account power (ADR-051 §1).
 */
export function accountRoleOf(roles: unknown): AccountRole | null {
  const highest = highestPlatformRole(roles);
  return isAccountRole(highest) ? highest : null;
}
