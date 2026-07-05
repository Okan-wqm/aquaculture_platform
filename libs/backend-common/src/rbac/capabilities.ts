/**
 * @aquaculture/backend-common/rbac — Capability catalogue (SSoT)
 *
 * Faz 7 (tenant-configurable RBAC). This file is the single source of truth for
 * every named capability a tenant admin can grant. It sits UNDER the existing
 * permission primitive (`@RequireTenantPermission('resource:action')` +
 * `TenantPermissionGuard`, which enforces the user's `resourcePermissions`
 * claim) — this catalogue defines WHICH strings are valid and groups them so the
 * tenant-admin RBAC UI, the token-mint resolution, and the FE all reference one
 * list instead of hard-coding magic strings.
 *
 * Format: `resource:action` (matches the existing decorator convention).
 * Adding a capability = add it here (and, for a breaking change, an ADR). The
 * existing decorator/guard need no change — they treat capabilities as opaque
 * strings; this file just makes the set known, typed, and validatable.
 */

/**
 * The capability catalogue, grouped by domain. Values are the wire strings
 * stored in `resourcePermissions` and referenced by `@RequireTenantPermission`.
 */
export const CAPABILITIES = {
  // ── Messaging (WhatsApp-like) ────────────────────────────────────────────
  messagingGroupCreate: 'messaging-group:create',
  messagingDmCreate: 'messaging-dm:create',
  messagingMessageSend: 'messaging-message:send',
  messagingChannelManage: 'messaging-channel:manage',

  // ── AI assistant + BYOK ──────────────────────────────────────────────────
  aiChatUse: 'ai-chat:use',
  aiConfigManage: 'ai-config:manage',
  // Persona tiers — gate which AI persona a member may drive (the tier ladder
  // AgentProfileService enforces via the role ceiling migrates onto these).
  aiPersonaOperator: 'ai-persona-operator:use',
  aiPersonaManager: 'ai-persona-manager:use',
  aiPersonaExpert: 'ai-persona-expert:use',
  aiPersonaSupervisor: 'ai-persona-supervisor:use',

  // ── RBAC administration (the tenant admin's own control surface) ──────────
  rbacRoleManage: 'rbac-role:manage',
} as const;

/** A valid capability string from the catalogue. */
export type Capability = (typeof CAPABILITIES)[keyof typeof CAPABILITIES];

/** All capability strings, frozen. The SSoT list every other layer iterates. */
export const ALL_CAPABILITIES: readonly Capability[] = Object.freeze(
  Object.values(CAPABILITIES),
);

const CAPABILITY_SET: ReadonlySet<string> = new Set<string>(ALL_CAPABILITIES);

/** Type guard: is `value` a capability defined in the catalogue? */
export function isCapability(value: string): value is Capability {
  return CAPABILITY_SET.has(value);
}

/**
 * Filter an arbitrary string list down to the capabilities the catalogue knows.
 * Used when ingesting a tenant's stored grants — an unknown/renamed capability
 * is dropped rather than silently trusted (fail-closed against config drift).
 */
export function knownCapabilities(values: readonly string[]): Capability[] {
  return values.filter(isCapability);
}
