/**
 * Browser-safe tenant capability authority. The nested shape drives role
 * editors while the derived union and flattened tuple govern decorators,
 * persistence validation, JWT claims, and generated route authorization.
 */
function deepFreeze<T>(value: T): T {
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null) return value;
  for (const key of Reflect.ownKeys(value)) {
    deepFreeze(Reflect.get(value, key));
  }
  return Object.freeze(value);
}

export const TENANT_PERMISSION_CATEGORIES = deepFreeze({
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
      edge: { name: 'Edge I/O Configuration', actions: ['manage-io-config'] },
    },
  },
  hr: {
    name: 'HR & Administration',
    resources: {
      employees: { name: 'Employees', actions: ['view', 'create', 'edit', 'delete'] },
      attendance: { name: 'Attendance', actions: ['view', 'manage'] },
      leave: { name: 'Leave Management', actions: ['view', 'approve'] },
      shifts: { name: 'Shifts', actions: ['view', 'create', 'edit', 'delete'] },
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
  messaging: {
    name: 'Messaging',
    resources: {
      channels: { name: 'Channels', actions: ['view', 'create_group', 'create_dm', 'manage'] },
      messages: { name: 'Messages', actions: ['send'] },
    },
  },
  ai: {
    name: 'AI Assistant',
    resources: {
      ai_assistant: { name: 'AI Chat', actions: ['use'] },
      ai_settings: { name: 'AI Settings', actions: ['view', 'manage'] },
      ai_personas: {
        name: 'AI Personas',
        actions: ['operator', 'manager', 'expert', 'supervisor'],
      },
    },
  },
} as const);

type PermissionCategories = typeof TENANT_PERMISSION_CATEGORIES;
type PermissionResource = {
  [TCategory in keyof PermissionCategories]: keyof PermissionCategories[TCategory]['resources'];
}[keyof PermissionCategories];
type ResourceDefinition<TResource extends PermissionResource> = {
  [TCategory in keyof PermissionCategories]: TResource extends keyof PermissionCategories[TCategory]['resources']
    ? PermissionCategories[TCategory]['resources'][TResource]
    : never;
}[keyof PermissionCategories];
type ResourceAction<TResource extends PermissionResource> =
  ResourceDefinition<TResource> extends {
    readonly actions: readonly (infer TAction extends string)[];
  }
    ? TAction
    : never;

export type TenantPermissionCode = {
  [TResource in PermissionResource & string]: `${TResource}:${ResourceAction<TResource>}`;
}[PermissionResource & string];

function permissionCodes(): TenantPermissionCode[] {
  const codes: TenantPermissionCode[] = [];
  for (const category of Object.values(TENANT_PERMISSION_CATEGORIES)) {
    for (const [resource, definition] of Object.entries(category.resources)) {
      for (const action of definition.actions) {
        const candidate = `${resource}:${action}`;
        if (isTenantPermissionCode(candidate)) codes.push(candidate);
      }
    }
  }
  return codes.sort();
}

function permissionCodeSet(): ReadonlySet<string> {
  const codes = new Set<string>();
  for (const category of Object.values(TENANT_PERMISSION_CATEGORIES)) {
    for (const [resource, definition] of Object.entries(category.resources)) {
      for (const action of definition.actions) codes.add(`${resource}:${action}`);
    }
  }
  return codes;
}

const TENANT_PERMISSION_CODE_SET: ReadonlySet<string> = permissionCodeSet();

export function isTenantPermissionCode(value: unknown): value is TenantPermissionCode {
  return typeof value === 'string' && TENANT_PERMISSION_CODE_SET.has(value);
}

export const TENANT_PERMISSION_CODES: readonly TenantPermissionCode[] =
  Object.freeze(permissionCodes());
