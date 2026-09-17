/**
 * Main Layout Component
 *
 * Main page layout for authenticated users.
 * Manages Header, Sidebar and content area.
 * Supports role-based navigation with dynamic module loading.
 */

import {
  ADMIN_BILLING_NAV_ITEMS,
  Header,
  Sidebar,
  SuderraSidebar,
  createTenantInvalidationKey,
  type NavigationItem,
  type SidebarTheme,
  type SuderraNavSection,
  useAuthContext,
  useAuth,
  useTenantContext,
} from '@aquaculture/shared-ui';
import { Sparkles } from 'lucide-react';
import AiAssistantDrawer from '../components/ai/AiAssistantDrawer';
import { useQueryClient } from '@tanstack/react-query';
import React, { useState, useCallback, useMemo } from 'react';
import { Outlet, useNavigate, useLocation } from 'react-router-dom';

import ConsentBanner from '../components/ConsentBanner';

import { NotificationPanel } from '@/components/NotificationPanel';

// ============================================================================
// Navigation Configuration - Role Based
// ============================================================================

/**
 * SUPER_ADMIN navigation - Full System Management
 * Synchronized with AdminSidebar
 */
const adminBillingNavItems: NavigationItem[] = ADMIN_BILLING_NAV_ITEMS.map((item) => ({ ...item }));

const superAdminNavigation: NavigationItem[] = [
  {
    id: 'admin-dashboard',
    label: 'Dashboard',
    path: '/admin',
    icon: 'dashboard',
  },
  {
    id: 'admin-analytics',
    label: 'Analytics',
    icon: 'analytics',
    children: [
      { id: 'analytics-dashboard', label: 'Overview', path: '/admin/analytics' },
      { id: 'analytics-reports', label: 'Reports', path: '/admin/analytics/reports' },
    ],
  },
  {
    id: 'admin-tenants',
    label: 'Tenants',
    icon: 'tenants',
    children: [
      { id: 'tenant-list', label: 'All Tenants', path: '/admin/tenants' },
      { id: 'tenant-create', label: 'Create Tenant', path: '/admin/tenants/new' },
    ],
  },
  {
    id: 'admin-users',
    label: 'Users',
    icon: 'users',
    children: [
      { id: 'user-list', label: 'All Users', path: '/admin/users' },
      { id: 'user-roles', label: 'Roles & Permissions', path: '/admin/users/roles' },
    ],
  },
  {
    id: 'admin-modules',
    label: 'Modules',
    path: '/admin/modules',
    icon: 'modules',
  },
  {
    id: 'admin-billing',
    label: 'Billing',
    icon: 'billing',
    children: adminBillingNavItems,
  },
  {
    id: 'admin-support',
    label: 'Support',
    icon: 'support',
    children: [
      { id: 'support-tickets', label: 'Tickets', path: '/admin/support/tickets' },
      { id: 'support-messaging', label: 'Messaging', path: '/admin/support/messaging' },
      { id: 'support-announcements', label: 'Announcements', path: '/admin/support/announcements' },
      { id: 'support-onboarding', label: 'Onboarding', path: '/admin/support/onboarding' },
    ],
  },
  {
    id: 'admin-security',
    label: 'Security',
    icon: 'security',
    children: [
      { id: 'security-activity', label: 'Activity Logs', path: '/admin/security/activity' },
      { id: 'security-audit', label: 'Audit Trail', path: '/admin/security/audit' },
      { id: 'security-compliance', label: 'Compliance', path: '/admin/security/compliance' },
      { id: 'security-threats', label: 'Threat Detection', path: '/admin/security/threats' },
    ],
  },
  {
    id: 'admin-system',
    label: 'System',
    icon: 'system',
    children: [
      { id: 'system-features', label: 'Feature Toggles', path: '/admin/system/features' },
      { id: 'system-maintenance', label: 'Maintenance', path: '/admin/system/maintenance' },
      { id: 'system-performance', label: 'Performance', path: '/admin/system/performance' },
      { id: 'system-errors', label: 'Error Tracking', path: '/admin/system/errors' },
      { id: 'system-jobs', label: 'Job Queue', path: '/admin/system/jobs' },
    ],
  },
  {
    id: 'admin-database',
    label: 'Database',
    icon: 'database',
    children: [
      { id: 'database-management', label: 'Management', path: '/admin/database' },
      { id: 'database-explorer', label: 'Explorer', path: '/admin/database/explorer' },
    ],
  },
  {
    id: 'admin-audit',
    label: 'Audit Logs',
    path: '/admin/audit',
    icon: 'audit',
  },
  {
    id: 'admin-settings',
    label: 'Settings',
    icon: 'settings',
    children: [
      { id: 'settings-general', label: 'General', path: '/admin/settings' },
      { id: 'settings-email', label: 'Email Templates', path: '/admin/settings/email' },
    ],
  },
];

/**
 * TENANT_ADMIN base navigation - Management items (English)
 */
const tenantAdminBaseNavigation: NavigationItem[] = [
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
    label: 'Settings',
    path: '/tenant/settings',
    icon: 'settings',
  },
];

/**
 * Tenant-admin nav items a tenant admin may DELEGATE to a custom role
 * (MT-HIGH-060), keyed to the capability that reveals each to a non-admin. Items
 * NOT listed here are admin-only and never render for a delegate. Mirrors the
 * per-route guards in tenant-admin Module.tsx + the delegatable set gated by
 * TenantPermissionGuard on the backend.
 */
const DELEGATABLE_TENANT_NAV: Record<string, string> = {
  'tenant-users': 'users:view',
  'tenant-roles': 'roles:view',
  'tenant-settings': 'settings:view',
};

/**
 * Module navigation configuration by module code
 */
const MODULE_NAV_CONFIG: Record<string, NavigationItem> = {
  farm: {
    id: 'farm-module',
    label: 'Site Management',
    icon: 'farm',
    children: [
      { id: 'sites-environment', label: 'Environment', path: '/sites/environment' },
      { id: 'sites-setup', label: 'Setup', path: '/sites/setup' },
      { id: 'sites-tanks', label: 'Tanks & Ponds', path: '/sites/tanks' },
      { id: 'sites-feeding', label: 'Feeding', path: '/sites/feeding' },
      { id: 'sites-water-chemistry', label: 'Water Chemistry', path: '/sites/water-chemistry' },
      { id: 'sites-storage', label: 'Storage & Stock', path: '/sites/storage' },
      { id: 'sites-tasks', label: 'Tasks', path: '/sites/tasks' },
{ id: 'sites-health', label: 'Health Events', path: '/sites/health', icon: 'activity' },
      { id: 'sites-maintenance', label: 'Maintenance', path: '/sites/maintenance', icon: 'settings' },
      { id: 'sites-harvest', label: 'Harvest', path: '/sites/harvest' },
      { id: 'sites-reports', label: 'Reports', path: '/sites/reports' },
      { id: 'sites-finance', label: 'Finance', path: '/sites/finance', icon: 'analytics', requiredRoles: ['SUPER_ADMIN', 'TENANT_ADMIN', 'MODULE_MANAGER'] },
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
      { id: 'sensor-plc-connections', label: 'PLC Connections', path: '/sensor/plc/connections', icon: 'wifi' },
      { id: 'sensor-plc-feeding', label: 'Feeding Params', path: '/sensor/plc/feeding', icon: 'bar-chart' },
      { id: 'sensor-plc-alarms', label: 'PLC Alarms', path: '/sensor/plc/alarms', icon: 'bell' },
      { id: 'sensor-processes', label: 'Process Editor', path: '/sensor/processes' },
      { id: 'sensor-scada', label: 'SCADA Packages', path: '/sensor/scada-packages', icon: 'monitor' },
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
      { id: 'hr-finance', label: 'Finance', path: '/hr/finance', icon: 'analytics', requiredRoles: ['SUPER_ADMIN', 'TENANT_ADMIN', 'MODULE_MANAGER'] },
    ],
  },
  hydroponics: {
    id: 'hydroponics-module',
    label: 'Hydroponics',
    icon: 'sprout',
    children: [
      { id: 'hydroponics-setup', label: 'Setup', path: '/hydroponics/setup' },
      { id: 'hydroponics-general', label: 'General Options', path: '/hydroponics/solution/general_options' },
      { id: 'hydroponics-water', label: 'Water Analysis', path: '/hydroponics/solution/water_analysis' },
      { id: 'hydroponics-user', label: 'User Options', path: '/hydroponics/solution/user_options' },
      { id: 'hydroponics-result', label: 'Result', path: '/hydroponics/solution/result' },
      { id: 'hydroponics-pid-sim', label: 'PID Simulator', path: '/hydroponics/pid-simulator' },
    ],
  },
  // 'process' module removed: no corresponding route exists in App.tsx
};

/**
 * MODULE_MANAGER and MODULE_USER navigation - Module based (English)
 */
const moduleUserBaseNavigation: NavigationItem[] = [
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
];

// ============================================================================
// SUDERRA tenant console rail — section grouping + icon mapping
// ============================================================================

/**
 * Rail icons for top-level items. The SUDERRA sidebar renders its own stroke
 * icon registry; existing nav data carries legacy icon names, so key items are
 * re-keyed to the mockup's icon set by nav id.
 */
const RAIL_ITEM_ICONS: Record<string, string> = {
  company: 'building',
  'tenant-dashboard': 'gauge',
  dashboard: 'gauge',
  messaging: 'chat',
  'tenant-users': 'users',
  'tenant-roles': 'shield',
  'tenant-activity': 'pulse',
  'tenant-modules': 'blocks',
  'tenant-communication': 'comms',
  'tenant-messages': 'mail',
  'tenant-support': 'lifebuoy',
  'tenant-announcements': 'megaphone',
  'tenant-devices': 'drive',
  'tenant-database': 'database',
  'tenant-audit-log': 'scroll',
  'tenant-billing': 'card',
  'tenant-settings': 'sliders',
  'farm-module': 'waves',
  'sensor-module': 'signal',
  'hr-module': 'contact',
  'hydroponics-module': 'wheat',
  analytics: 'linechart',
  reports: 'report',
};

/** Rail icons for module children (nav child ids → mockup icon names). */
const RAIL_CHILD_ICONS: Record<string, string> = {
  'sites-environment': 'thermo',
  'sites-setup': 'wrench',
  'sites-tanks': 'droplet',
  'sites-feeding': 'wheat',
  'sites-water-chemistry': 'ph',
  'sites-storage': 'warehouse',
  'sites-tasks': 'checks',
  'sites-health': 'lifebuoy',
  'sites-maintenance': 'wrench',
  'sites-harvest': 'basket',
  'sites-reports': 'bars',
  'sites-finance': 'card',
  'sites-analytics': 'linechart',
  'sensor-dashboard': 'gauge',
  'sensor-devices': 'chip',
  'sensor-readings': 'linechart',
  'sensor-alerts': 'bell',
  'sensor-automation': 'workflow',
  'sensor-water-chemistry': 'ph',
  'sensor-plc': 'chip',
  'sensor-plc-connections': 'network',
  'sensor-plc-feeding': 'wheat',
  'sensor-plc-alarms': 'bell',
  'sensor-processes': 'network',
  'sensor-scada': 'expand',
  'hr-dashboard': 'gauge',
  'hr-employees': 'users',
  'hr-departments': 'contact',
  'hr-scheduling': 'calendar',
  'hr-crew': 'users',
  'hr-attendance': 'clock',
  'hr-leaves': 'calendar',
  'hr-training': 'contact',
  'hr-payroll': 'banknote',
  'hr-finance': 'card',
  'hydroponics-setup': 'wrench',
  'hydroponics-general': 'sliders',
  'hydroponics-water': 'droplet',
  'hydroponics-user': 'user',
  'hydroponics-result': 'linechart',
  'hydroponics-pid-sim': 'workflow',
};

/** Edge devices entry (page + route exist; surfaced in the Account section). */
const EDGE_DEVICES_ITEM: NavigationItem = {
  id: 'tenant-devices',
  label: 'Edge devices',
  path: '/tenant/devices',
  icon: 'drive',
};

const withRailIcons = (items: NavigationItem[]): NavigationItem[] =>
  items.map((item) => ({
    ...item,
    icon: RAIL_ITEM_ICONS[item.id] ?? item.icon,
    children: item.children?.map((child) => ({
      ...child,
      icon: RAIL_CHILD_ICONS[child.id] ?? child.icon,
    })),
  }));

/**
 * Compose the grouped rail sections for tenant-side roles (TENANT_ADMIN and
 * module users). Structure follows the approved Tenant Console mockup:
 * Overview / People & access / Modules / Communication / Account. Every REAL
 * nav item keeps its route — the mockup's curated subset only decides the
 * grouping, items it omitted (Environment, PLC submenu, Hydroponics…) are
 * kept under their module parent so nothing is lost.
 */
const buildTenantSections = (
  userRole: string | undefined,
  moduleNavigationItems: NavigationItem[],
  delegatedItems: NavigationItem[],
): SuderraNavSection[] => {
  const base =
    userRole === 'TENANT_ADMIN' ? tenantAdminBaseNavigation : moduleUserBaseNavigation;
  const pool: NavigationItem[] = [
    ...base,
    ...delegatedItems.filter((d) => !base.some((b) => b.id === d.id)),
  ];
  const byId = (id: string): NavigationItem | undefined => pool.find((i) => i.id === id);
  const pick = (ids: string[]): NavigationItem[] =>
    ids.map(byId).filter((item): item is NavigationItem => !!item);

  const moduleItems = moduleNavigationItems.filter(
    (item) => item.id !== 'divider-modules' && item.path !== '',
  );
  const comms = byId('tenant-communication');

  const sections: SuderraNavSection[] = [
    {
      id: 'sec-overview',
      label: 'Overview',
      items: pick(
        userRole === 'TENANT_ADMIN'
          ? ['company', 'tenant-dashboard', 'messaging']
          : ['company', 'dashboard', 'messaging', 'analytics', 'reports'],
      ),
    },
    {
      id: 'sec-people',
      label: 'People & access',
      items: pick(['tenant-users', 'tenant-roles', 'tenant-activity']),
    },
    {
      id: 'sec-modules',
      label: 'Modules',
      items: [...pick(['tenant-modules']), ...moduleItems],
    },
    {
      id: 'sec-comms',
      label: 'Communication',
      items: comms?.children ?? pick(['tenant-messages', 'tenant-support', 'tenant-announcements']),
    },
    {
      id: 'sec-account',
      label: 'Account',
      items: [
        ...(userRole === 'TENANT_ADMIN' ? [EDGE_DEVICES_ITEM] : []),
        ...pick(['tenant-database', 'tenant-audit-log', 'tenant-billing', 'tenant-settings']),
      ],
    },
  ];

  return sections
    .map((section) => ({ ...section, items: withRailIcons(section.items) }))
    .filter((section) => section.items.length > 0);
};

// ============================================================================
// Layout Component
// ============================================================================

const MainLayout: React.FC = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const queryClient = useQueryClient();
  const { user, logout, modules } = useAuthContext();
  const { tenant } = useTenantContext();
  // hasPermission is the resource-permission SSoT (useAuthContext exposes only
  // roles); gates the AI assistant trigger by ai_assistant:use.
  const { hasPermission } = useAuth();

  // Derive primitive role value to avoid callback identity churn on user object refresh
  const userRole = user?.role;

  // Sidebar state
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  // AI assistant drawer (shell-level, accessible from every module).
  const [aiDrawerOpen, setAiDrawerOpen] = useState(false);
  const canUseAiAssistant = hasPermission('ai_assistant:use');

  /**
   * Build module navigation items from tenant's assigned modules.
   * Divider is added only when at least one module has a nav config.
   */
  const moduleNavigationItems = useMemo((): NavigationItem[] => {
    if (!modules || modules.length === 0) {
      return [];
    }

    const items: NavigationItem[] = [];
    for (const module of modules) {
      const navConfig = MODULE_NAV_CONFIG[module.code];
      if (navConfig) {
        items.push(navConfig);
      }
    }

    if (items.length === 0) {
      return [];
    }

    return [
      { id: 'divider-modules', label: '── Modules ──', path: '', icon: 'modules' },
      ...items,
    ];
  }, [modules]);

  /**
   * MT-HIGH-060 delegation: a non-admin tenant user whose custom role grants a
   * delegatable panel capability sees just those tenant items (Users/Roles/
   * Settings) alongside their normal module nav. hasPermission bypasses
   * admins and is fail-closed for everyone else.
   */
  const delegatedTenantItems = useMemo(() => {
    if (userRole === 'TENANT_ADMIN' || userRole === 'SUPER_ADMIN') {
      return [];
    }
    return tenantAdminBaseNavigation.filter((item) => {
      const cap = DELEGATABLE_TENANT_NAV[item.id];
      return cap !== undefined && hasPermission(cap);
    });
  }, [userRole, hasPermission]);

  /**
   * Role-based navigation menu with dynamic modules.
   * Depends on primitive userRole string, not function references.
   */
  const navigationItems = useMemo((): NavigationItem[] => {
    if (userRole === 'SUPER_ADMIN') {
      return superAdminNavigation;
    }
    if (userRole === 'TENANT_ADMIN') {
      return [...tenantAdminBaseNavigation, ...moduleNavigationItems];
    }
    return [...moduleUserBaseNavigation, ...delegatedTenantItems, ...moduleNavigationItems];
  }, [userRole, moduleNavigationItems, delegatedTenantItems]);

  /**
   * SUDERRA rail sections for tenant-side roles (TENANT_ADMIN + module users).
   */
  const tenantSections = useMemo(
    () => buildTenantSections(userRole, moduleNavigationItems, delegatedTenantItems),
    [userRole, moduleNavigationItems, delegatedTenantItems],
  );

  /**
   * Logo text based on role
   */
  const logoText = useMemo(() => {
    if (userRole === 'SUPER_ADMIN') {
      return 'Aqua Admin';
    }
    if (userRole === 'TENANT_ADMIN') {
      return tenant?.name || 'Tenant Admin';
    }
    return tenant?.name || 'Aquaculture';
  }, [userRole, tenant]);

  /**
   * Role-based theme selection
   * - SUPER_ADMIN: admin (indigo/purple)
   * - TENANT_ADMIN: tenant (emerald/green)
   * - Others: default (blue)
   */
  const theme: SidebarTheme = useMemo(() => {
    if (userRole === 'SUPER_ADMIN') {
      return 'admin';
    }
    if (userRole === 'TENANT_ADMIN') {
      return 'tenant';
    }
    return 'default';
  }, [userRole]);

  /**
   * Logo color based on theme
   */
  const logoColorClass = useMemo(() => {
    switch (theme) {
      case 'admin':
        return 'text-indigo-600';
      case 'tenant':
        return 'text-emerald-600';
      default:
        return 'text-blue-600';
    }
  }, [theme]);

  /**
   * Sidebar toggle handler
   */
  const handleSidebarToggle = useCallback(() => {
    setSidebarCollapsed(prev => !prev);
  }, []);

  /**
   * Navigation handler
   */
  const handleNavigate = useCallback(
    (path: string) => {
      navigate(path);
    },
    [navigate]
  );

  /**
   * Logout handler — purges tenant-scoped query cache before navigating
   * to /login. This prevents stale cross-tenant data from lingering in
   * the cache when a different user logs in on the same browser tab.
   *
   * SECURITY: removeQueries (not invalidateQueries) is used because we
   * want to destroy the data, not refetch it with potentially invalid
   * credentials (FE-CRITICAL-014/015/016).
   */
  const handleLogout = useCallback(async () => {
    // SECURITY: Capture tenantId before logout clears it from state
    const currentTenantId = user?.tenantId;
    try {
      await logout();
    } finally {
      if (currentTenantId) {
        queryClient.removeQueries({ queryKey: createTenantInvalidationKey(currentTenantId) });
      }
      navigate('/login');
    }
  }, [logout, navigate, queryClient, user?.tenantId]);

  /**
   * User menu items — memoized to avoid recreating on every render
   */
  const userMenuItems = useMemo(() => [
    {
      label: 'My Profile',
      onClick: () => navigate('/settings/profile'),
    },
    {
      label: 'Settings',
      onClick: () => navigate('/settings'),
    },
  ], [navigate]);

  /**
   * Search handler — stable reference to avoid Header re-renders.
   * Search route is not yet implemented; navigate to "/" as a no-op fallback.
   */
  const handleSearch = useCallback((_query: string) => {
    // TODO: implement global search page and update this navigation
  }, []);

  /**
   * Notification panel element — self-contained bell icon with dropdown.
   * Rendered as rightContent in the Header to replace the built-in bell button.
   */
  const notificationPanelElement = useMemo(
    () => (
      <div className="flex items-center gap-1">
        {canUseAiAssistant && (
          <button
            onClick={() => setAiDrawerOpen(true)}
            title="AI Assistant"
            aria-label="Open AI assistant"
            className="rounded-lg p-2 text-gray-500 hover:bg-gray-100 hover:text-tenant-600"
          >
            <Sparkles className="h-5 w-5" />
          </button>
        )}
        <NotificationPanel />
      </div>
    ),
    [canUseAiAssistant],
  );

  /**
   * Logo element — memoized to avoid Sidebar re-renders
   */
  const logoElement = useMemo(() => (
    <div className="flex items-center">
      <span className={`text-xl font-bold ${logoColorClass}`}>{logoText}</span>
    </div>
  ), [logoColorClass, logoText]);

  /**
   * Sidebar toggle button — memoized to avoid Header re-renders
   */
  const leftContent = useMemo(() => (
    <button
      onClick={handleSidebarToggle}
      className="p-2 text-gray-500 hover:text-gray-700 hover:bg-gray-100 rounded-lg md:hidden"
    >
      <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
      </svg>
    </button>
  ), [handleSidebarToggle]);

  // Tenant-side roles get the SUDERRA rail; SUPER_ADMIN keeps the legacy
  // Sidebar until its own console redesign lands.
  const isSuperAdmin = userRole === 'SUPER_ADMIN';

  return (
    <div className={`min-h-screen flex ${isSuperAdmin ? 'bg-gray-50' : 'bg-sd-paper'}`}>
      {/* Sidebar */}
      {isSuperAdmin ? (
        <Sidebar
          items={navigationItems}
          activePath={location.pathname}
          collapsed={sidebarCollapsed}
          onNavigate={handleNavigate}
          onCollapsedChange={handleSidebarToggle}
          theme={theme}
          logo={logoElement}
          userRoles={userRole ? [userRole] : []}
        />
      ) : (
        <SuderraSidebar
          sections={tenantSections}
          activePath={location.pathname}
          onNavigate={handleNavigate}
          // brandName/brandSub are real (tenant?.name + role); statusText is a
          // STATIC chip — there is no live platform-status endpoint yet.
          brandName={tenant?.name || 'Suderra Aqua'}
          brandSub={userRole === 'TENANT_ADMIN' ? 'Tenant console' : 'Workspace'}
          logoSrc="/logo4-mark.png"
          statusText="Live"
          userRoles={userRole ? [userRole] : []}
        />
      )}

      {/* Main Content Area */}
      <div className="flex-1 flex flex-col min-h-screen sd-content">
        {/* Header */}
        <Header
          user={user}
          tenant={tenant}
          onSearch={handleSearch}
          userMenuItems={userMenuItems}
          onLogout={() => {
            void handleLogout();
          }}
          theme={theme}
          leftContent={leftContent}
          rightContent={notificationPanelElement}
        />

        {/* Page Content */}
        <main className="flex-1 overflow-auto sd-main">
          <Outlet />
        </main>
      </div>

      {/* GDPR Consent Banner — shown when consent is outdated or missing */}
      <ConsentBanner />

      {canUseAiAssistant && (
        <AiAssistantDrawer open={aiDrawerOpen} onClose={() => setAiDrawerOpen(false)} />
      )}
    </div>
  );
};

export default MainLayout;
