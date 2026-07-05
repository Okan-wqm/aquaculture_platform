/**
 * @aquaculture/backend-common/rbac — effective-capability resolution
 *
 * Faz 7. Computes a user's EFFECTIVE capability set from two inputs:
 *   1. platform-role base defaults (the fixed floor every role has), and
 *   2. the tenant's own custom grants (the tenant-admin-configured additions —
 *      stored per tenant and resolved for the user's tenant roles; Faz 7b).
 *
 * This runs at token-mint (auth-service) to populate the `resourcePermissions`
 * claim the existing TenantPermissionGuard already enforces, and backs the FE
 * `me.permissions` query. Pure and side-effect-free so it is trivially testable
 * and identical on server and (mirrored) client.
 */
import { Role } from '../decorators/roles.decorator';
import { ALL_CAPABILITIES, Capability, knownCapabilities } from './capabilities';

/**
 * Platform-role base capabilities — the floor a role always has, before any
 * tenant customization. A tenant admin GRANTS more on top; they never need to
 * re-grant these. SUPER_ADMIN / TENANT_ADMIN get the whole catalogue (they are
 * also bypassed outright by TenantPermissionGuard; this keeps `me.permissions`
 * truthful for their UIs).
 *
 * The member floor is deliberately WhatsApp-like: a plain member can chat, DM,
 * create a group, and use the operator-tier AI. Anything more sensitive
 * (config, higher personas, RBAC admin) is opt-in per tenant.
 */
export const DEFAULT_ROLE_CAPABILITIES: Record<Role, readonly Capability[]> = {
  [Role.SUPER_ADMIN]: ALL_CAPABILITIES,
  [Role.TENANT_ADMIN]: ALL_CAPABILITIES,
  [Role.MODULE_MANAGER]: [
    'messaging-group:create',
    'messaging-dm:create',
    'messaging-message:send',
    'messaging-channel:manage',
    'ai-chat:use',
    'ai-persona-operator:use',
    'ai-persona-manager:use',
    'ai-persona-expert:use',
  ],
  [Role.MODULE_USER]: [
    'messaging-group:create',
    'messaging-dm:create',
    'messaging-message:send',
    'ai-chat:use',
    'ai-persona-operator:use',
  ],
};

/** The highest role in a set (for choosing the base floor). Fail-closed to MODULE_USER. */
function highestRole(roles: readonly string[]): Role {
  const order: Role[] = [
    Role.SUPER_ADMIN,
    Role.TENANT_ADMIN,
    Role.MODULE_MANAGER,
    Role.MODULE_USER,
  ];
  for (const role of order) {
    if (roles.includes(role)) {
      return role;
    }
  }
  return Role.MODULE_USER;
}

export interface EffectiveCapabilityInput {
  /** The user's platform roles (from the JWT/verified assertion). */
  roles: readonly string[];
  /**
   * The tenant's custom grants resolved for this user (union of the capabilities
   * attached to the user's tenant roles). Unknown strings are dropped. Optional
   * until the tenant RBAC store lands (Faz 7b) — with none, a user gets exactly
   * their role floor.
   */
  tenantGrants?: readonly string[];
}

/**
 * Resolve the user's effective capabilities = role floor ∪ tenant custom grants.
 * Deduplicated, catalogue-validated (drift-safe), stable order.
 */
export function resolveEffectiveCapabilities(
  input: EffectiveCapabilityInput,
): Capability[] {
  const floor = DEFAULT_ROLE_CAPABILITIES[highestRole(input.roles)];
  const grants = knownCapabilities(input.tenantGrants ?? []);
  const merged = new Set<Capability>([...floor, ...grants]);
  // Return in catalogue order for a stable, diff-friendly claim/response.
  return ALL_CAPABILITIES.filter((cap) => merged.has(cap));
}

/**
 * Does a resolved capability set satisfy a required capability? Thin membership
 * check — the enforcement SSoT is TenantPermissionGuard (over the claim); this
 * is for programmatic checks and FE mirroring.
 */
export function hasCapability(
  effective: readonly string[],
  required: Capability,
): boolean {
  return effective.includes(required);
}
