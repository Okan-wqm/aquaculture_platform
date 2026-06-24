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
  createTenantQueryKey,
  type NavigationItem,
  type SidebarTheme,
  useAuthContext,
  useTenantContext,
} from '@aquaculture/shared-ui';
import { useQueryClient } from '@tanstack/react-query';
import React, { useState, useCallback, useMemo } from 'react';
import { Outlet, useNavigate, useLocation } from 'react-router-dom';

import ConsentBanner from '../components/ConsentBanner';
import { TenantSwitcher } from '../components/TenantSwitcher';

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
      { id: 'system-impersonation', label: 'Impersonation', path: '/admin/system/impersonation' },
      { id: 'system-debug', label: 'Debug Tools', path: '/admin/system/debug' },
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
      { id: 'settings-integrations', label: 'Integrations', path: '/admin/settings/integrations' },
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
    id: 'tenant-users',
    label: 'Users',
    path: '/tenant/users',
    icon: 'users',
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
 * Module navigation configuration by module code
 */
const MODULE_NAV_CONFIG: Record<string, NavigationItem> = {
  farm: {
    id: 'farm-module',
    label: 'Site Management',
    icon: 'farm',
    children: [
      { id: 'sites-map', label: 'Site Map', path: '/sites/map' },
      { id: 'sites-setup', label: 'Setup', path: '/sites/setup' },
      { id: 'sites-tanks', label: 'Tanks & Ponds', path: '/sites/tanks' },
      { id: 'sites-feeding', label: 'Feeding', path: '/sites/feeding' },
      { id: 'sites-feeding-records', label: 'Feed Records & Inventory', path: '/sites/feeding/records' },
      { id: 'sites-water-chemistry', label: 'Water Chemistry', path: '/sites/water-chemistry' },
      { id: 'sites-storage', label: 'Storage & Stock', path: '/sites/storage' },
      { id: 'sites-tasks', label: 'Tasks', path: '/sites/tasks' },
{ id: 'sites-health', label: 'Health Events', path: '/sites/health', icon: 'activity' },
      { id: 'sites-harvest', label: 'Harvest', path: '/sites/harvest' },
      { id: 'sites-reports', label: 'Reports', path: '/sites/reports' },
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
// Layout Component
// ============================================================================

const MainLayout: React.FC = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const queryClient = useQueryClient();
  const { user, logout, modules } = useAuthContext();
  const { tenant } = useTenantContext();

  // Derive primitive role value to avoid callback identity churn on user object refresh
  const userRole = user?.role;

  // Sidebar state
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

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
    return [...moduleUserBaseNavigation, ...moduleNavigationItems];
  }, [userRole, moduleNavigationItems]);

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
        queryClient.removeQueries({ queryKey: createTenantQueryKey(currentTenantId) });
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
  const notificationPanelElement = useMemo(() => <NotificationPanel />, []);

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

  return (
    <div className="min-h-screen bg-gray-50 flex">
      {/* Sidebar */}
      <Sidebar
        items={navigationItems}
        activePath={location.pathname}
        collapsed={sidebarCollapsed}
        onNavigate={handleNavigate}
        onCollapsedChange={handleSidebarToggle}
        theme={theme}
        logo={logoElement}
      />

      {/* Main Content Area */}
      <div className="flex-1 flex flex-col min-h-screen">
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
          rightContent={
            <>
              {/* SUPER_ADMIN tenant switcher (ORPHAN-HIGH-159) — renders only for
                  SUPER_ADMIN; lets the platform admin act-as a tenant so every
                  tenant-scoped panel resolves a deterministic tenant. */}
              {userRole === 'SUPER_ADMIN' && <TenantSwitcher />}
              {notificationPanelElement}
            </>
          }
        />

        {/* Page Content */}
        <main className="flex-1 p-6 overflow-auto">
          <Outlet />
        </main>
      </div>

      {/* GDPR Consent Banner — shown when consent is outdated or missing */}
      <ConsentBanner />
    </div>
  );
};

export default MainLayout;
