/**
 * Tenant capabilities — the `account(capability)` vocabulary of ADR-051 §1 (RBAC-MEDIUM-024).
 *
 * WHY: the catalogue was a literal inside auth-service
 * (`apps/auth-service/src/modules/tenant/services/permission-catalogue.ts`), so no guard, web
 * page or `decideAccess` could name a capability the compiler knew; and the SUPER_ADMIN /
 * TENANT_ADMIN bypass was written twice, in backend-common's `hasAllResourcePermissions` and in
 * shared-ui's `hasResourcePermission`. Both now read this file.
 *
 * WHAT it offers (PKG-03, RBAC-HIGH-025, RBAC-MEDIUM-026): only capabilities a check reads.
 * It offered 100 keys and backend checks read 18 of them, so a tenant admin who withheld
 * `batches:create` or `employees:view` from a role restricted nothing; meanwhile sensor-service
 * enforced `edge:manage-io-config`, a key absent here that the grant authority therefore refused.
 * Now it holds the 18 read keys, `edge_devices:manage_io_config` (the key sensor-service
 * enforces), `company:view` (read by `decideAccess`'s `company` kind ahead of the Company
 * projections, PKG-33) and `settings:view`, which only the web tenant-panel gate reads and which
 * leaves with the PKG-03 web part (release R2). tests/invariants/tenant-capability-usage.spec.ts
 * fails when a key has no reader or a check reads a key not offered here.
 *
 * WHAT it exports:
 *   - TENANT_CAPABILITY_CATALOGUE: every capability a tenant role or per-user override may hold,
 *     grouped for the role editor. The wire capability is `${resource}:${action}`; resource keys
 *     are unique across categories. auth-service builds its write-time whitelist, its plan
 *     entitlement and the role editor's `permissionCategories` from it. The AI persona tiers and
 *     specialty modules come from the AI catalogue (ai/persona-catalogue.ts): the specialty list
 *     is a runtime derivation, so the type admits `ai_specialties:` of every active owner module
 *     while the catalogue offers those a published specialty requires.
 *   - TenantCapability / TENANT_CAPABILITIES / isTenantCapability: the flattened vocabulary.
 *   - TenantCapabilityPanel: a role's panel (category → resource → action) typed by the catalogue.
 *   - COMPANY_VIEW_CAPABILITY, EDGE_DEVICE_IO_CONFIG_CAPABILITY: the capabilities their readers
 *     import (plan D1, D2; RBAC-MEDIUM-026).
 *   - holdsTenantCapabilities: the one capability check. An account role (TENANT_ADMIN,
 *     SUPER_ADMIN) holds every capability (ADR-051 §1); a member holds exactly its claim.
 *
 * Zero-dependency (see index.ts).
 */
import { AI_SPECIALTY_MODULE_CODES } from '../ai/persona-catalogue';
import { AI_PERSONA_TIERS } from '../ai/persona-id';

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
  // The Company layer (plan D1, D2; ADR-051 §1): read-only, there is no company:manage.
  company: {
    name: 'Company',
    resources: {
      company: { name: 'Company layer', actions: ['view'] },
    },
  },
  admin: {
    name: 'Settings & User Management',
    resources: {
      // Read by the web tenant-panel gate only; leaves with the PKG-03 web part (release R2).
      settings: { name: 'Settings', actions: ['view'] },
      users: { name: 'Users', actions: ['view', 'invite', 'edit_permissions', 'deactivate'] },
      roles: { name: 'Roles', actions: ['view', 'create', 'edit', 'delete'] },
    },
  },
  hr: {
    name: 'HR',
    resources: {
      // HR finance salary visibility (HR-MEDIUM-005). Headcount/expenses on the HR
      // finance tab stay MANAGER-visible; the salary/labour-cost/payroll-analytics
      // figures are gated by `hr_finance:view_salary`, which a TENANT_ADMIN grants
      // per role — so the tenant decides who sees pay, not a hardcoded role.
      hr_finance: { name: 'HR Finance', actions: ['view_salary'] },
    },
  },
  sensor: {
    name: 'Sensors',
    resources: {
      // Configure an edge device's I/O map and drive its digital outputs (RBAC-MEDIUM-026).
      edge_devices: { name: 'Edge Devices', actions: ['manage_io_config'] },
    },
  },
  // Messaging + AI capabilities (Faz 7). Resource keys are globally unique
  // (the wire permission is `${resourceKey}:${action}`, so keys must not collide
  // with any above — e.g. AI settings is `ai_settings`, not `settings`).
  messaging: {
    name: 'Messaging',
    resources: {
      // The WhatsApp-like group-creation capability (MSG-MEDIUM-070).
      channels: { name: 'Channels', actions: ['create_group'] },
    },
  },
  ai: {
    name: 'AI Assistant',
    resources: {
      ai_assistant: { name: 'AI Chat', actions: ['use'] },
      // AI settings = the tenant BYOK keys / provider / model (Faz 1).
      ai_settings: { name: 'AI Settings', actions: ['view', 'manage'] },
      // Persona tiers — which AI persona a member may drive (AISAFETY-MEDIUM-013).
      ai_personas: { name: 'AI Personas', actions: AI_PERSONA_TIERS },
    },
  },
  // Module-scoped AI specialists (RBAC-MEDIUM-016). A specialist persona
  // (e.g. `expert-farm-production-v1`, see AI_PERSONA_CATALOGUE in this library)
  // needs the caller's tier capability above AND the specialty capability here;
  // auth-service gates each one on BOTH the AI module and the specialty's own
  // module, so a tenant lacking either never holds it and the role editor hides
  // it. Resource key `ai_specialties` is globally unique; the wire form is
  // `ai_specialties:<module>`.
  ai_specialists: {
    name: 'AI Specialists',
    resources: {
      ai_specialties: { name: 'Specialist modules', actions: AI_SPECIALTY_MODULE_CODES },
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

type PanelOf<Resources extends CatalogueCategory['resources']> = {
  readonly [R in keyof Resources & string]?: {
    readonly [A in Resources[R]['actions'][number]]?: boolean;
  };
};

/**
 * A role's panel over the catalogue — category → resource → action → granted — as the role
 * editor stores it. A key the catalogue does not declare is not part of the type.
 */
export type TenantCapabilityPanel = {
  readonly [C in keyof Catalogue]?: PanelOf<Catalogue[C]['resources']>;
};

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
export const COMPANY_VIEW_CAPABILITY = 'company:view' satisfies TenantCapability;

/**
 * Configures an edge device's I/O map and drives its digital outputs: the capability
 * sensor-service's I/O mutations require (RBAC-MEDIUM-026).
 */
export const EDGE_DEVICE_IO_CONFIG_CAPABILITY =
  'edge_devices:manage_io_config' satisfies TenantCapability;

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
