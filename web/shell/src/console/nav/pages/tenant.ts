/**
 * Tenant-admin panel pages (/tenant).
 *
 * The gate of each entry is the gate of its route in tenant-admin's Module.tsx
 * (MT-HIGH-060), which the coverage invariant checks: the three delegatable
 * pages carry their capability — a tenant admin, or a delegate whose custom
 * role grants it — and every other page is the tenant admin's alone.
 */
import type { ConsoleRole, NavPageDef } from '../types';

const ADMIN_ONLY: readonly ConsoleRole[] = ['TENANT_ADMIN'];

export const TENANT_PAGES = {
  dashboard: {
    id: 'tenant-dashboard',
    labelKey: 'nav.page.companyDashboard',
    path: '/tenant',
    requiredRoles: ADMIN_ONLY,
  },
  users: {
    id: 'tenant-users',
    labelKey: 'nav.users',
    path: '/tenant/users',
    requiredPermission: 'users:view',
  },
  roles: {
    id: 'tenant-roles',
    labelKey: 'nav.rolesPermissions',
    path: '/tenant/roles',
    requiredPermission: 'roles:view',
  },
  settings: {
    id: 'tenant-settings',
    labelKey: 'nav.page.accountSettings',
    path: '/tenant/settings',
    requiredPermission: 'settings:view',
  },
  activity: {
    id: 'tenant-activity',
    labelKey: 'nav.activity',
    path: '/tenant/activity',
    requiredRoles: ADMIN_ONLY,
  },
  auditLog: {
    id: 'tenant-audit-log',
    labelKey: 'nav.auditLog',
    path: '/tenant/audit-log',
    requiredRoles: ADMIN_ONLY,
  },
  devices: {
    id: 'tenant-devices',
    labelKey: 'nav.page.edgeDevices',
    path: '/tenant/devices',
    matchPaths: ['/tenant/devices/:deviceId'],
    requiredRoles: ADMIN_ONLY,
  },
  database: {
    id: 'tenant-database',
    labelKey: 'nav.database',
    path: '/tenant/database',
    requiredRoles: ADMIN_ONLY,
  },
  messages: {
    id: 'tenant-messages',
    labelKey: 'nav.page.platformMessages',
    path: '/tenant/messages',
    requiredRoles: ADMIN_ONLY,
  },
  support: {
    id: 'tenant-support',
    labelKey: 'nav.supportTickets',
    path: '/tenant/support',
    requiredRoles: ADMIN_ONLY,
  },
  announcements: {
    id: 'tenant-announcements',
    labelKey: 'nav.announcements',
    path: '/tenant/announcements',
    requiredRoles: ADMIN_ONLY,
  },
  modules: {
    id: 'tenant-modules',
    labelKey: 'nav.modules',
    path: '/tenant/modules',
    requiredRoles: ADMIN_ONLY,
  },
  billing: {
    id: 'tenant-billing',
    labelKey: 'nav.page.billingSubscription',
    path: '/tenant/billing',
    requiredRoles: ADMIN_ONLY,
  },
  architecture: {
    id: 'tenant-architecture',
    labelKey: 'nav.architecture',
    path: '/tenant/architecture',
    requiredRoles: ADMIN_ONLY,
  },
  architectureReview: {
    id: 'tenant-architecture-review',
    labelKey: 'nav.architectureReview',
    path: '/tenant/architecture/review',
    requiredRoles: ADMIN_ONLY,
  },
} satisfies Record<string, NavPageDef>;
