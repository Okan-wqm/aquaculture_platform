/**
 * Dashboard module root — the federated entry the shell mounts at /dashboard/*.
 *
 * WHY each route carries its own module gate (FE-MEDIUM-354):
 * the three dashboards belong to three module workspaces — Production to
 * farm, Control & sensors to sensor, Greenhouse to hydroponics — but the
 * remote is mounted once, so the shell cannot gate it by module. Each route
 * gates itself with the guard family's RequireRole requiredModule (the gate
 * the shell's ProtectedRoute applies to a whole remote; SUPER_ADMIN passes),
 * and the console nav's module table (console/nav/mounts) names the same
 * gates per path, pinned to these routes by the nav-coverage invariant.
 * Trends (analytics) stay open to every member: every module workspace lists
 * them. An unknown path lands on `/`, which sends each member to their own
 * workspace's dashboard — never to a dashboard their tenant lacks.
 */

import React from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { RequireAuth, RequireRole } from '@aquaculture/shared-ui';
import AnalyticsPage from './pages/AnalyticsPage';
import ControlDashboardPage from './pages/ControlDashboardPage';
import GreenhouseDashboardPage from './pages/GreenhouseDashboardPage';
import ProductionDashboardPage from './pages/ProductionDashboardPage';

const DashboardModule: React.FC = () => {
  return (
    // DASH-SEC-006: defense-in-depth — the remote can be instantiated without the shell's guard.
    <RequireAuth>
      <Routes>
        <Route
          index
          element={
            <RequireRole requiredModule="farm">
              <ProductionDashboardPage />
            </RequireRole>
          }
        />
        <Route
          path="control"
          element={
            <RequireRole requiredModule="sensor">
              <ControlDashboardPage />
            </RequireRole>
          }
        />
        <Route
          path="greenhouse"
          element={
            <RequireRole requiredModule="hydroponics">
              <GreenhouseDashboardPage />
            </RequireRole>
          }
        />
        <Route path="analytics" element={<AnalyticsPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </RequireAuth>
  );
};

export default DashboardModule;
