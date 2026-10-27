/**
 * The tenant roles every tenant is offered by default — the SSoT `seedDefaultRoles`
 * (tenant-role.service.ts) creates and tops up (RBAC-MEDIUM-015).
 *
 * Each panel is typed by the capability catalogue (`TenantCapabilityPanel`,
 * @aquaculture/shared-contracts): a default role cannot grant a key the catalogue does not
 * offer, which is what the PKG-03 removal of the keys no check read relies on (RBAC-HIGH-025).
 * The seed still intersects each panel with the tenant's entitled capabilities (RBAC-HIGH-010).
 *
 * Company Viewer is role B of ADR-051 §4: the Company layer and nothing module-private. A tenant
 * admin assigns it to a member who reads the Company tree (plan D1, D2); it carries no module
 * grant and no AI specialty, so it never reaches farm, sensor or HR data.
 */
import { colors, type TenantCapabilityPanel } from '@aquaculture/shared-contracts';

/** Nested role permission matrix: category → resource → action → granted. */
type PanelMatrix = Record<string, Record<string, Record<string, boolean>>>;

export interface DefaultTenantRole {
  readonly name: string;
  readonly description: string;
  readonly color: string;
  readonly icon: string;
  readonly level: number;
  readonly isSystem: boolean;
  readonly isDefault: boolean;
}

export const DEFAULT_TENANT_ROLES: readonly DefaultTenantRole[] = [
  {
    name: 'Supervisor',
    description: 'Can manage daily operations, view reports, and oversee staff',
    color: colors.accent[400],
    icon: 'user-check',
    level: 70,
    isSystem: true,
    isDefault: false,
  },
  {
    name: 'Technician',
    description: 'Can manage sensors, equipment, and maintenance tasks',
    color: colors.info[300],
    icon: 'wrench',
    level: 50,
    isSystem: true,
    isDefault: false,
  },
  {
    name: 'Feed Manager',
    description: 'Can manage feeding schedules, inventory, and records',
    color: colors.warning[400],
    icon: 'package',
    level: 50,
    isSystem: true,
    isDefault: false,
  },
  {
    name: 'Operator',
    description: 'Basic operational access for daily tasks',
    color: colors.success[400],
    icon: 'activity',
    level: 30,
    isSystem: true,
    isDefault: true,
  },
  {
    name: 'Viewer',
    description: 'Read-only access to dashboards and reports',
    color: colors.gray[400],
    icon: 'eye',
    level: 10,
    isSystem: true,
    isDefault: false,
  },
  {
    name: 'Company Viewer',
    description:
      'Read-only access to the Company layer: the sites, departments, headcount and finance totals of every module, and no module data',
    color: colors.secondary[500],
    icon: 'building',
    level: 10,
    isSystem: true,
    isDefault: false,
  },
];

/**
 * Default role permissions. Every operational role may chat with the AI assistant and drive the
 * farm specialists at the tiers its `ai_personas` grants allow (RBAC-MEDIUM-016); a tenant admin
 * narrows any of it per role in the role editor.
 */
export const DEFAULT_ROLE_PERMISSIONS: Readonly<Record<string, PanelMatrix>> = {
  Supervisor: {
    admin: {
      settings: { view: true },
      users: { view: true, invite: false, edit_permissions: false, deactivate: false },
      roles: { view: true, create: false, edit: false, delete: false },
    },
    messaging: {
      channels: { create_group: true },
    },
    ai: {
      ai_assistant: { use: true },
      ai_settings: { view: true, manage: true },
      ai_personas: { operator: true, manager: true, expert: true, supervisor: false },
    },
    ai_specialists: {
      ai_specialties: { farm: true },
    },
  },
  Technician: {
    messaging: {
      channels: { create_group: true },
    },
    ai: {
      ai_assistant: { use: true },
      ai_personas: { operator: true, manager: true, expert: false, supervisor: false },
    },
    ai_specialists: {
      ai_specialties: { farm: true },
    },
  },
  'Feed Manager': {
    messaging: {
      channels: { create_group: true },
    },
    ai: {
      ai_assistant: { use: true },
      ai_personas: { operator: true, manager: true, expert: false, supervisor: false },
    },
    ai_specialists: {
      ai_specialties: { farm: true },
    },
  },
  Operator: {
    messaging: {
      channels: { create_group: true },
    },
    ai: {
      ai_assistant: { use: true },
      ai_personas: { operator: true, manager: false, expert: false, supervisor: false },
    },
    ai_specialists: {
      ai_specialties: { farm: true },
    },
  },
  Viewer: {
    messaging: {
      // Most-restricted operational role: it cannot start groups. A tenant admin
      // can widen this per role in the role editor.
      channels: { create_group: false },
    },
    ai: {
      ai_assistant: { use: true },
      ai_personas: { operator: true, manager: false, expert: false, supervisor: false },
    },
    ai_specialists: {
      ai_specialties: { farm: true },
    },
  },
  'Company Viewer': {
    company: {
      company: { view: true },
    },
  },
} satisfies Record<string, TenantCapabilityPanel>;
