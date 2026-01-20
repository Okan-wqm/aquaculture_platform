/**
 * Main Layout Component
 *
 * Main page layout for authenticated users.
 * Manages Header, Sidebar and content area.
 * Supports role-based navigation with dynamic module loading.
 */

import React, { useState, useCallback, useMemo } from 'react';
import { Outlet, useNavigate, useLocation } from 'react-router-dom';
import {
  Header,
  Sidebar,
  useAuthContext,
  useTenantContext,
  type NavigationItem,
  type SidebarTheme,
  type HeaderTheme,
} from '@aquaculture/shared-ui';

// ============================================================================
// Navigation Configuration - Role Based
// ============================================================================

/**
 * SUPER_ADMIN navigation - Full System Management
 * Synchronized with AdminSidebar
 */
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
    children: [
      { id: 'billing-overview', label: 'Overview', path: '/admin/billing' },
      { id: 'billing-module-pricing', label: 'Module Pricing', path: '/admin/billing/module-pricing' },
      { id: 'billing-subscriptions', label: 'Subscriptions', path: '/admin/billing/subscriptions' },
      { id: 'billing-invoices', label: 'Invoices', path: '/admin/billing/invoices' },
      { id: 'billing-discounts', label: 'Discounts', path: '/admin/billing/discounts' },
    ],
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
      { id: 'sites-harvest', label: 'Harvest', path: '/sites/harvest' },
      { id: 'sites-production', label: 'Production', path: '/sites/production' },
      { id: 'sites-reports', label: 'Reports', path: '/sites/reports' },
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
      { id: 'sensor-processes', label: 'Process Editor', path: '/sensor/processes' },
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
      { id: 'hr-attendance', label: 'Attendance', path: '/hr/attendance' },
      { id: 'hr-payroll', label: 'Payroll', path: '/hr/payroll' },
    ],
  },
  process: {
    id: 'process-module',
    label: 'Process Management',
    icon: 'process',
    children: [
      { id: 'process-list', label: 'Processes', path: '/processes' },
      { id: 'process-editor', label: 'Editor', path: '/processes/editor' },
      { id: 'process-templates', label: 'Templates', path: '/processes/templates' },
    ],
  },
};

/**
 * MODULE_MANAGER and MODULE_USER navigation - Module based (English)
 */
const moduleUserBaseNavigation: NavigationItem[] = [
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
  const { user, logout, isSuperAdmin, isTenantAdmin, modules } = useAuthContext();
  const { tenant } = useTenantContext();

  // Sidebar state
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

  /**
   * Build module navigation items from tenant's assigned modules
   */
  const moduleNavigationItems = useMemo((): NavigationItem[] => {
    if (!modules || modules.length === 0) {
      return [];
    }

    const moduleItems: NavigationItem[] = [];

    // Add divider before modules section
    moduleItems.push({
      id: 'divider-modules',
      label: '── Modules ──',
      path: '',
      icon: 'modules',
    });

    // Add navigation for each assigned module
    for (const module of modules) {
      const navConfig = MODULE_NAV_CONFIG[module.code];
      if (navConfig) {
        moduleItems.push(navConfig);
      }
    }

    return moduleItems;
  }, [modules]);

  /**
   * Role-based navigation menu with dynamic modules
   */
  const navigationItems = useMemo((): NavigationItem[] => {
    if (isSuperAdmin()) {
      return superAdminNavigation;
    }
    if (isTenantAdmin()) {
      // Tenant admin: base management items + dynamic module items
      return [...tenantAdminBaseNavigation, ...moduleNavigationItems];
    }
    // MODULE_MANAGER and MODULE_USER: base items + their assigned modules
    return [...moduleUserBaseNavigation, ...moduleNavigationItems];
  }, [isSuperAdmin, isTenantAdmin, moduleNavigationItems]);

  /**
   * Logo text based on role
   */
  const logoText = useMemo(() => {
    if (isSuperAdmin()) {
      return 'Aqua Admin';
    }
    if (isTenantAdmin()) {
      return tenant?.name || 'Tenant Admin';
    }
    return tenant?.name || 'Aquaculture';
  }, [isSuperAdmin, isTenantAdmin, tenant]);

  /**
   * Role-based theme selection
   * - SUPER_ADMIN: admin (indigo/purple)
   * - TENANT_ADMIN: tenant (emerald/green)
   * - Others: default (blue)
   */
  const theme: SidebarTheme = useMemo(() => {
    if (isSuperAdmin()) {
      return 'admin';
    }
    if (isTenantAdmin()) {
      return 'tenant';
    }
    return 'default';
  }, [isSuperAdmin, isTenantAdmin]);

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
   * Logout handler
   */
  const handleLogout = useCallback(async () => {
    await logout();
    navigate('/login');
  }, [logout, navigate]);

  /**
   * User menu items
   */
  const userMenuItems = [
    {
      label: 'My Profile',
      onClick: () => navigate('/settings/profile'),
    },
    {
      label: 'Settings',
      onClick: () => navigate('/settings'),
    },
  ];

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
        logo={
          <div className="flex items-center">
            <span className={`text-xl font-bold ${logoColorClass}`}>
              {logoText}
            </span>
          </div>
        }
      />

      {/* Main Content Area */}
      <div className="flex-1 flex flex-col min-h-screen">
        {/* Header */}
        <Header
          user={user}
          tenant={tenant}
          onSearch={(query) => {
            navigate(`/search?q=${encodeURIComponent(query)}`);
          }}
          notificationCount={3}
          onNotificationsClick={() => {
            console.log('Notifications clicked');
          }}
          userMenuItems={userMenuItems}
          onLogout={handleLogout}
          theme={theme as HeaderTheme}
          leftContent={
            <button
              onClick={handleSidebarToggle}
              className="p-2 text-gray-500 hover:text-gray-700 hover:bg-gray-100 rounded-lg md:hidden"
            >
              <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
              </svg>
            </button>
          }
        />

        {/* Page Content */}
        <main className="flex-1 p-6 overflow-auto">
          <Outlet />
        </main>
      </div>
    </div>
  );
};

export default MainLayout;
