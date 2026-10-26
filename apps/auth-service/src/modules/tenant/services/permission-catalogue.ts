/**
 * Tenant-RBAC permission catalogue — auth-service's reading of the one capability
 * catalogue, `TENANT_CAPABILITY_CATALOGUE` (`@aquaculture/shared-contracts`,
 * access/tenant-capabilities.ts).
 *
 * WHY the literal is not here: three auth consumers must agree on exactly one
 * catalogue or authorization drifts —
 *   1. the tenant-admin role editor (`permissionCategories` query, data-driven),
 *   2. token-mint resolution + `TenantPermissionGuard` enforcement,
 *   3. the write-time grant authority (`CapabilityAuthorityService`), which
 *      rejects any `resource:action` NOT in this catalogue —
 * and so must every other workspace that names a capability (guards, the web,
 * `decideAccess`), which could not import a literal private to this service
 * (RBAC-MEDIUM-024). This module keeps what is auth's own: the whitelist set, the
 * plan entitlement by module and the editor's filtered view. It lives below the
 * services (imports nothing from them) so both `TenantRoleService` and
 * `CapabilityAuthorityService` can depend on it with no import cycle.
 */
import { TENANT_CAPABILITIES, TENANT_CAPABILITY_CATALOGUE } from '@aquaculture/shared-contracts';

/**
 * Helper to convert panel permissions to a `resource:action` array.
 *
 * NOTE: the category key is intentionally NOT part of the wire permission — the
 * resource key is globally unique (see the messaging/ai note in the catalogue), so
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
export const CATALOGUE_CAPABILITIES: ReadonlySet<string> = new Set<string>(TENANT_CAPABILITIES);

/** True when `capability` is a `resource:action` string the catalogue declares. */
export function isKnownCapability(capability: string): boolean {
  return CATALOGUE_CAPABILITIES.has(capability);
}

// ============================================================================
// Plan-tier / module entitlement (RBAC-HIGH-010)
// ============================================================================

/**
 * Catalogue category → the licensable module code (`PLATFORM_MODULE`, the
 * module dictionary in shared-contracts) a tenant MUST have enabled to hold
 * any capability in that category. A category NOT listed here is CORE — always
 * entitled regardless of plan:
 *   - `farm` / `batch` / `operations` — the base aquaculture product;
 *   - `reports` / `admin` — platform surfaces every tenant has;
 *   - `messaging` — no licensable module code exists yet, so it stays core
 *     (a dedicated messaging module gate is separate future work).
 * Only the categories that map to OPTIONAL modules are gated:
 *   - `hr` → the HR module;
 *   - `ai` → the AI module (this is the audit's headline over-grant vector:
 *     a STARTER tenant granting itself `ai_settings:manage`);
 *   - `ai_specialists` → the AI module AND the specialty's module (all-of).
 * Keying by category (not individual capability) keeps this aligned with the
 * UI's category-grouped editor and avoids splitting a mixed category.
 */
export const CATEGORY_MODULE_REQUIREMENTS: Readonly<Record<string, readonly string[]>> = {
  hr: ['hr'],
  ai: ['ai'],
  // ALL-OF: a farm specialist persona is an AI feature over farm data, so the
  // tenant must hold both modules (RBAC-MEDIUM-016).
  ai_specialists: ['ai', 'farm'],
};

/**
 * capability (`resource:action`) → required module codes (all-of), precomputed
 * from CATEGORY_MODULE_REQUIREMENTS. Absent key ⇒ core capability (no module gate).
 */
const CAPABILITY_REQUIRED_MODULES: ReadonlyMap<string, readonly string[]> = (() => {
  const map = new Map<string, readonly string[]>();
  for (const [categoryKey, category] of Object.entries(TENANT_CAPABILITY_CATALOGUE)) {
    const requiredModules = CATEGORY_MODULE_REQUIREMENTS[categoryKey];
    if (!requiredModules || requiredModules.length === 0) continue;
    for (const [resource, definition] of Object.entries(category.resources)) {
      for (const action of definition.actions) {
        map.set(`${resource}:${action}`, requiredModules);
      }
    }
  }
  return map;
})();

/**
 * The module codes a capability requires (every one must be enabled), or
 * `undefined` if it is core (no gate).
 */
export function requiredModulesFor(capability: string): readonly string[] | undefined {
  return CAPABILITY_REQUIRED_MODULES.get(capability);
}

/**
 * The subset of `CATALOGUE_CAPABILITIES` a tenant with `enabledModuleCodes` is
 * entitled to hold: every core capability, plus module-gated capabilities whose
 * module is enabled. This is the SSoT both the write-time grant authority
 * (reject persisting a non-entitled capability) and the token mint (never stamp
 * a non-entitled capability into the JWT, so a stale grant from a plan
 * downgrade or the MT-HIGH-057 backfill has zero runtime effect) consume.
 */
export function entitledCapabilities(enabledModuleCodes: ReadonlySet<string>): ReadonlySet<string> {
  const result = new Set<string>();
  for (const capability of CATALOGUE_CAPABILITIES) {
    const requiredModules = CAPABILITY_REQUIRED_MODULES.get(capability);
    if (!requiredModules || requiredModules.every((module) => enabledModuleCodes.has(module))) {
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
  for (const [categoryKey, category] of Object.entries(TENANT_CAPABILITY_CATALOGUE)) {
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
