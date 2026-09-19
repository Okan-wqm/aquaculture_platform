/**
 * Main Layout Component
 *
 * Main page layout for authenticated users.
 * Manages Header, Sidebar and content area.
 * Supports role-based navigation with dynamic module loading.
 */

import {
  ADMIN_BILLING_NAV_ITEMS,
  Button,
  Header,
  Sidebar,
  createTenantInvalidationKey,
  type I18nContextValue,
  type MessageKey,
  type NavigationItem,
  type SidebarTheme,
  useAuthContext,
  useAuth,
  useI18n,
  useTenantContext,
  SkipToContent,
} from '@aquaculture/shared-ui';
import { Menu, Sparkles } from 'lucide-react';
import AiAssistantDrawer from '../components/ai/AiAssistantDrawer';
import { useQueryClient } from '@tanstack/react-query';
import React, { useState, useCallback, useMemo } from 'react';
import { Outlet, useNavigate, useLocation } from 'react-router-dom';

import { ActAsTenantBanner } from '../components/ActAsTenantBanner';
import ConsentBanner from '../components/ConsentBanner';
import { UserLocaleSync } from '../components/UserLocaleSync';

import { NotificationPanel } from '@/components/NotificationPanel';

// ============================================================================
// Navigation Configuration - Role Based
// ============================================================================

/**
 * A navigation entry as the shell declares it: the label is a message key,
 * localized at render, so the menu follows the user's language rather than
 * this file's (FE-HIGH-089). An entry may instead carry a literal `label` —
 * the SUPER_ADMIN billing routes do, as the panel is a declared English-only
 * surface.
 */
type NavigationDefinition = Omit<NavigationItem, 'label' | 'children'> & {
  children?: NavigationDefinition[];
} & ({ labelKey: MessageKey; label?: never } | { label: string; labelKey?: never });

function localizeNavigation(
  items: NavigationDefinition[],
  t: I18nContextValue['t'],
): NavigationItem[] {
  return items.map((item) => ({
    id: item.id,
    icon: item.icon,
    path: item.path,
    requiredRoles: item.requiredRoles,
    requiredPermissions: item.requiredPermissions,
    badge: item.badge,
    isExternal: item.isExternal,
    label: item.labelKey !== undefined ? t(item.labelKey) : item.label,
    ...(item.children ? { children: localizeNavigation(item.children, t) } : {}),
  }));
}

/**
 * SUPER_ADMIN navigation - Full System Management
 * Synchronized with AdminSidebar
 */
const adminBillingNavItems: NavigationItem[] = ADMIN_BILLING_NAV_ITEMS.map((item) => ({ ...item }));

const superAdminNavigation: NavigationDefinition[] = [
  {
    id: 'admin-dashboard',
    labelKey: 'nav.dashboard',
    path: '/admin',
    icon: 'dashboard',
  },
  {
    id: 'admin-analytics',
    labelKey: 'nav.analytics',
    icon: 'analytics',
    children: [
      { id: 'analytics-dashboard', labelKey: 'nav.overview', path: '/admin/analytics' },
      { id: 'analytics-reports', labelKey: 'nav.reports', path: '/admin/analytics/reports' },
    ],
  },
  {
    id: 'admin-tenants',
    labelKey: 'nav.tenants',
    icon: 'tenants',
    children: [
      { id: 'tenant-list', labelKey: 'nav.allTenants', path: '/admin/tenants' },
      { id: 'tenant-create', labelKey: 'nav.createTenant', path: '/admin/tenants/new' },
    ],
  },
  {
    id: 'admin-users',
    labelKey: 'nav.users',
    icon: 'users',
    children: [
      { id: 'user-list', labelKey: 'nav.allUsers', path: '/admin/users' },
      { id: 'user-roles', labelKey: 'nav.rolesPermissions', path: '/admin/users/roles' },
    ],
  },
  {
    id: 'admin-modules',
    labelKey: 'nav.modules',
    path: '/admin/modules',
    icon: 'modules',
  },
  {
    id: 'admin-billing',
    labelKey: 'nav.billing',
    icon: 'billing',
    children: adminBillingNavItems,
  },
  {
    id: 'admin-support',
    labelKey: 'nav.support',
    icon: 'support',
    children: [
      { id: 'support-tickets', labelKey: 'nav.tickets', path: '/admin/support/tickets' },
      { id: 'support-messaging', labelKey: 'nav.messaging', path: '/admin/support/messaging' },
      {
        id: 'support-announcements',
        labelKey: 'nav.announcements',
        path: '/admin/support/announcements',
      },
      { id: 'support-onboarding', labelKey: 'nav.onboarding', path: '/admin/support/onboarding' },
    ],
  },
  {
    id: 'admin-security',
    labelKey: 'nav.security',
    icon: 'security',
    children: [
      { id: 'security-activity', labelKey: 'nav.activityLogs', path: '/admin/security/activity' },
      { id: 'security-audit', labelKey: 'nav.auditTrail', path: '/admin/security/audit' },
      { id: 'security-compliance', labelKey: 'nav.compliance', path: '/admin/security/compliance' },
      { id: 'security-threats', labelKey: 'nav.threatDetection', path: '/admin/security/threats' },
    ],
  },
  {
    id: 'admin-system',
    labelKey: 'nav.system',
    icon: 'system',
    children: [
      { id: 'system-features', labelKey: 'nav.featureToggles', path: '/admin/system/features' },
      { id: 'system-maintenance', labelKey: 'nav.maintenance', path: '/admin/system/maintenance' },
      { id: 'system-performance', labelKey: 'nav.performance', path: '/admin/system/performance' },
      { id: 'system-errors', labelKey: 'nav.errorTracking', path: '/admin/system/errors' },
      { id: 'system-jobs', labelKey: 'nav.jobQueue', path: '/admin/system/jobs' },
    ],
  },
  {
    id: 'admin-database',
    labelKey: 'nav.database',
    icon: 'database',
    children: [
      { id: 'database-management', labelKey: 'nav.management', path: '/admin/database' },
      { id: 'database-explorer', labelKey: 'nav.explorer', path: '/admin/database/explorer' },
    ],
  },
  {
    id: 'admin-audit',
    labelKey: 'nav.auditLogs',
    path: '/admin/audit',
    icon: 'audit',
  },
  {
    id: 'admin-settings',
    labelKey: 'nav.settings',
    icon: 'settings',
    children: [
      { id: 'settings-general', labelKey: 'nav.general', path: '/admin/settings' },
      { id: 'settings-email', labelKey: 'nav.emailTemplates', path: '/admin/settings/email' },
    ],
  },
];

/**
 * TENANT_ADMIN base navigation - Management items (English)
 */
const tenantAdminBaseNavigation: NavigationDefinition[] = [
  // ==================== COMPANY (TOP LEVEL) ====================
  {
    id: 'company',
    labelKey: 'nav.company',
    path: '/sites/company',
    icon: 'building',
  },
  // ==================== MANAGEMENT ====================
  {
    id: 'tenant-dashboard',
    labelKey: 'nav.dashboard',
    path: '/tenant',
    icon: 'dashboard',
  },
  {
    id: 'messaging',
    labelKey: 'nav.messages',
    path: '/messaging',
    icon: 'message',
  },
  {
    id: 'tenant-users',
    labelKey: 'nav.users',
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
    labelKey: 'nav.rolesPermissions',
    path: '/tenant/roles',
    icon: 'shield',
  },
  {
    id: 'tenant-modules',
    labelKey: 'nav.modules',
    path: '/tenant/modules',
    icon: 'modules',
  },
  {
    id: 'tenant-communication',
    labelKey: 'nav.communication',
    icon: 'messages',
    children: [
      { id: 'tenant-messages', labelKey: 'nav.messages', path: '/tenant/messages' },
      { id: 'tenant-support', labelKey: 'nav.supportTickets', path: '/tenant/support' },
      { id: 'tenant-announcements', labelKey: 'nav.announcements', path: '/tenant/announcements' },
    ],
  },
  {
    id: 'tenant-database',
    labelKey: 'nav.database',
    path: '/tenant/database',
    icon: 'database',
  },
  {
    id: 'tenant-audit-log',
    labelKey: 'nav.auditLog',
    path: '/tenant/audit-log',
    icon: 'security',
  },
  {
    id: 'tenant-billing',
    labelKey: 'nav.billing',
    path: '/tenant/billing',
    icon: 'billing',
  },
  {
    id: 'tenant-activity',
    labelKey: 'nav.activity',
    path: '/tenant/activity',
    icon: 'activity',
  },
  {
    id: 'tenant-settings',
    labelKey: 'nav.settings',
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
const MODULE_NAV_CONFIG: Record<string, NavigationDefinition> = {
  farm: {
    id: 'farm-module',
    labelKey: 'nav.siteManagement',
    icon: 'farm',
    children: [
      { id: 'sites-environment', labelKey: 'nav.environment', path: '/sites/environment' },
      { id: 'sites-setup', labelKey: 'nav.setup', path: '/sites/setup' },
      { id: 'sites-tanks', labelKey: 'nav.tanksPonds', path: '/sites/tanks' },
      { id: 'sites-feeding', labelKey: 'nav.feeding', path: '/sites/feeding' },
      {
        id: 'sites-feeding-records',
        labelKey: 'nav.feedRecordsInventory',
        path: '/sites/feeding/records',
      },
      {
        id: 'sites-water-chemistry',
        labelKey: 'nav.waterChemistry',
        path: '/sites/water-chemistry',
      },
      { id: 'sites-storage', labelKey: 'nav.storageStock', path: '/sites/storage' },
      { id: 'sites-tasks', labelKey: 'nav.tasks', path: '/sites/tasks' },
      { id: 'sites-health', labelKey: 'nav.healthEvents', path: '/sites/health', icon: 'activity' },
      {
        id: 'sites-maintenance',
        labelKey: 'nav.maintenance',
        path: '/sites/maintenance',
        icon: 'settings',
      },
      { id: 'sites-harvest', labelKey: 'nav.harvest', path: '/sites/harvest' },
      { id: 'sites-reports', labelKey: 'nav.reports', path: '/sites/reports' },
      {
        id: 'sites-finance',
        labelKey: 'nav.finance',
        path: '/sites/finance',
        icon: 'analytics',
        requiredRoles: ['SUPER_ADMIN', 'TENANT_ADMIN', 'MODULE_MANAGER'],
      },
      {
        id: 'sites-analytics',
        labelKey: 'nav.analytics',
        path: '/sites/analytics',
        icon: 'analytics',
      },
    ],
  },
  sensor: {
    id: 'sensor-module',
    labelKey: 'nav.sensorMonitoring',
    icon: 'sensor',
    children: [
      { id: 'sensor-dashboard', labelKey: 'nav.dashboard', path: '/sensor' },
      { id: 'sensor-devices', labelKey: 'nav.devices', path: '/sensor/devices' },
      { id: 'sensor-readings', labelKey: 'nav.readings', path: '/sensor/readings' },
      { id: 'sensor-alerts', labelKey: 'nav.alerts', path: '/sensor/alerts' },
      {
        id: 'sensor-water-chemistry',
        labelKey: 'nav.waterChemistry',
        path: '/sensor/water-chemistry',
      },
      {
        id: 'sensor-automation',
        labelKey: 'nav.automation',
        path: '/sensor/automation',
        icon: 'cpu',
      },
      { id: 'sensor-plc', labelKey: 'nav.plcControl', path: '/sensor/plc', icon: 'server' },
      {
        id: 'sensor-plc-connections',
        labelKey: 'nav.plcConnections',
        path: '/sensor/plc/connections',
        icon: 'wifi',
      },
      {
        id: 'sensor-plc-feeding',
        labelKey: 'nav.feedingParams',
        path: '/sensor/plc/feeding',
        icon: 'bar-chart',
      },
      {
        id: 'sensor-plc-alarms',
        labelKey: 'nav.plcAlarms',
        path: '/sensor/plc/alarms',
        icon: 'bell',
      },
      { id: 'sensor-processes', labelKey: 'nav.processEditor', path: '/sensor/processes' },
      {
        id: 'sensor-scada',
        labelKey: 'nav.scadaPackages',
        path: '/sensor/scada-packages',
        icon: 'monitor',
      },
    ],
  },
  hr: {
    id: 'hr-module',
    labelKey: 'nav.humanResources',
    icon: 'users',
    children: [
      { id: 'hr-dashboard', labelKey: 'nav.dashboard', path: '/hr' },
      { id: 'hr-employees', labelKey: 'nav.employees', path: '/hr/employees' },
      { id: 'hr-departments', labelKey: 'nav.departments', path: '/hr/departments' },
      { id: 'hr-scheduling', labelKey: 'nav.scheduling', path: '/hr/scheduling', icon: 'calendar' },
      { id: 'hr-crew', labelKey: 'nav.crew', path: '/hr/crew', icon: 'users' },
      { id: 'hr-attendance', labelKey: 'nav.attendance', path: '/hr/attendance' },
      { id: 'hr-leaves', labelKey: 'nav.leaves', path: '/hr/leaves', icon: 'calendar-off' },
      { id: 'hr-training', labelKey: 'nav.training', path: '/hr/training', icon: 'graduation-cap' },
      { id: 'hr-payroll', labelKey: 'nav.payroll', path: '/hr/payroll' },
      {
        id: 'hr-finance',
        labelKey: 'nav.finance',
        path: '/hr/finance',
        icon: 'analytics',
        requiredRoles: ['SUPER_ADMIN', 'TENANT_ADMIN', 'MODULE_MANAGER'],
      },
    ],
  },
  hydroponics: {
    id: 'hydroponics-module',
    labelKey: 'nav.hydroponics',
    icon: 'sprout',
    children: [
      { id: 'hydroponics-setup', labelKey: 'nav.setup', path: '/hydroponics/setup' },
      {
        id: 'hydroponics-general',
        labelKey: 'nav.generalOptions',
        path: '/hydroponics/solution/general_options',
      },
      {
        id: 'hydroponics-water',
        labelKey: 'nav.waterAnalysis',
        path: '/hydroponics/solution/water_analysis',
      },
      {
        id: 'hydroponics-user',
        labelKey: 'nav.userOptions',
        path: '/hydroponics/solution/user_options',
      },
      { id: 'hydroponics-result', labelKey: 'nav.result', path: '/hydroponics/solution/result' },
      {
        id: 'hydroponics-pid-sim',
        labelKey: 'nav.pidSimulator',
        path: '/hydroponics/pid-simulator',
      },
    ],
  },
  // 'process' module removed: no corresponding route exists in App.tsx
};

/**
 * MODULE_MANAGER and MODULE_USER navigation - Module based (English)
 */
const moduleUserBaseNavigation: NavigationDefinition[] = [
  {
    id: 'company',
    labelKey: 'nav.company',
    path: '/sites/company',
    icon: 'building',
  },
  {
    id: 'dashboard',
    labelKey: 'nav.dashboard',
    path: '/dashboard',
    icon: 'dashboard',
  },
  {
    id: 'messaging',
    labelKey: 'nav.messages',
    path: '/messaging',
    icon: 'message',
  },
  {
    id: 'analytics',
    labelKey: 'nav.analytics',
    path: '/analytics',
    icon: 'reports',
  },
  {
    id: 'reports',
    labelKey: 'nav.reports',
    path: '/reports',
    icon: 'reports',
  },
];

// ============================================================================
// Layout Component
// ============================================================================

/** The aside's id — the hamburger's `aria-controls` target. */
const SIDEBAR_ID = 'main-navigation';

const MainLayout: React.FC = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const queryClient = useQueryClient();
  const { user, logout, modules } = useAuthContext();
  const { tenant } = useTenantContext();
  const { t } = useI18n();
  // hasPermission is the resource-permission SSoT (useAuthContext exposes only
  // roles); gates the AI assistant trigger by ai_assistant:use.
  const { hasPermission } = useAuth();

  // Derive primitive role value to avoid callback identity churn on user object refresh
  const userRole = user?.role;

  // Sidebar state: the desktop column's rail mode, and the phone overlay
  // (FE-HIGH-088 — below md the column is off-canvas until the hamburger opens it).
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  // AI assistant drawer (shell-level, accessible from every module).
  const [aiDrawerOpen, setAiDrawerOpen] = useState(false);
  const canUseAiAssistant = hasPermission('ai_assistant:use');

  /**
   * Build module navigation items from tenant's assigned modules.
   * Divider is added only when at least one module has a nav config.
   */
  const moduleNavigationItems = useMemo((): NavigationDefinition[] => {
    if (!modules || modules.length === 0) {
      return [];
    }

    const items: NavigationDefinition[] = [];
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
      { id: 'divider-modules', labelKey: 'nav.modulesDivider', path: '', icon: 'modules' },
      ...items,
    ];
  }, [modules]);

  /**
   * Role-based navigation menu with dynamic modules.
   * Depends on primitive userRole string, not function references.
   */
  const navigationItems = useMemo((): NavigationItem[] => {
    if (userRole === 'SUPER_ADMIN') {
      return localizeNavigation(superAdminNavigation, t);
    }
    if (userRole === 'TENANT_ADMIN') {
      return localizeNavigation([...tenantAdminBaseNavigation, ...moduleNavigationItems], t);
    }
    // MT-HIGH-060 delegation: a non-admin tenant user whose custom role grants a
    // delegatable panel capability sees just those tenant items (Users/Roles/
    // Settings) appended to their normal module nav. hasPermission bypasses
    // admins (handled above) and is fail-closed for everyone else.
    const delegatedTenantItems = tenantAdminBaseNavigation.filter((item) => {
      const cap = DELEGATABLE_TENANT_NAV[item.id];
      return cap !== undefined && hasPermission(cap);
    });
    return localizeNavigation(
      [...moduleUserBaseNavigation, ...delegatedTenantItems, ...moduleNavigationItems],
      t,
    );
  }, [userRole, moduleNavigationItems, hasPermission, t]);

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
    setSidebarCollapsed((prev) => !prev);
  }, []);

  /**
   * Navigation handler
   */
  const handleNavigate = useCallback(
    (path: string) => {
      navigate(path);
    },
    [navigate],
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
  const userMenuItems = useMemo(
    () => [
      {
        label: t('header.myProfile'),
        onClick: () => navigate('/settings/profile'),
      },
      {
        label: t('header.settings'),
        onClick: () => navigate('/settings'),
      },
    ],
    [navigate, t],
  );

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
          <Button
            variant="ghost"
            iconOnly
            onClick={() => setAiDrawerOpen(true)}
            title={t('header.aiAssistant')}
            aria-label={t('header.openAiAssistant')}
            className="text-gray-500 hover:text-primary-600 dark:text-gray-400"
          >
            <Sparkles className="h-5 w-5" />
          </Button>
        )}
        <NotificationPanel />
      </div>
    ),
    [canUseAiAssistant, t],
  );

  /**
   * Logo element — memoized to avoid Sidebar re-renders
   */
  const logoElement = useMemo(
    () => (
      <div className="flex items-center">
        <span className={`text-xl font-bold ${logoColorClass}`}>{logoText}</span>
      </div>
    ),
    [logoColorClass, logoText],
  );

  /**
   * Hamburger — phone widths only. It opens the Sidebar's overlay (the column
   * is off-canvas below md); the column's own toggle handles collapsing on
   * desktop. Memoized to avoid Header re-renders.
   */
  const leftContent = useMemo(
    () => (
      <Button
        variant="ghost"
        iconOnly
        onClick={() => setMobileNavOpen(true)}
        aria-label={t('header.openNavigation')}
        aria-expanded={mobileNavOpen}
        aria-controls={SIDEBAR_ID}
        className="md:hidden text-gray-500 dark:text-gray-400"
      >
        <Menu className="w-6 h-6" aria-hidden="true" />
      </Button>
    ),
    [mobileNavOpen, t],
  );

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-800 flex">
      <SkipToContent />
      <UserLocaleSync />
      {/* Sidebar */}
      <Sidebar
        id={SIDEBAR_ID}
        items={navigationItems}
        activePath={location.pathname}
        collapsed={sidebarCollapsed}
        mobileOpen={mobileNavOpen}
        onMobileOpenChange={setMobileNavOpen}
        onNavigate={handleNavigate}
        onCollapsedChange={handleSidebarToggle}
        theme={theme}
        logo={logoElement}
        userRoles={userRole ? [userRole] : []}
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
          rightContent={notificationPanelElement}
        />
        <ActAsTenantBanner />

        {/* Page Content */}
        <main
          id="main-content"
          tabIndex={-1}
          className="flex-1 p-4 md:p-6 overflow-auto focus:outline-hidden"
        >
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
