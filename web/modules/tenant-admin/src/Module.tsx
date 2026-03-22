/**
 * Tenant Admin Module Root
 *
 * Tenant Admin Panel for managing users, modules, settings, and communication.
 * NOT: Layout is handled by Shell's MainLayout, only page routes defined here.
 *
 * SEC-007: All routes are wrapped with RequireTenantAdmin guard for defense-in-depth.
 * Shell already checks TENANT_ADMIN at /tenant/* level, but this module-internal
 * guard prevents MODULE_USER/MODULE_MANAGER from seeing the tenant admin UI even
 * if the shell guard is bypassed or misconfigured.
 */

import React from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { useAuthContext } from '@aquaculture/shared-ui';

// Error Boundary
import { PageErrorBoundary } from './components/ErrorBoundary';

// Pages
import TenantDashboard from './pages/TenantDashboard';
import TenantUsers from './pages/TenantUsers';
import TenantModules from './pages/TenantModules';
import TenantSettings from './pages/TenantSettings';
import TenantDatabase from './pages/TenantDatabase';
import TenantMessagesPage from './pages/TenantMessagesPage';
import TenantSupportPage from './pages/TenantSupportPage';
import TenantAnnouncementsPage from './pages/TenantAnnouncementsPage';
import EdgeDevicesPage from './pages/EdgeDevicesPage';
import EdgeDeviceDetailPage from './pages/EdgeDeviceDetailPage';
import TenantRolesPage from './pages/TenantRolesPage';

// Wave 4 Enterprise Pages
import TenantAuditLogPage from './pages/TenantAuditLogPage';
import TenantBillingPage from './pages/TenantBillingPage';
import TenantActivityPage from './pages/TenantActivityPage';

// ============================================================================
// Route Guard (SEC-007: defense-in-depth, module-level RBAC)
// ============================================================================

/**
 * RequireTenantAdmin - route-level guard for all tenant admin pages.
 *
 * Uses hasRoleOrHigher so that SUPER_ADMIN also passes (role hierarchy).
 * Redirects unauthorized users to /unauthorized rather than showing the UI.
 */
const RequireTenantAdmin: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { hasRoleOrHigher, isAuthenticated, isLoading } = useAuthContext();

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-48 text-gray-500 text-sm">
        Checking session...
      </div>
    );
  }

  if (!isAuthenticated) {
    return <Navigate to="/login" replace />;
  }

  if (!hasRoleOrHigher('TENANT_ADMIN')) {
    return <Navigate to="/unauthorized" replace />;
  }

  return <>{children}</>;
};

/**
 * Tenant Admin Module
 *
 * Routes:
 * - /tenant (index) - Dashboard with stats and modules overview
 * - /tenant/users - User management for tenant
 * - /tenant/modules - Module assignments and manager assignment
 * - /tenant/messages - Messages with platform support
 * - /tenant/support - Support ticket management
 * - /tenant/announcements - Platform announcements
 * - /tenant/settings - Tenant settings and configuration
 * - /tenant/database - View tenant database information
 * - /tenant/audit-log - Audit log viewer (Wave 4)
 * - /tenant/billing - Subscription & billing overview (Wave 4, read-only)
 * - /tenant/activity - User activity dashboard (Wave 4)
 */
const TenantAdminModule: React.FC = () => {
  return (
    <RequireTenantAdmin>
      <Routes>
        {/* Dashboard - default route */}
        <Route index element={<PageErrorBoundary pageName="Dashboard"><TenantDashboard /></PageErrorBoundary>} />

        {/* User Management */}
        <Route path="users" element={<PageErrorBoundary pageName="Users"><TenantUsers /></PageErrorBoundary>} />

        {/* Module Management */}
        <Route path="modules" element={<PageErrorBoundary pageName="Modules"><TenantModules /></PageErrorBoundary>} />

        {/* Communication */}
        <Route path="messages" element={<PageErrorBoundary pageName="Messages"><TenantMessagesPage /></PageErrorBoundary>} />
        <Route path="support" element={<PageErrorBoundary pageName="Support"><TenantSupportPage /></PageErrorBoundary>} />
        <Route path="announcements" element={<PageErrorBoundary pageName="Announcements"><TenantAnnouncementsPage /></PageErrorBoundary>} />

        {/* Tenant Settings */}
        <Route path="settings" element={<PageErrorBoundary pageName="Settings"><TenantSettings /></PageErrorBoundary>} />

        {/* Edge Devices */}
        <Route path="devices" element={<PageErrorBoundary pageName="Edge Devices"><EdgeDevicesPage /></PageErrorBoundary>} />
        <Route path="devices/:deviceId" element={<PageErrorBoundary pageName="Device Detail"><EdgeDeviceDetailPage /></PageErrorBoundary>} />

        {/* Database View */}
        <Route path="database" element={<PageErrorBoundary pageName="Database"><TenantDatabase /></PageErrorBoundary>} />

        {/* Roles & Permissions */}
        <Route path="roles" element={<PageErrorBoundary pageName="Roles"><TenantRolesPage /></PageErrorBoundary>} />

        {/* Wave 4 Enterprise Pages */}
        <Route path="audit-log" element={<PageErrorBoundary pageName="Audit Log"><TenantAuditLogPage /></PageErrorBoundary>} />
        <Route path="billing" element={<PageErrorBoundary pageName="Billing"><TenantBillingPage /></PageErrorBoundary>} />
        <Route path="activity" element={<PageErrorBoundary pageName="Activity"><TenantActivityPage /></PageErrorBoundary>} />

        {/* Catch-all redirect to dashboard */}
        <Route path="*" element={<Navigate to="/tenant" replace />} />
      </Routes>
    </RequireTenantAdmin>
  );
};

export default TenantAdminModule;
