/**
 * Tenant Admin Module Root
 *
 * Tenant Admin Panel for managing users, modules, settings, and communication.
 * NOT: Layout is handled by Shell's MainLayout, only page routes defined here.
 *
 * SEC-007: every panel page is wrapped with the RequireTenantAdmin guard for
 * defense-in-depth. The shell checks TENANT_ADMIN or a panel capability at
 * /tenant/* (TenantPanelRoute), and this module-internal guard prevents a
 * MODULE_USER/MODULE_MANAGER without one from seeing the tenant admin UI even
 * if the shell guard is bypassed or misconfigured. The one exception is the
 * company dashboard (the index): every member opens it (RequireTenantMember),
 * and CompanyHome shows the account's cards only to a tenant admin.
 */

import { BrandLoader } from '@aquaculture/shared-ui';
import React, { Suspense } from 'react';
import { Routes, Route, Navigate, Outlet } from 'react-router-dom';

// Route Guard (LOW-15: extracted to own component for reuse / unit testing)
import {
  RequireTenantAdmin,
  RequireTenantCapability,
  RequireTenantMember,
} from './components/common/RequireTenantAdmin';

// Error Boundary
import { PageErrorBoundary } from './components/ErrorBoundary';

// LOW-01: Lazy-loaded pages — each chunk is loaded on-demand to reduce initial bundle size
const CompanyHome = React.lazy(() => import('./pages/CompanyHome'));
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

// Platform reference documents (static content, no data source)
const PlatformArchitecturePage = React.lazy(() => import('./pages/PlatformArchitecturePage'));
const ArchitectureReviewPage = React.lazy(() => import('./pages/ArchitectureReviewPage'));

/**
 * Tenant Admin Module
 *
 * Routes:
 * - /tenant (index) - Company dashboard: the account's cards for a tenant admin,
 *   a member's own notices for anyone else
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
 * - /tenant/architecture - Platform architecture v4 reference document
 * - /tenant/architecture/review - End-to-end review of the architecture
 */
const TenantAdminModule: React.FC = () => {
  return (
    // A page chunk loading is the one loading screen (FE-MEDIUM-349).
    <Suspense fallback={<BrandLoader />}>
      <Routes>
        {/* Company dashboard — every tenant member (CompanyHome decides what
            each sees); the one route outside the panel gate below. */}
        <Route index element={<RequireTenantMember><PageErrorBoundary pageName="Dashboard"><CompanyHome /></PageErrorBoundary></RequireTenantMember>} />

        {/* Every other page: TENANT_ADMIN or a panel delegate (SEC-007), then
            the page's own capability gate. */}
        <Route
          element={
            <RequireTenantAdmin>
              <Outlet />
            </RequireTenantAdmin>
          }
        >
          {/*
           * Per-page capability gates (MT-HIGH-060). TENANT_ADMIN bypasses every
           * gate; a delegate reaches only the pages their tenant role grants.
           * Delegatable pages carry a `capability`; all others are `adminOnly`,
           * so a delegate who entered the panel with e.g. `users:view` still
           * cannot open billing/database/audit/etc. (backend enforces too).
           */}
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

          {/* Platform reference documents (admin-only, static) */}
          <Route path="architecture" element={<RequireTenantCapability adminOnly><PageErrorBoundary pageName="Platform Architecture"><PlatformArchitecturePage /></PageErrorBoundary></RequireTenantCapability>} />
          <Route path="architecture/review" element={<RequireTenantCapability adminOnly><PageErrorBoundary pageName="Architecture Review"><ArchitectureReviewPage /></PageErrorBoundary></RequireTenantCapability>} />

          {/* Catch-all redirect to dashboard */}
          <Route path="*" element={<Navigate to="/tenant" replace />} />
        </Route>
      </Routes>
    </Suspense>
  );
};

export default TenantAdminModule;
