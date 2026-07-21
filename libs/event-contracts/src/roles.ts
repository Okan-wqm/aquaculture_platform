/**
 * @module roles
 * @description Cross-service SSoT for the platform's canonical role vocabulary.
 *
 * The platform consolidated on a 4-role model. This module is the single place
 * those codes are declared for every layer that is allowed to import
 * `@platform/event-contracts` (backend-common's `Role` enum, admin-api DTOs,
 * the NATS admin-command contracts). Web modules cannot import backend libs, so
 * the admin-panel pins a mirror literal in
 * `web/modules/admin-panel/src/services/types/users.ts`; both are held in lock-
 * step by `tests/invariants/rbac-vocabulary-ssot.spec.ts` (SSOT-H-06).
 *
 * A literal-union `const`, NOT a TypeScript enum, so the single-canonical-role-
 * enum rule (SSOT-H-06) still sees exactly one declaration in backend-common,
 * and no dependency cycle is introduced.
 *
 * @see libs/backend-common/src/decorators/roles.decorator.ts (the canonical `Role` enum, pinned to this list)
 * @see docs/reviews/claude/2026-07-20-admin-panel-e2e-audit/findings/users-roles.md#APA-050
 */

/** The four canonical platform role codes, in privilege order. */
export const PLATFORM_ROLE_CODES = [
  'SUPER_ADMIN',
  'TENANT_ADMIN',
  'MODULE_MANAGER',
  'MODULE_USER',
] as const;

/** Union of the canonical platform role codes. */
export type PlatformRoleCode = (typeof PLATFORM_ROLE_CODES)[number];

/**
 * Roles that may be assigned via the tenant-scoped invite flow. `SUPER_ADMIN`
 * is platform-level and is never invitable through a tenant admin surface.
 */
export const INVITABLE_ROLE_CODES = [
  'TENANT_ADMIN',
  'MODULE_MANAGER',
  'MODULE_USER',
] as const satisfies readonly PlatformRoleCode[];

/** Union of the invitable role codes. */
export type InvitableRoleCode = (typeof INVITABLE_ROLE_CODES)[number];
