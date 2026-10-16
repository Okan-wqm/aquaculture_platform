/**
 * The tenant nav before the console (FE-HIGH-335), frozen as the regression
 * baseline: what web/shell/src/layouts/MainLayout.tsx + tenantRail.ts listed
 * per role at 39bb0354c — `tenantAdminBaseNavigation` + `EDGE_DEVICES_ENTRY`
 * for a tenant admin, `moduleUserBaseNavigation` + the
 * `DELEGATABLE_TENANT_NAV` entries the user's capabilities reveal for anyone
 * else, then `MODULE_NAV_CONFIG` per assigned module with each child's
 * `requiredRoles` (exact role membership, as SuderraSidebar's canSeeNavItem).
 *
 * Frozen rather than imported because the console replaces those lists: the
 * baseline must outlive them. Each entry records where it LANDS — a redirect
 * source is followed to its target — and, for an entry whose route refused
 * the viewer, `brokenUnless`: the module that makes it a real page.
 */
import type { ConsoleRole, ModuleCode, NavPermission, TenantCapability } from '../types';

export interface LegacyEntry {
  readonly id: string;
  /** The final destination the entry opened (redirects followed). */
  readonly lands: string;
  readonly requiredRoles?: readonly ConsoleRole[];
  /**
   * The entry was a dead link unless the viewer held this module: `/sites/company`
   * for a module user without farm (403), and the two base links no route
   * served (`/analytics`, `/reports`), here at the routes that serve them.
   */
  readonly brokenUnless?: ModuleCode;
  /**
   * Roles the page itself refused (an in-page "Access Restricted" gate): the
   * entry was listed for them but led nowhere, so the console drops it.
   */
  readonly refusedRoles?: readonly ConsoleRole[];
  /**
   * The console reaches this destination as a level-3 tab of its page, as the
   * design places it, rather than as a row of its own.
   */
  readonly reachedAs?: 'tab';
}

const FINANCE_ROLES: readonly ConsoleRole[] = ['TENANT_ADMIN', 'MODULE_MANAGER'];

const TENANT_ADMIN_BASE: readonly LegacyEntry[] = [
  { id: 'company', lands: '/sites/company' },
  { id: 'tenant-dashboard', lands: '/tenant' },
  { id: 'messaging', lands: '/messaging' },
  { id: 'tenant-users', lands: '/tenant/users' },
  { id: 'tenant-roles', lands: '/tenant/roles' },
  { id: 'tenant-modules', lands: '/tenant/modules' },
  { id: 'tenant-messages', lands: '/tenant/messages' },
  { id: 'tenant-support', lands: '/tenant/support' },
  { id: 'tenant-announcements', lands: '/tenant/announcements' },
  { id: 'tenant-database', lands: '/tenant/database' },
  { id: 'tenant-audit-log', lands: '/tenant/audit-log' },
  { id: 'tenant-billing', lands: '/tenant/billing' },
  { id: 'tenant-activity', lands: '/tenant/activity' },
  { id: 'tenant-architecture', lands: '/tenant/architecture' },
  { id: 'tenant-architecture-review', lands: '/tenant/architecture/review' },
  { id: 'tenant-settings', lands: '/tenant/settings' },
  { id: 'tenant-devices', lands: '/tenant/devices' },
];

const MODULE_USER_BASE: readonly LegacyEntry[] = [
  { id: 'company', lands: '/sites/company', brokenUnless: 'farm' },
  { id: 'dashboard', lands: '/dashboard' },
  { id: 'messaging', lands: '/messaging' },
  // Was `/analytics`, which no route served (NotFound outside the layout).
  { id: 'analytics', lands: '/dashboard/analytics' },
  // Was `/reports`, likewise; the farm regulatory reports are the real page.
  { id: 'reports', lands: '/sites/reports/sea-lice', brokenUnless: 'farm' },
];

/** `DELEGATABLE_TENANT_NAV`: the tenant entries a capability reveals to a non-admin. */
const DELEGATED: readonly (LegacyEntry & { readonly capability: TenantCapability })[] = [
  { id: 'tenant-users', lands: '/tenant/users', capability: 'users:view' },
  { id: 'tenant-roles', lands: '/tenant/roles', capability: 'roles:view' },
  { id: 'tenant-settings', lands: '/tenant/settings', capability: 'settings:view' },
];

/** `MODULE_NAV_CONFIG` children per module code. */
const MODULE_ENTRIES: Readonly<Record<ModuleCode, readonly LegacyEntry[]>> = {
  farm: [
    { id: 'sites-environment', lands: '/sites/environment' },
    // `/sites/setup` redirected to its first tab.
    { id: 'sites-setup', lands: '/sites/setup/sites' },
    { id: 'sites-tanks', lands: '/sites/tanks' },
    { id: 'sites-feeding', lands: '/sites/feeding' },
    // The design makes Records a tab of Feeding (digest §8.3 `feedrec`).
    { id: 'sites-feeding-records', lands: '/sites/feeding?tab=records', reachedAs: 'tab' },
    { id: 'sites-water-chemistry', lands: '/sites/water-chemistry' },
    { id: 'sites-storage', lands: '/sites/storage' },
    { id: 'sites-tasks', lands: '/sites/tasks' },
    { id: 'sites-health', lands: '/sites/health' },
    { id: 'sites-maintenance', lands: '/sites/maintenance' },
    { id: 'sites-harvest', lands: '/sites/harvest' },
    // `/sites/reports` redirected to its first report.
    { id: 'sites-reports', lands: '/sites/reports/sea-lice' },
    { id: 'sites-finance', lands: '/sites/finance', requiredRoles: FINANCE_ROLES },
    // `/sites/analytics` redirected to its one tab.
    { id: 'sites-analytics', lands: '/sites/analytics/tanks' },
  ],
  sensor: [
    { id: 'sensor-dashboard', lands: '/sensor' },
    { id: 'sensor-devices', lands: '/sensor/devices' },
    { id: 'sensor-readings', lands: '/sensor/readings' },
    { id: 'sensor-alerts', lands: '/sensor/alerts' },
    { id: 'sensor-water-chemistry', lands: '/sensor/water-chemistry' },
    { id: 'sensor-automation', lands: '/sensor/automation' },
    { id: 'sensor-plc', lands: '/sensor/plc' },
    { id: 'sensor-plc-connections', lands: '/sensor/plc/connections' },
    { id: 'sensor-plc-feeding', lands: '/sensor/plc/feeding' },
    { id: 'sensor-plc-alarms', lands: '/sensor/plc/alarms' },
    { id: 'sensor-processes', lands: '/sensor/processes' },
    { id: 'sensor-scada', lands: '/sensor/scada-packages' },
  ],
  hr: [
    { id: 'hr-dashboard', lands: '/hr' },
    { id: 'hr-today', lands: '/hr/today' },
    { id: 'hr-employees', lands: '/hr/employees' },
    { id: 'hr-departments', lands: '/hr/departments' },
    { id: 'hr-scheduling', lands: '/hr/scheduling' },
    { id: 'hr-crew', lands: '/hr/crew' },
    { id: 'hr-attendance', lands: '/hr/attendance' },
    { id: 'hr-leaves', lands: '/hr/leaves' },
    { id: 'hr-training', lands: '/hr/training' },
    // PayrollPage `isAuthorised` (SEC-003) shows a module user "Access Restricted".
    { id: 'hr-payroll', lands: '/hr/payroll', refusedRoles: ['MODULE_USER'] },
    { id: 'hr-finance', lands: '/hr/finance', requiredRoles: FINANCE_ROLES },
  ],
  hydroponics: [
    { id: 'hydroponics-setup', lands: '/hydroponics/setup' },
    { id: 'hydroponics-general', lands: '/hydroponics/solution/general_options' },
    { id: 'hydroponics-water', lands: '/hydroponics/solution/water_analysis' },
    { id: 'hydroponics-user', lands: '/hydroponics/solution/user_options' },
    { id: 'hydroponics-result', lands: '/hydroponics/solution/result' },
    { id: 'hydroponics-pid-sim', lands: '/hydroponics/pid-simulator' },
  ],
};

export interface LegacyViewer {
  readonly role: ConsoleRole;
  readonly modules: readonly ModuleCode[];
  readonly permissions: readonly NavPermission[];
}

/** Every entry the pre-console rail showed `viewer`, in its order. */
export function legacyTenantNav(viewer: LegacyViewer): LegacyEntry[] {
  const base =
    viewer.role === 'TENANT_ADMIN'
      ? TENANT_ADMIN_BASE
      : [
          ...MODULE_USER_BASE,
          ...DELEGATED.filter((entry) => viewer.permissions.includes(entry.capability)),
        ];
  const moduleEntries = viewer.modules.flatMap((module) =>
    MODULE_ENTRIES[module].filter(
      (entry) => entry.requiredRoles === undefined || entry.requiredRoles.includes(viewer.role),
    ),
  );
  return [...base, ...moduleEntries];
}
