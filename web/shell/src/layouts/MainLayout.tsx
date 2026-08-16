/**
 * Main Layout Component
 *
 * Main page layout for authenticated users.
 * Manages Header, Sidebar and content area.
 * Supports role-based navigation with dynamic module loading.
 */

import {
  buildSuperAdminNavigation,
  Header,
  MODULE_USER_BASE_NAVIGATION,
  PLATFORM_MODULE_NAVIGATION,
  Sidebar,
  TENANT_ADMIN_NAVIGATION,
  createTenantInvalidationKey,
  type NavigationItem,
  type SidebarTheme,
  useAuthContext,
  useAuth,
  useTenantContext,
} from '@aquaculture/shared-ui';
import { Sparkles } from 'lucide-react';
import { Role } from '@platform/identity';
import AiAssistantDrawer from '../components/ai/AiAssistantDrawer';
import { useQueryClient } from '@tanstack/react-query';
import React, { useState, useCallback, useMemo } from 'react';
import { Outlet, useNavigate, useLocation } from 'react-router-dom';

import ConsentBanner from '../components/ConsentBanner';

import { NotificationPanel } from '@/components/NotificationPanel';

// ============================================================================
// Navigation Configuration - Role Based
// ============================================================================

/** SUPER_ADMIN navigation is a projection of the shared route authority. */
const superAdminNavigation: NavigationItem[] = buildSuperAdminNavigation();


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
      const navConfig = PLATFORM_MODULE_NAVIGATION[module.code];
      if (navConfig) {
        items.push(navConfig);
      }
    }

    if (items.length === 0) {
      return [];
    }

    return [{ id: 'divider-modules', label: '── Modules ──', path: '', icon: 'modules' }, ...items];
  }, [modules]);

  /**
   * Role-based navigation menu with dynamic modules.
   * Depends on primitive userRole string, not function references.
   */
  const navigationItems = useMemo((): NavigationItem[] => {
    if (userRole === Role.SUPER_ADMIN) {
      return superAdminNavigation;
    }
    if (userRole === Role.TENANT_ADMIN) {
      return [...TENANT_ADMIN_NAVIGATION, ...moduleNavigationItems];
    }
    // MT-HIGH-060 delegation: a non-admin tenant user whose custom role grants a
    // delegatable panel capability sees just those tenant items (Users/Roles/
    // Settings) appended to their normal module nav. hasPermission bypasses
    // admins (handled above) and is fail-closed for everyone else.
    const delegatedTenantItems = TENANT_ADMIN_NAVIGATION.filter((item) => {
      const capabilities = item.requiredPermissions ?? [];
      return capabilities.length > 0 && capabilities.every(hasPermission);
    });
    return [...MODULE_USER_BASE_NAVIGATION, ...delegatedTenantItems, ...moduleNavigationItems];
  }, [userRole, moduleNavigationItems, hasPermission]);

  /**
   * Logo text based on role
   */
  const logoText = useMemo(() => {
    if (userRole === Role.SUPER_ADMIN) {
      return 'Aqua Admin';
    }
    if (userRole === Role.TENANT_ADMIN) {
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
    if (userRole === Role.SUPER_ADMIN) {
      return 'admin';
    }
    if (userRole === Role.TENANT_ADMIN) {
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
        label: 'My Profile',
        onClick: () => navigate('/settings/profile'),
      },
      {
        label: 'Settings',
        onClick: () => navigate('/settings'),
      },
    ],
    [navigate],
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
  const logoElement = useMemo(
    () => (
      <div className="flex items-center">
        <span className={`text-xl font-bold ${logoColorClass}`}>{logoText}</span>
      </div>
    ),
    [logoColorClass, logoText],
  );

  /**
   * Sidebar toggle button — memoized to avoid Header re-renders
   */
  const leftContent = useMemo(
    () => (
      <button
        onClick={handleSidebarToggle}
        className="p-2 text-gray-500 hover:text-gray-700 hover:bg-gray-100 rounded-lg md:hidden"
      >
        <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M4 6h16M4 12h16M4 18h16"
          />
        </svg>
      </button>
    ),
    [handleSidebarToggle],
  );

  return (
    <div className="min-h-screen bg-gray-50 flex">
      <a
        href="#main-content"
        className="sr-only fixed left-4 top-4 z-50 rounded bg-white px-4 py-2 text-gray-900 shadow focus:not-sr-only"
      >
        Skip to main content
      </a>
      {/* Sidebar */}
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

        {/* Page Content */}
        <main id="main-content" tabIndex={-1} className="flex-1 p-6 overflow-auto">
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
