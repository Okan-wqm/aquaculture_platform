/**
 * Shell Application - Main Component
 *
 * Manages routing, layout, and microfrontend integration.
 * Loads remote modules with lazy loading.
 */

import React, { Suspense, lazy } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { useAuthContext, PageLoading } from '@aquaculture/shared-ui';
import MainLayout from './layouts/MainLayout';
import AuthLayout from './layouts/AuthLayout';
import LoginPage from './pages/LoginPage';
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
  requiredRoles?: string[];
}

/**
 * Protected route component
 * Handles authentication and role checks
 */
const ProtectedRoute: React.FC<ProtectedRouteProps> = ({ children, requiredRoles }) => {
  const { isAuthenticated, isLoading, user, isSuperAdmin } = useAuthContext();

  // Loading state
  if (isLoading) {
    return <PageLoading text="Checking session..." />;
  }

  // Authentication required
  if (!isAuthenticated) {
    return <Navigate to="/login" replace />;
  }

  // Role check
  if (requiredRoles && requiredRoles.length > 0) {
    const hasRequiredRole = requiredRoles.some(role => user?.role === role);
    if (!hasRequiredRole) {
      return <Navigate to="/unauthorized" replace />;
    }
  }

  // Tenant check - SUPER_ADMIN doesn't need a tenant
  if (!user?.tenantId && !isSuperAdmin()) {
    return <Navigate to="/select-tenant" replace />;
  }

  return <>{children}</>;
};

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
    case 'SUPER_ADMIN':
      return <Navigate to="/admin" replace />;
    case 'TENANT_ADMIN':
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
    <Routes>
      {/* ================================================================ */}
      {/* Auth Routes (Public) */}
      {/* ================================================================ */}
      <Route element={<AuthLayout />}>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/register" element={<LoginPage isRegister />} />
        <Route path="/forgot-password" element={<LoginPage isForgotPassword />} />
        <Route path="/reset-password/:token" element={<LoginPage isResetPassword />} />
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
            <ErrorBoundary moduleName="Sites">
              <Suspense fallback={<RemoteModuleLoader moduleName="Sites" />}>
                <FarmModule />
              </Suspense>
            </ErrorBoundary>
          }
        />

        {/* HR Module */}
        <Route
          path="/hr/*"
          element={
            <ErrorBoundary moduleName="HR">
              <Suspense fallback={<RemoteModuleLoader moduleName="HR" />}>
                <HRModule />
              </Suspense>
            </ErrorBoundary>
          }
        />

        {/* Sensor Module */}
        <Route
          path="/sensor/*"
          element={
            <ErrorBoundary moduleName="Sensor">
              <Suspense fallback={<RemoteModuleLoader moduleName="Sensor" />}>
                <SensorModule />
              </Suspense>
            </ErrorBoundary>
          }
        />

        {/* Admin Panel Module (SUPER_ADMIN Only) */}
        <Route
          path="/admin/*"
          element={
            <ProtectedRoute requiredRoles={['SUPER_ADMIN']}>
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
            <ProtectedRoute requiredRoles={['TENANT_ADMIN', 'SUPER_ADMIN']}>
              <ErrorBoundary moduleName="Tenant Admin">
                <Suspense fallback={<RemoteModuleLoader moduleName="Tenant Admin" />}>
                  <TenantAdminModule />
                </Suspense>
              </ErrorBoundary>
            </ProtectedRoute>
          }
        />

        {/* Settings Page */}
        <Route path="/settings/*" element={<div>Settings (TODO)</div>} />
      </Route>

      {/* ================================================================ */}
      {/* Error Routes */}
      {/* ================================================================ */}
      <Route path="/unauthorized" element={<NotFoundPage type="unauthorized" />} />
      <Route path="/select-tenant" element={<div>Tenant Selection (TODO)</div>} />
      <Route path="*" element={<NotFoundPage />} />
    </Routes>
  );
};

export default App;
