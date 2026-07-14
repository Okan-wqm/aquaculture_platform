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
      // HR finance salary visibility (HR-MEDIUM-005). Headcount/expenses on the HR
      // finance tab stay MANAGER-visible; the salary/labour-cost/payroll-analytics
      // figures are gated by `hr_finance:view_salary`, which a TENANT_ADMIN grants
      // per role — so the tenant decides who sees pay, not a hardcoded role.
      hr_finance: { name: 'HR Finance', actions: ['view_salary'] },
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

// ============================================================================
// Plan-tier / module entitlement (RBAC-HIGH-010)
// ============================================================================

/**
 * Catalogue category → the licensable module code (see `ModuleCode` in
 * system-module/entities/module.entity.ts) a tenant MUST have enabled to hold
 * any capability in that category. A category NOT listed here is CORE — always
 * entitled regardless of plan:
 *   - `farm` / `batch` / `operations` — the base aquaculture product;
 *   - `reports` / `admin` — platform surfaces every tenant has;
 *   - `messaging` — no licensable `ModuleCode` exists yet, so it stays core
 *     (a dedicated messaging module gate is separate future work).
 * Only the two categories that map 1:1 to an OPTIONAL module are gated:
 *   - `hr` → the HR module;
 *   - `ai` → the AI module (this is the audit's headline over-grant vector:
 *     a STARTER tenant granting itself `ai_settings:manage`).
 * Keying by category (not individual capability) keeps this aligned with the
 * UI's category-grouped editor and avoids splitting a mixed category.
 */
export const CATEGORY_MODULE_REQUIREMENTS: Readonly<Record<string, string>> = {
  hr: 'hr',
  ai: 'ai',
};

/**
 * capability (`resource:action`) → required module code, precomputed from
 * CATEGORY_MODULE_REQUIREMENTS. Absent key ⇒ core capability (no module gate).
 */
const CAPABILITY_REQUIRED_MODULE: ReadonlyMap<string, string> = (() => {
  const map = new Map<string, string>();
  for (const [categoryKey, category] of Object.entries(PERMISSION_CATEGORIES)) {
    const requiredModule = CATEGORY_MODULE_REQUIREMENTS[categoryKey];
    if (!requiredModule) continue;
    for (const [resource, definition] of Object.entries(category.resources)) {
      for (const action of definition.actions) {
        map.set(`${resource}:${action}`, requiredModule);
      }
    }
  }
  return map;
})();

/**
 * The module code a capability requires, or `undefined` if it is core (no gate).
 */
export function requiredModuleFor(capability: string): string | undefined {
  return CAPABILITY_REQUIRED_MODULE.get(capability);
}

/**
 * The subset of `CATALOGUE_CAPABILITIES` a tenant with `enabledModuleCodes` is
 * entitled to hold: every core capability, plus module-gated capabilities whose
 * module is enabled. This is the SSoT both the write-time grant authority
 * (reject persisting a non-entitled capability) and the token mint (never stamp
 * a non-entitled capability into the JWT, so a stale grant from a plan
 * downgrade or the MT-HIGH-057 backfill has zero runtime effect) consume.
 */
export function entitledCapabilities(
  enabledModuleCodes: ReadonlySet<string>,
): ReadonlySet<string> {
  const result = new Set<string>();
  for (const capability of CATALOGUE_CAPABILITIES) {
    const requiredModule = CAPABILITY_REQUIRED_MODULE.get(capability);
    if (!requiredModule || enabledModuleCodes.has(requiredModule)) {
      result.add(capability);
    }
  }
  return result;
}

/** The catalogue shape after entitlement filtering (same nesting, subset content). */
export interface CatalogueResourceView {
  name: string;
  actions: string[];
}
export interface CatalogueCategoryView {
  name: string;
  resources: Record<string, CatalogueResourceView>;
}

/**
 * The catalogue restricted to a tenant's entitled capabilities — the THIRD
 * enforcement point on the RBAC-HIGH-010 entitlement SSoT (after the write
 * boundary and the token-mint intersection): the role editor's
 * `permissionCategories` query serves this, so the UI never OFFERS a capability
 * the write path would reject (e.g. the AI category for a tenant without the AI
 * module). Actions are filtered per capability; a resource with zero remaining
 * actions is dropped, and a category with zero remaining resources is dropped —
 * so an unlicensed module's category disappears wholesale rather than rendering
 * as an empty group.
 */
export function entitledPermissionCategories(
  entitled: ReadonlySet<string>,
): Record<string, CatalogueCategoryView> {
  const result: Record<string, CatalogueCategoryView> = {};
  for (const [categoryKey, category] of Object.entries(PERMISSION_CATEGORIES)) {
    const resources: Record<string, CatalogueResourceView> = {};
    for (const [resourceKey, definition] of Object.entries(category.resources)) {
      const actions = definition.actions.filter((action) =>
        entitled.has(`${resourceKey}:${action}`),
      );
      if (actions.length > 0) {
        resources[resourceKey] = { name: definition.name, actions };
      }
    }
    if (Object.keys(resources).length > 0) {
      result[categoryKey] = { name: category.name, resources };
    }
  }
  return result;
}

/**
 * SSoT query for a tenant's ENABLED module codes (joins the per-tenant
 * `auth.tenant_modules` rows to the `auth.modules` catalogue). `$1` = tenantId.
 */
export const ENABLED_MODULE_CODES_SQL = `
  SELECT m.code AS code
  FROM "auth"."tenant_modules" tm
  JOIN "auth"."modules" m ON tm."moduleId" = m.id
  WHERE tm."tenantId" = $1 AND tm."isEnabled" = true
`;

/**
 * Resolve a tenant's entitled capability set through a caller-supplied query
 * function (each service passes its own DataSource.query, so this helper adds
 * no DB dependency to the catalogue). Fail-safe: a tenant with zero module rows
 * yields only the CORE capabilities — module-gated grants are denied, never
 * silently allowed.
 */
export async function resolveEntitledCapabilities(
  query: (sql: string, params: readonly unknown[]) => Promise<unknown>,
  tenantId: string,
): Promise<ReadonlySet<string>> {
  const rows = await query(ENABLED_MODULE_CODES_SQL, [tenantId]);
  const codes = new Set<string>(
    (Array.isArray(rows) ? rows : [])
      .map((row) => (row as { code?: unknown }).code)
      .filter((code): code is string => typeof code === 'string'),
  );
  return entitledCapabilities(codes);
}
