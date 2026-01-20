/**
 * Dashboard Modül Root
 *
 * Module Federation ile expose edilen ana bileşen.
 * İç routing ve context yapılandırmasını içerir.
 */

import React from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import DashboardPage from './pages/DashboardPage';
import AnalyticsPage from './pages/AnalyticsPage';

// ============================================================================
// Dashboard Module
// ============================================================================

const DashboardModule: React.FC = () => {
  return (
    <Routes>
      {/* Ana Dashboard */}
      <Route index element={<DashboardPage />} />

      {/* Analitik Sayfası */}
      <Route path="analytics" element={<AnalyticsPage />} />

      {/* Bilinmeyen route'ları ana sayfaya yönlendir */}
      <Route path="*" element={<Navigate to="/dashboard" replace />} />
    </Routes>
  );
};

export default DashboardModule;
