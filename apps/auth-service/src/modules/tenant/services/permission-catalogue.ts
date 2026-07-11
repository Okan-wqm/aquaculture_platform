/**
 * Tenant-RBAC permission catalogue — the single source of truth for every
 * capability a tenant role or per-user override may reference.
 *
 * WHY this is its own module: three consumers must agree on exactly one
 * catalogue or authorization drifts —
 *   1. the tenant-admin role editor (`permissionCategories` query, data-driven),
 *   2. token-mint resolution + `TenantPermissionGuard` enforcement,
 *   3. the write-time grant authority (`CapabilityAuthorityService`), which
 *      rejects any `resource:action` NOT in this catalogue.
 * It lives below the services (imports nothing from them) so both
 * `TenantRoleService` and `CapabilityAuthorityService` can depend on it with no
 * import cycle. `TenantRoleService` re-exports `PERMISSION_CATEGORIES` so the
 * resolver + catalogue spec keep their existing import path.
 */

/**
 * Permission Categories for UI + the storable-capability whitelist.
 */
export const PERMISSION_CATEGORIES = {
  farm: {
    name: 'Farm Management',
    resources: {
      sites: { name: 'Sites', actions: ['view', 'create', 'edit', 'delete'] },
      departments: { name: 'Departments', actions: ['view', 'create', 'edit', 'delete'] },
      systems: { name: 'Systems', actions: ['view', 'create', 'edit', 'delete'] },
      tanks: { name: 'Tanks', actions: ['view', 'create', 'edit', 'delete', 'assign'] },
      ponds: { name: 'Ponds', actions: ['view', 'create', 'edit', 'delete'] },
      equipment: { name: 'Equipment', actions: ['view', 'create', 'edit', 'delete', 'assign'] },
    },
  },
  batch: {
    name: 'Batch & Production',
    resources: {
      batches: { name: 'Batches', actions: ['view', 'create', 'edit', 'delete', 'transfer', 'split', 'merge'] },
      species: { name: 'Species', actions: ['view', 'create', 'edit', 'delete'] },
      mortality: { name: 'Mortality Records', actions: ['view', 'record'] },
      growth: { name: 'Growth Measurements', actions: ['view', 'record', 'analyze'] },
      harvest: { name: 'Harvest', actions: ['view', 'plan', 'record'] },
    },
  },
  operations: {
    name: 'Operations',
    resources: {
      feeding: { name: 'Feeding', actions: ['view', 'record', 'manage_schedules', 'manage_inventory'] },
      sensors: { name: 'Sensors', actions: ['view', 'configure', 'calibrate', 'manage_alerts'] },
      maintenance: { name: 'Maintenance', actions: ['view', 'create_work_orders', 'complete', 'manage_schedules'] },
      water_quality: { name: 'Water Quality', actions: ['view', 'record'] },
    },
  },
  hr: {
    name: 'HR & Administration',
    resources: {
      employees: { name: 'Employees', actions: ['view', 'create', 'edit', 'delete'] },
      attendance: { name: 'Attendance', actions: ['view', 'manage'] },
      leave: { name: 'Leave Management', actions: ['view', 'approve'] },
      shifts: { name: 'Shifts', actions: ['view', 'create', 'edit', 'delete'] },
    },
  },
  reports: {
    name: 'Reports & Analytics',
    resources: {
      dashboard: { name: 'Dashboard', actions: ['view', 'analytics'] },
      reports: { name: 'Reports', actions: ['view', 'export', 'create_custom'] },
    },
  },
  admin: {
    name: 'Settings & User Management',
    resources: {
      settings: { name: 'Settings', actions: ['view', 'edit'] },
      users: { name: 'Users', actions: ['view', 'invite', 'edit_permissions', 'deactivate'] },
      roles: { name: 'Roles', actions: ['view', 'create', 'edit', 'delete'] },
    },
  },
  // Messaging + AI capabilities (Faz 7). Resource keys are globally unique
  // (the wire permission is `${resourceKey}:${action}`, so keys must not collide
  // with any above — e.g. AI settings is `ai_settings`, not `settings`). Adding
  // them here is the SSoT change: the tenant-admin role editor (permissionCategories
  // query, data-driven), token-mint resolution, and TenantPermissionGuard all
  // pick them up automatically — no parallel catalogue.
  messaging: {
    name: 'Messaging',
    resources: {
      channels: {
        name: 'Channels',
        // create_group is the WhatsApp-like group-creation capability
        // (MSG-MEDIUM-070); create_dm the 1:1; manage covers rename/members.
        actions: ['view', 'create_group', 'create_dm', 'manage'],
      },
      messages: { name: 'Messages', actions: ['send'] },
    },
  },
  ai: {
    name: 'AI Assistant',
    resources: {
      ai_assistant: { name: 'AI Chat', actions: ['use'] },
      // AI settings = the tenant BYOK keys / provider / model (Faz 1).
      ai_settings: { name: 'AI Settings', actions: ['view', 'manage'] },
      // Persona tiers — which AI persona a member may drive (AISAFETY-MEDIUM-013).
      ai_personas: {
        name: 'AI Personas',
        actions: ['operator', 'manager', 'expert', 'supervisor'],
      },
    },
  },
};

/**
 * Helper to convert panel permissions to a `resource:action` array.
 *
 * NOTE: the category key is intentionally NOT part of the wire permission — the
 * resource key is globally unique (see the messaging/ai note above), so
 * `${resource}:${action}` is the enforced capability string. A fabricated
 * category wrapper therefore cannot mint a new capability; the derived strings
 * are still validated against CATALOGUE_CAPABILITIES at every write site.
 */
export function panelPermissionsToResourceArray(
  panel: Record<string, Record<string, Record<string, boolean>>>,
): string[] {
  const result: string[] = [];
  for (const resources of Object.values(panel)) {
    for (const [resource, actions] of Object.entries(resources)) {
      for (const [action, enabled] of Object.entries(actions)) {
        if (enabled) {
          result.push(`${resource}:${action}`);
        }
      }
    }
  }
  return result;
}

/**
 * The flattened set of every valid `resource:action` capability the catalogue
 * declares. This is the write-time whitelist: a capability not in this set can
 * never be persisted to `tenant_role_permissions.resource_permissions` or a
 * `permission_overrides.grants/revokes` array, closing the "arbitrary
 * capability-string injection via GraphQL" hole. Because the whitelist is
 * finite, it also structurally bounds how many distinct capabilities any role
 * or override can store (a natural cap on JWT/assertion-header size).
 */
export const CATALOGUE_CAPABILITIES: ReadonlySet<string> = (() => {
  const capabilities = new Set<string>();
  for (const category of Object.values(PERMISSION_CATEGORIES)) {
    for (const [resource, definition] of Object.entries(category.resources)) {
      for (const action of definition.actions) {
        capabilities.add(`${resource}:${action}`);
      }
    }
  }
  return capabilities;
})();

/** True when `capability` is a `resource:action` string the catalogue declares. */
export function isKnownCapability(capability: string): boolean {
  return CATALOGUE_CAPABILITIES.has(capability);
}
