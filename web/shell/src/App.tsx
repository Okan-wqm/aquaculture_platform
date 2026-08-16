/**
 * Shell Application - Main Component
 *
 * Manages routing, layout, and microfrontend integration.
 * Loads remote modules with lazy loading.
 */

import React, { Suspense, lazy, memo } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import {
  useAuthContext,
  PageLoading,
  RouteAnnouncer,
  hasResourcePermission,
  TENANT_PANEL_CAPABILITIES,
} from '@aquaculture/shared-ui';
import { Role, type Role as PlatformRole } from '@platform/identity';
import MainLayout from './layouts/MainLayout';
import AuthLayout from './layouts/AuthLayout';
import LoginPage from './pages/LoginPage';
import SettingsPage from './pages/SettingsPage';
import NotFoundPage from './pages/NotFoundPage';
import ErrorBoundary from './components/ErrorBoundary';
import RemoteModuleLoader from './components/RemoteModuleLoader';

// ============================================================================
// Lazy Loaded Remote Modules
// ============================================================================

/**
 * Dashboard module (Remote)
 */
const DashboardModule = lazy(() => import('dashboard/Module'));

/**
 * Farm module (Remote)
 */
const FarmModule = lazy(() => import('farmModule/Module'));

/**
 * HR module (Remote)
 */
const HRModule = lazy(() => import('hrModule/Module'));

/**
 * Sensor module (Remote)
 */
const SensorModule = lazy(() => import('sensorModule/Module'));

/**
 * Hydroponics module (Remote)
 */
const HydroponicsModule = lazy(() => import('hydroponicsModule/Module'));
const MessagingModule = lazy(() => import('messagingModule/Module'));

/**
 * Admin Panel module (Remote) - SUPER_ADMIN Only
 */
const AdminPanelModule = lazy(() => import('adminPanel/Module'));

/**
 * Tenant Admin module (Remote) - TENANT_ADMIN Only
 */
const TenantAdminModule = lazy(() => import('tenantAdmin/Module'));

// ============================================================================
// Route Guard Component
// ============================================================================

interface ProtectedRouteProps {
  children: React.ReactNode;
  requiredRoles?: readonly PlatformRole[];
  // MT-HIGH-060 delegation: any-of tenant-RBAC capabilities that also satisfy
  // this route. A user passes if they hold a required ROLE *or* a required
  // CAPABILITY — letting a tenant admin delegate panel access to a custom role.
  requiredCapabilities?: readonly string[];
  requiredModule?: string;
}

/**
 * Protected route component
 * Handles authentication and role checks
 */
const ProtectedRoute: React.FC<ProtectedRouteProps> = memo(({ children, requiredRoles, requiredCapabilities, requiredModule }) => {
  const { isAuthenticated, isLoading, user, isSuperAdmin, hasRoleOrHigher, hasModuleAccess } = useAuthContext();

  // Loading state
  if (isLoading) {
    return <PageLoading text="Checking session..." />;
  }

  // Authentication required
  if (!isAuthenticated) {
    return <Navigate to="/login" replace />;
  }

  // SECURITY: Block MOBILE_ONLY users from web panel
  if (user?.accessType === 'MOBILE_ONLY') {
    return <Navigate to="/unauthorized" replace />;
  }

  // Authorization — a user passes if they hold a required ROLE (via hierarchy, so
  // SUPER_ADMIN reaches TENANT_ADMIN routes) OR a required tenant-RBAC CAPABILITY
  // (delegation, MT-HIGH-060). Fail-closed: when either requirement is declared
  // and neither is satisfied, deny.
  if ((requiredRoles?.length ?? 0) > 0 || (requiredCapabilities?.length ?? 0) > 0) {
    const hasRequiredRole =
      requiredRoles?.some((role) => hasRoleOrHigher(role)) ?? false;
    const hasRequiredCapability =
      requiredCapabilities?.some((cap) => hasResourcePermission(user, cap)) ?? false;
    if (!hasRequiredRole && !hasRequiredCapability) {
      return <Navigate to="/unauthorized" replace />;
    }
  }

  // Module access check — SUPER_ADMIN bypasses (system-level access)
  if (requiredModule && !isSuperAdmin()) {
    if (!hasModuleAccess(requiredModule)) {
      return <Navigate to="/unauthorized" replace />;
    }
  }

  // Tenant check - SUPER_ADMIN doesn't need a tenant
  if (!user?.tenantId && !isSuperAdmin()) {
    return <Navigate to="/unauthorized" replace />;
  }

  return <>{children}</>;
});

/**
 * Role-based redirect component
 * Redirects users to their appropriate dashboard based on role
 */
const RoleBasedRedirect: React.FC = () => {
  const { user, isLoading, isAuthenticated } = useAuthContext();

  if (isLoading) {
    return <PageLoading text="Redirecting..." />;
  }

  if (!isAuthenticated || !user) {
    return <Navigate to="/login" replace />;
  }

  switch (user.role) {
    case Role.SUPER_ADMIN:
      return <Navigate to="/admin" replace />;
    case Role.TENANT_ADMIN:
      return <Navigate to="/tenant" replace />;
    default:
      return <Navigate to="/dashboard" replace />;
  }
};

// ============================================================================
// Main Application Component
// ============================================================================

const App: React.FC = () => {
  return (
    <>
    {/* FE-HIGH-017: Announce route changes to screen readers */}
    <RouteAnnouncer />
    <Routes>
      {/* ================================================================ */}
      {/* Auth Routes (Public) */}
      {/* ================================================================ */}
      <Route element={<AuthLayout />}>
        <Route path="/login" element={<LoginPage />} />
        {/* Registration is invitation-only — redirect /register to /login */}
        <Route path="/register" element={<Navigate to="/login" replace />} />
        <Route path="/forgot-password" element={<LoginPage isForgotPassword />} />
        <Route path="/reset-password/:token" element={<LoginPage isResetPassword />} />
        <Route path="/accept-invitation/:token" element={<LoginPage isAcceptInvitation />} />
      </Route>

      {/* ================================================================ */}
      {/* Protected Routes */}
      {/* ================================================================ */}
      <Route
        element={
          <ProtectedRoute>
            <MainLayout />
          </ProtectedRoute>
        }
      >
        {/* Home - Role-based redirect to appropriate dashboard */}
        <Route path="/" element={<RoleBasedRedirect />} />

        {/* Dashboard Module */}
        <Route
          path="/dashboard/*"
          element={
            <ErrorBoundary moduleName="Dashboard">
              <Suspense fallback={<RemoteModuleLoader moduleName="Dashboard" />}>
                <DashboardModule />
              </Suspense>
            </ErrorBoundary>
          }
        />

        {/* Sites Module (formerly Farm) */}
        <Route
          path="/sites/*"
          element={
            <ProtectedRoute requiredModule="farm">
              <ErrorBoundary moduleName="Sites">
                <Suspense fallback={<RemoteModuleLoader moduleName="Sites" />}>
                  <FarmModule />
                </Suspense>
              </ErrorBoundary>
            </ProtectedRoute>
          }
        />

        {/* HR Module */}
        <Route
          path="/hr/*"
          element={
            <ProtectedRoute requiredModule="hr">
              <ErrorBoundary moduleName="HR">
                <Suspense fallback={<RemoteModuleLoader moduleName="HR" />}>
                  <HRModule />
                </Suspense>
              </ErrorBoundary>
            </ProtectedRoute>
          }
        />

        {/* Sensor Module */}
        <Route
          path="/sensor/*"
          element={
            <ProtectedRoute requiredModule="sensor">
              <ErrorBoundary moduleName="Sensor">
                <Suspense fallback={<RemoteModuleLoader moduleName="Sensor" />}>
                  <SensorModule />
                </Suspense>
              </ErrorBoundary>
            </ProtectedRoute>
          }
        />

        {/* Hydroponics Module */}
        <Route
          path="/hydroponics/*"
          element={
            <ProtectedRoute requiredModule="hydroponics">
              <ErrorBoundary moduleName="Hydroponics">
                <Suspense fallback={<RemoteModuleLoader moduleName="Hydroponics" />}>
                  <HydroponicsModule />
                </Suspense>
              </ErrorBoundary>
            </ProtectedRoute>
          }
        />

        {/* Messaging Module — auth-only (channels are per-user; the backend
            gates channel access), not a tenant-module-gated remote. */}
        <Route
          path="/messaging/*"
          element={
            <ProtectedRoute>
              <ErrorBoundary moduleName="Messaging">
                <Suspense fallback={<RemoteModuleLoader moduleName="Messaging" />}>
                  <MessagingModule />
                </Suspense>
              </ErrorBoundary>
            </ProtectedRoute>
          }
        />

        {/* Admin Panel Module (SUPER_ADMIN Only) */}
        <Route
          path="/admin/*"
          element={
            <ProtectedRoute requiredRoles={[Role.SUPER_ADMIN]}>
              <ErrorBoundary moduleName="Admin Panel">
                <Suspense fallback={<RemoteModuleLoader moduleName="Admin Panel" />}>
                  <AdminPanelModule />
                </Suspense>
              </ErrorBoundary>
            </ProtectedRoute>
          }
        />

        {/* Tenant Admin Module (TENANT_ADMIN Only) */}
        <Route
          path="/tenant/*"
          element={
            <ProtectedRoute requiredRoles={[Role.TENANT_ADMIN]} requiredCapabilities={TENANT_PANEL_CAPABILITIES}>
              <ErrorBoundary moduleName="Tenant Admin">
                <Suspense fallback={<RemoteModuleLoader moduleName="Tenant Admin" />}>
                  <TenantAdminModule />
                </Suspense>
              </ErrorBoundary>
            </ProtectedRoute>
          }
        />

        {/* Settings Page */}
        <Route path="/settings" element={<Navigate to="/settings/profile" replace />} />
        <Route path="/settings/*" element={<SettingsPage />} />
      </Route>

      {/* ================================================================ */}
      {/* Error Routes */}
      {/* ================================================================ */}
      <Route path="/unauthorized" element={<NotFoundPage type="unauthorized" />} />
      <Route path="*" element={<NotFoundPage />} />
    </Routes>
    </>
  );
};

export default App;
