/**
 * Tenant capabilities — the `account(capability)` vocabulary of ADR-051 §1 (RBAC-MEDIUM-024).
 *
 * WHY: the catalogue was a literal inside auth-service
 * (`apps/auth-service/src/modules/tenant/services/permission-catalogue.ts`), so no guard, web
 * page or `decideAccess` could name a capability the compiler knew; and the SUPER_ADMIN /
 * TENANT_ADMIN bypass was written twice, in backend-common's `hasAllResourcePermissions` and in
 * shared-ui's `hasResourcePermission`. Both now read this file.
 *
 * WHAT:
 *   - TENANT_CAPABILITY_CATALOGUE: every capability a tenant role or per-user override may hold,
 *     grouped for the role editor. The wire capability is `${resource}:${action}`; resource keys
 *     are unique across categories. auth-service builds its write-time whitelist, its plan
 *     entitlement and the role editor's `permissionCategories` from it. Moved unchanged: PKG-03
 *     (same release, R1) adds `company:view` and removes the keys no guard enforces.
 *   - TenantCapability / TENANT_CAPABILITIES / isTenantCapability: the flattened vocabulary.
 *   - COMPANY_VIEW_CAPABILITY: the Company read capability `decideAccess` checks (plan D1, D2).
 *   - holdsTenantCapabilities: the one capability check. An account role (TENANT_ADMIN,
 *     SUPER_ADMIN) holds every capability (ADR-051 §1); a member holds exactly its claim.
 *
 * Zero-dependency (see index.ts).
 */
import type { AccountRole } from './platform-roles';

interface CatalogueResource {
  readonly name: string;
  readonly actions: readonly string[];
}

interface CatalogueCategory {
  readonly name: string;
  readonly resources: { readonly [resource: string]: CatalogueResource };
}

const CATALOGUE = {
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
      batches: {
        name: 'Batches',
        actions: ['view', 'create', 'edit', 'delete', 'transfer', 'split', 'merge'],
      },
      species: { name: 'Species', actions: ['view', 'create', 'edit', 'delete'] },
      mortality: { name: 'Mortality Records', actions: ['view', 'record'] },
      growth: { name: 'Growth Measurements', actions: ['view', 'record', 'analyze'] },
      harvest: { name: 'Harvest', actions: ['view', 'plan', 'record'] },
    },
  },
  operations: {
    name: 'Operations',
    resources: {
      feeding: {
        name: 'Feeding',
        actions: ['view', 'record', 'manage_schedules', 'manage_inventory'],
      },
      sensors: { name: 'Sensors', actions: ['view', 'configure', 'calibrate', 'manage_alerts'] },
      maintenance: {
        name: 'Maintenance',
        actions: ['view', 'create_work_orders', 'complete', 'manage_schedules'],
      },
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
  // Module-scoped AI specialists (RBAC-MEDIUM-016). A specialist persona
  // (e.g. `expert-farm-production-v1`, see AI_PERSONA_CATALOGUE in this library)
  // needs the caller's tier capability above AND the specialty capability here;
  // auth-service gates the category on BOTH the AI module and the specialty's own
  // module (CATEGORY_MODULE_REQUIREMENTS), so a tenant lacking either never holds
  // it and the role editor hides the category. Resource key `ai_specialties` is
  // globally unique; the wire form is `ai_specialties:<module>`.
  ai_specialists: {
    name: 'AI Specialists',
    resources: {
      ai_specialties: { name: 'Specialist modules', actions: ['farm'] },
    },
  },
} as const satisfies { readonly [category: string]: CatalogueCategory };

type Catalogue = typeof CATALOGUE;

type CapabilitiesOf<Resources extends CatalogueCategory['resources']> = {
  [R in keyof Resources & string]: `${R}:${Resources[R]['actions'][number]}`;
}[keyof Resources & string];

/** Every `resource:action` the catalogue declares. */
export type TenantCapability = {
  [C in keyof Catalogue]: CapabilitiesOf<Catalogue[C]['resources']>;
}[keyof Catalogue];

export type TenantCapabilityCategoryKey = keyof Catalogue;

/**
 * The catalogue as consumers read it: every category and resource key exact, every action list a
 * plain `readonly string[]` so the lists of different resources iterate as one type.
 */
export type TenantCapabilityCatalogue = {
  readonly [C in keyof Catalogue]: {
    readonly name: string;
    readonly resources: { readonly [R in keyof Catalogue[C]['resources']]: CatalogueResource };
  };
};

function freezeCatalogue<T extends { readonly [category: string]: CatalogueCategory }>(
  catalogue: T,
): T {
  for (const category of Object.values(catalogue)) {
    for (const resource of Object.values(category.resources)) {
      Object.freeze(resource.actions);
      Object.freeze(resource);
    }
    Object.freeze(category.resources);
    Object.freeze(category);
  }
  return Object.freeze(catalogue);
}

/** The capability catalogue, frozen at every level. */
export const TENANT_CAPABILITY_CATALOGUE: TenantCapabilityCatalogue = freezeCatalogue(CATALOGUE);

const DECLARED: ReadonlySet<string> = new Set(
  Object.values(TENANT_CAPABILITY_CATALOGUE).flatMap((category) =>
    Object.entries(category.resources).flatMap(([resource, definition]) =>
      definition.actions.map((action) => `${resource}:${action}`),
    ),
  ),
);

/** True when the catalogue declares `value` as a `resource:action` capability. */
export function isTenantCapability(value: string): value is TenantCapability {
  return DECLARED.has(value);
}

/** Every catalogue capability, in catalogue order. */
export const TENANT_CAPABILITIES: readonly TenantCapability[] = Object.freeze(
  [...DECLARED].filter(isTenantCapability),
);

/**
 * Reads the Company layer (ADR-051 §1 `company`; plan D1, D2). There is no `company:manage`: a
 * Company write is always denied.
 */
export const COMPANY_VIEW_CAPABILITY = 'company:view';

/** What the capability check reads of a caller: its account role and its capability claim. */
export interface TenantCapabilityHolder {
  readonly accountRole: AccountRole | null;
  /** The `resourcePermissions` claim of the verified identity. */
  readonly capabilities: readonly string[];
}

/**
 * True when the holder holds every required capability. An account role holds every capability
 * (TENANT_ADMIN keeps full access, SUPER_ADMIN keeps the platform pass — ADR-051 §1); a member
 * holds exactly the capabilities of its claim, so no claim holds nothing (fail closed).
 */
export function holdsTenantCapabilities(
  holder: TenantCapabilityHolder,
  required: readonly string[],
): boolean {
  if (holder.accountRole !== null) return true;
  return required.every((capability) => holder.capabilities.includes(capability));
}
