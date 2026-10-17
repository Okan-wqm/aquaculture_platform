/**
 * Dashboard Modül Root
 *
 * Module Federation ile expose edilen ana bileşen.
 * İç routing ve context yapılandırmasını içerir.
 */

import React from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { useAuthContext } from '@aquaculture/shared-ui';
import AnalyticsPage from './pages/AnalyticsPage';
import ControlDashboardPage from './pages/ControlDashboardPage';
import GreenhouseDashboardPage from './pages/GreenhouseDashboardPage';
import ProductionDashboardPage from './pages/ProductionDashboardPage';

// ============================================================================
// Auth Guard (DASH-SEC-006: defense-in-depth, not relying solely on shell)
// ============================================================================

const RequireAuth: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { isAuthenticated, isLoading } = useAuthContext();

  if (isLoading) {
    return null;
  }

  if (!isAuthenticated) {
    return <Navigate to="/login" replace />;
  }

  return <>{children}</>;
};

// ============================================================================
// Dashboard Module
// ============================================================================

const DashboardModule: React.FC = () => {
  return (
    <RequireAuth>
      <Routes>
        {/* Each module workspace's own dashboard: Production at the index,
            Control & sensors and Greenhouse below it. */}
        <Route index element={<ProductionDashboardPage />} />
        <Route path="control" element={<ControlDashboardPage />} />
        <Route path="greenhouse" element={<GreenhouseDashboardPage />} />

        {/* Analitik Sayfası */}
        <Route path="analytics" element={<AnalyticsPage />} />

        {/* Bilinmeyen route'ları ana sayfaya yönlendir */}
        <Route path="*" element={<Navigate to="/dashboard" replace />} />
      </Routes>
    </RequireAuth>
  );
};

export default DashboardModule;
