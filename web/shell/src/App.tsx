/**
 * Shell Application - Main Component
 *
 * Manages routing, layout, and microfrontend integration.
 * Loads remote modules with lazy loading.
 */

import React, { Suspense, lazy } from 'react';
import { Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { BrandLoader, RouteAnnouncer } from '@aquaculture/shared-ui';
import MainLayout from './layouts/MainLayout';
import { ProtectedRoute } from './routing/ProtectedRoute';
import { RoleBasedRedirect } from './routing/RoleBasedRedirect';
import { TenantPanelRoute } from './routing/TenantPanelRoute';
import AuthLayout from './layouts/AuthLayout';
import LoginPage from './pages/LoginPage';
import SettingsPage from './pages/SettingsPage';
import NotFoundPage from './pages/NotFoundPage';
import ErrorBoundary from './components/ErrorBoundary';

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
// Main Application Component
// ============================================================================

const App: React.FC = () => {
  const { pathname, search } = useLocation();
  return (
    // FE-HIGH-017: the page's identity — the frame each route renders in
    // (ConsoleShell, AdminConsole, the auth forms) names its page through
    // usePageTitle; RouteAnnouncer turns the name into the document title
    // and announces it on every navigation, path or query.
    <RouteAnnouncer location={`${pathname}${search}`}>
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
              <Suspense fallback={<BrandLoader />}>
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
                <Suspense fallback={<BrandLoader />}>
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
                <Suspense fallback={<BrandLoader />}>
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
                <Suspense fallback={<BrandLoader />}>
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
                <Suspense fallback={<BrandLoader />}>
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
                <Suspense fallback={<BrandLoader />}>
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
            <ProtectedRoute requiredRoles={['SUPER_ADMIN']}>
              <ErrorBoundary moduleName="Admin Panel">
                <Suspense fallback={<BrandLoader />}>
                  <AdminPanelModule />
                </Suspense>
              </ErrorBoundary>
            </ProtectedRoute>
          }
        />

        {/* Tenant Admin Module: the company dashboard (index) for every
            member, every other page for TENANT_ADMIN or a panel delegate
            (TenantPanelRoute). */}
        <Route
          path="/tenant/*"
          element={
            <TenantPanelRoute>
              <ErrorBoundary moduleName="Tenant Admin">
                <Suspense fallback={<BrandLoader />}>
                  <TenantAdminModule />
                </Suspense>
              </ErrorBoundary>
            </TenantPanelRoute>
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
    </RouteAnnouncer>
  );
};

export default App;
