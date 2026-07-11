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

import React, { Suspense } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';

// Route Guard (LOW-15: extracted to own component for reuse / unit testing)
import { RequireTenantAdmin, RequireTenantCapability } from './components/common/RequireTenantAdmin';

// Error Boundary
import { PageErrorBoundary } from './components/ErrorBoundary';

// LOW-01: Lazy-loaded pages — each chunk is loaded on-demand to reduce initial bundle size
const TenantDashboard = React.lazy(() => import('./pages/TenantDashboard'));
const TenantUsers = React.lazy(() => import('./pages/TenantUsers'));
const TenantModules = React.lazy(() => import('./pages/TenantModules'));
const TenantSettings = React.lazy(() => import('./pages/TenantSettings'));
const TenantDatabase = React.lazy(() => import('./pages/TenantDatabase'));
const TenantMessagesPage = React.lazy(() => import('./pages/TenantMessagesPage'));
const TenantSupportPage = React.lazy(() => import('./pages/TenantSupportPage'));
const TenantAnnouncementsPage = React.lazy(() => import('./pages/TenantAnnouncementsPage'));
const EdgeDevicesPage = React.lazy(() => import('./pages/EdgeDevicesPage'));
const EdgeDeviceDetailPage = React.lazy(() => import('./pages/EdgeDeviceDetailPage'));
const TenantRolesPage = React.lazy(() => import('./pages/TenantRolesPage'));

// Wave 4 Enterprise Pages (lazy)
const TenantAuditLogPage = React.lazy(() => import('./pages/TenantAuditLogPage'));
const TenantBillingPage = React.lazy(() => import('./pages/TenantBillingPage'));
const TenantActivityPage = React.lazy(() => import('./pages/TenantActivityPage'));

/**
 * Suspense fallback shown while lazy-loaded page chunks are being fetched.
 */
const PageLoadingFallback: React.FC = () => (
  <div className="flex items-center justify-center h-48 text-gray-500 text-sm">
    Loading page...
  </div>
);

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
      <Suspense fallback={<PageLoadingFallback />}>
        <Routes>
          {/*
           * Per-page capability gates (MT-HIGH-060). TENANT_ADMIN bypasses every
           * gate; a delegate reaches only the pages their tenant role grants.
           * Delegatable pages carry a `capability`; all others are `adminOnly`,
           * so a delegate who entered the panel with e.g. `users:view` still
           * cannot open billing/database/audit/etc. (backend enforces too).
           */}
          {/* Dashboard - default route (admin-only) */}
          <Route index element={<RequireTenantCapability adminOnly><PageErrorBoundary pageName="Dashboard"><TenantDashboard /></PageErrorBoundary></RequireTenantCapability>} />

          {/* User Management — delegatable */}
          <Route path="users" element={<RequireTenantCapability capability="users:view"><PageErrorBoundary pageName="Users"><TenantUsers /></PageErrorBoundary></RequireTenantCapability>} />

          {/* Roles & Permissions — delegatable */}
          <Route path="roles" element={<RequireTenantCapability capability="roles:view"><PageErrorBoundary pageName="Roles"><TenantRolesPage /></PageErrorBoundary></RequireTenantCapability>} />

          {/* Tenant Settings — delegatable */}
          <Route path="settings" element={<RequireTenantCapability capability="settings:view"><PageErrorBoundary pageName="Settings"><TenantSettings /></PageErrorBoundary></RequireTenantCapability>} />

          {/* Module Management (admin-only) */}
          <Route path="modules" element={<RequireTenantCapability adminOnly><PageErrorBoundary pageName="Modules"><TenantModules /></PageErrorBoundary></RequireTenantCapability>} />

          {/* Communication (admin-only) */}
          <Route path="messages" element={<RequireTenantCapability adminOnly><PageErrorBoundary pageName="Messages"><TenantMessagesPage /></PageErrorBoundary></RequireTenantCapability>} />
          <Route path="support" element={<RequireTenantCapability adminOnly><PageErrorBoundary pageName="Support"><TenantSupportPage /></PageErrorBoundary></RequireTenantCapability>} />
          <Route path="announcements" element={<RequireTenantCapability adminOnly><PageErrorBoundary pageName="Announcements"><TenantAnnouncementsPage /></PageErrorBoundary></RequireTenantCapability>} />

          {/* Edge Devices (admin-only) */}
          <Route path="devices" element={<RequireTenantCapability adminOnly><PageErrorBoundary pageName="Edge Devices"><EdgeDevicesPage /></PageErrorBoundary></RequireTenantCapability>} />
          <Route path="devices/:deviceId" element={<RequireTenantCapability adminOnly><PageErrorBoundary pageName="Device Detail"><EdgeDeviceDetailPage /></PageErrorBoundary></RequireTenantCapability>} />

          {/* Database View (admin-only) */}
          <Route path="database" element={<RequireTenantCapability adminOnly><PageErrorBoundary pageName="Database"><TenantDatabase /></PageErrorBoundary></RequireTenantCapability>} />

          {/* Wave 4 Enterprise Pages (admin-only) */}
          <Route path="audit-log" element={<RequireTenantCapability adminOnly><PageErrorBoundary pageName="Audit Log"><TenantAuditLogPage /></PageErrorBoundary></RequireTenantCapability>} />
          <Route path="billing" element={<RequireTenantCapability adminOnly><PageErrorBoundary pageName="Billing"><TenantBillingPage /></PageErrorBoundary></RequireTenantCapability>} />
          <Route path="activity" element={<RequireTenantCapability adminOnly><PageErrorBoundary pageName="Activity"><TenantActivityPage /></PageErrorBoundary></RequireTenantCapability>} />

          {/* Catch-all redirect to dashboard */}
          <Route path="*" element={<Navigate to="/tenant" replace />} />
        </Routes>
      </Suspense>
    </RequireTenantAdmin>
  );
};

export default TenantAdminModule;
