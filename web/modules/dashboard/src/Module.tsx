/**
 * Dashboard Modül Root
 *
 * Module Federation ile expose edilen ana bileşen.
 * İç routing ve context yapılandırmasını içerir.
 */

import React from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { RequireAuth } from '@aquaculture/shared-ui';
import DashboardPage from './pages/DashboardPage';
import AnalyticsPage from './pages/AnalyticsPage';

// DASH-SEC-006: defense-in-depth, not relying solely on the shell. The guard
// family's RequireAuth is the one gate; its session check shows the one
// loading screen (FE-MEDIUM-349) where this module's copy drew nothing.

// ============================================================================
// Dashboard Module
// ============================================================================

const DashboardModule: React.FC = () => {
  return (
    <RequireAuth>
      <Routes>
        {/* Ana Dashboard */}
        <Route index element={<DashboardPage />} />

        {/* Analitik Sayfası */}
        <Route path="analytics" element={<AnalyticsPage />} />

        {/* Bilinmeyen route'ları ana sayfaya yönlendir */}
        <Route path="*" element={<Navigate to="/dashboard" replace />} />
      </Routes>
    </RequireAuth>
  );
};

export default DashboardModule;
