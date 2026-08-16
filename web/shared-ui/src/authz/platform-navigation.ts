import { PLATFORM_ROLE_CODES, Role, roleAtLeast } from '@platform/identity';
import type { TenantPermissionCode } from '@platform/tenant-permissions';

import type { NavigationItem } from '../types';

function freezeNavigationItem(item: NavigationItem): void {
  if (item.children !== undefined) {
    for (const child of item.children) freezeNavigationItem(child);
    Object.freeze(item.children);
  }
  if (item.requiredRoles !== undefined) Object.freeze(item.requiredRoles);
  if (item.requiredPermissions !== undefined) Object.freeze(item.requiredPermissions);
  Object.freeze(item);
}

function freezeNavigationItems(items: NavigationItem[]): NavigationItem[] {
  for (const item of items) freezeNavigationItem(item);
  Object.freeze(items);
  return items;
}

function freezeNavigationRecord(
  record: Record<string, NavigationItem>,
): Readonly<Record<string, NavigationItem>> {
  for (const item of Object.values(record)) freezeNavigationItem(item);
  return Object.freeze(record);
}

export const TENANT_DELEGATED_CAPABILITIES = Object.freeze({
  users: 'users:view',
  roles: 'roles:view',
  settings: 'settings:view',
} as const satisfies Readonly<Record<string, TenantPermissionCode>>);

const MANAGER_OR_HIGHER_ROLES = Object.freeze(
  PLATFORM_ROLE_CODES.filter((role) => roleAtLeast(role, Role.MODULE_MANAGER)),
);

/**
 * TENANT_ADMIN base navigation - Management items (English)
 */
export const TENANT_ADMIN_NAVIGATION = freezeNavigationItems([
  // ==================== COMPANY (TOP LEVEL) ====================
  {
    id: 'company',
    label: 'Company',
    path: '/sites/company',
    icon: 'building',
  },
  // ==================== MANAGEMENT ====================
  {
    id: 'tenant-dashboard',
    label: 'Dashboard',
    path: '/tenant',
    icon: 'dashboard',
  },
  {
    id: 'messaging',
    label: 'Messages',
    path: '/messaging',
    icon: 'message',
  },
  {
    id: 'tenant-users',
    requiredPermissions: [TENANT_DELEGATED_CAPABILITIES.users],
    label: 'Users',
    path: '/tenant/users',
    icon: 'users',
  },
  {
    // Tenant-configurable RBAC entry point. WHY: the /tenant/roles page + the
    // TenantRoleService role CRUD already exist end-to-end, but no rendered
    // sidebar linked to them — a tenant admin could only reach role management
    // by typing the URL. (The one sidebar that DID list it,
    // tenant-admin/components/TenantAdminSidebar.tsx, was dead code never
    // mounted, and has been removed.) This makes "tenants create their own
    // roles" actually discoverable.
    id: 'tenant-roles',
    requiredPermissions: [TENANT_DELEGATED_CAPABILITIES.roles],
    label: 'Roles & Permissions',
    path: '/tenant/roles',
    icon: 'shield',
  },
  {
    id: 'tenant-modules',
    label: 'Modules',
    path: '/tenant/modules',
    icon: 'modules',
  },
  {
    id: 'tenant-communication',
    label: 'Communication',
    icon: 'messages',
    children: [
      { id: 'tenant-messages', label: 'Messages', path: '/tenant/messages' },
      { id: 'tenant-support', label: 'Support Tickets', path: '/tenant/support' },
      { id: 'tenant-announcements', label: 'Announcements', path: '/tenant/announcements' },
    ],
  },
  {
    id: 'tenant-database',
    label: 'Database',
    path: '/tenant/database',
    icon: 'database',
  },
  {
    id: 'tenant-audit-log',
    label: 'Audit Log',
    path: '/tenant/audit-log',
    icon: 'security',
  },
  {
    id: 'tenant-billing',
    label: 'Billing',
    path: '/tenant/billing',
    icon: 'billing',
  },
  {
    id: 'tenant-activity',
    label: 'Activity',
    path: '/tenant/activity',
    icon: 'activity',
  },
  {
    id: 'tenant-settings',
    requiredPermissions: [TENANT_DELEGATED_CAPABILITIES.settings],
    label: 'Settings',
    path: '/tenant/settings',
    icon: 'settings',
  },
]);

/**
 * Module navigation configuration by module code
 */
export const PLATFORM_MODULE_NAVIGATION = freezeNavigationRecord({
  farm: {
    id: 'farm-module',
    label: 'Site Management',
    icon: 'farm',
    children: [
      { id: 'sites-environment', label: 'Environment', path: '/sites/environment' },
      { id: 'sites-setup', label: 'Setup', path: '/sites/setup' },
      { id: 'sites-tanks', label: 'Tanks & Ponds', path: '/sites/tanks' },
      { id: 'sites-feeding', label: 'Feeding', path: '/sites/feeding' },
      {
        id: 'sites-feeding-records',
        label: 'Feed Records & Inventory',
        path: '/sites/feeding/records',
      },
      { id: 'sites-water-chemistry', label: 'Water Chemistry', path: '/sites/water-chemistry' },
      { id: 'sites-storage', label: 'Storage & Stock', path: '/sites/storage' },
      { id: 'sites-tasks', label: 'Tasks', path: '/sites/tasks' },
      { id: 'sites-health', label: 'Health Events', path: '/sites/health', icon: 'activity' },
      {
        id: 'sites-maintenance',
        label: 'Maintenance',
        path: '/sites/maintenance',
        icon: 'settings',
      },
      { id: 'sites-harvest', label: 'Harvest', path: '/sites/harvest' },
      { id: 'sites-reports', label: 'Reports', path: '/sites/reports' },
      {
        id: 'sites-finance',
        label: 'Finance',
        path: '/sites/finance',
        icon: 'analytics',
        requiredRoles: MANAGER_OR_HIGHER_ROLES,
      },
      { id: 'sites-analytics', label: 'Analytics', path: '/sites/analytics', icon: 'analytics' },
    ],
  },
  sensor: {
    id: 'sensor-module',
    label: 'Sensor Monitoring',
    icon: 'sensor',
    children: [
      { id: 'sensor-dashboard', label: 'Dashboard', path: '/sensor' },
      { id: 'sensor-devices', label: 'Devices', path: '/sensor/devices' },
      { id: 'sensor-readings', label: 'Readings', path: '/sensor/readings' },
      { id: 'sensor-alerts', label: 'Alerts', path: '/sensor/alerts' },
      { id: 'sensor-water-chemistry', label: 'Water Chemistry', path: '/sensor/water-chemistry' },
      { id: 'sensor-automation', label: 'Automation', path: '/sensor/automation', icon: 'cpu' },
      { id: 'sensor-plc', label: 'PLC Control', path: '/sensor/plc', icon: 'server' },
      {
        id: 'sensor-plc-connections',
        label: 'PLC Connections',
        path: '/sensor/plc/connections',
        icon: 'wifi',
      },
      {
        id: 'sensor-plc-feeding',
        label: 'Feeding Params',
        path: '/sensor/plc/feeding',
        icon: 'bar-chart',
      },
      { id: 'sensor-plc-alarms', label: 'PLC Alarms', path: '/sensor/plc/alarms', icon: 'bell' },
      { id: 'sensor-processes', label: 'Process Editor', path: '/sensor/processes' },
      {
        id: 'sensor-scada',
        label: 'SCADA Packages',
        path: '/sensor/scada-packages',
        icon: 'monitor',
      },
    ],
  },
  hr: {
    id: 'hr-module',
    label: 'Human Resources',
    icon: 'users',
    children: [
      { id: 'hr-dashboard', label: 'Dashboard', path: '/hr' },
      { id: 'hr-employees', label: 'Employees', path: '/hr/employees' },
      { id: 'hr-departments', label: 'Departments', path: '/hr/departments' },
      { id: 'hr-scheduling', label: 'Scheduling', path: '/hr/scheduling', icon: 'calendar' },
      { id: 'hr-crew', label: 'Crew', path: '/hr/crew', icon: 'users' },
      { id: 'hr-attendance', label: 'Attendance', path: '/hr/attendance' },
      { id: 'hr-leaves', label: 'Leaves', path: '/hr/leaves', icon: 'calendar-off' },
      { id: 'hr-training', label: 'Training', path: '/hr/training', icon: 'graduation-cap' },
      { id: 'hr-payroll', label: 'Payroll', path: '/hr/payroll' },
      {
        id: 'hr-finance',
        label: 'Finance',
        path: '/hr/finance',
        icon: 'analytics',
        requiredRoles: MANAGER_OR_HIGHER_ROLES,
      },
    ],
  },
  hydroponics: {
    id: 'hydroponics-module',
    label: 'Hydroponics',
    icon: 'sprout',
    children: [
      { id: 'hydroponics-setup', label: 'Setup', path: '/hydroponics/setup' },
      {
        id: 'hydroponics-general',
        label: 'General Options',
        path: '/hydroponics/solution/general_options',
      },
      {
        id: 'hydroponics-water',
        label: 'Water Analysis',
        path: '/hydroponics/solution/water_analysis',
      },
      { id: 'hydroponics-user', label: 'User Options', path: '/hydroponics/solution/user_options' },
      { id: 'hydroponics-result', label: 'Result', path: '/hydroponics/solution/result' },
      { id: 'hydroponics-pid-sim', label: 'PID Simulator', path: '/hydroponics/pid-simulator' },
    ],
  },
  // 'process' module removed: no corresponding route exists in App.tsx
});

/**
 * MODULE_MANAGER and MODULE_USER navigation - Module based (English)
 */
export const MODULE_USER_BASE_NAVIGATION = freezeNavigationItems([
  {
    id: 'company',
    label: 'Company',
    path: '/sites/company',
    icon: 'building',
  },
  {
    id: 'dashboard',
    label: 'Dashboard',
    path: '/dashboard',
    icon: 'dashboard',
  },
  {
    id: 'messaging',
    label: 'Messages',
    path: '/messaging',
    icon: 'message',
  },
  {
    id: 'analytics',
    label: 'Analytics',
    path: '/analytics',
    icon: 'reports',
  },
  {
    id: 'reports',
    label: 'Reports',
    path: '/reports',
    icon: 'reports',
  },
]);

