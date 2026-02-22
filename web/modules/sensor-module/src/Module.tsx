/**
 * Sensor Module Root
 *
 * Sensor monitoring module main routing component.
 * Includes Process Editor for equipment connection diagrams.
 * Main page is SCADA view with live sensor data.
 */

import React, { Suspense, lazy } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import SensorScadaPage from './pages/SensorScadaPage';
import SensorDashboardPage from './pages/SensorDashboardPage';
import IndustrySetupPage from './pages/IndustrySetupPage';
import DevicesPage from './pages/DevicesPage';
import DeviceDetailPage from './pages/DeviceDetailPage';
import ReadingsPage from './pages/ReadingsPage';
import AlertsPage from './pages/AlertsPage';
import ThresholdsPage from './pages/ThresholdsPage';
import CalibrationPage from './pages/CalibrationPage';
import SensorAnalyticsPage from './pages/SensorAnalyticsPage';
import WidgetDashboardPage from './pages/WidgetDashboardPage';

// Process Editor Pages (lazy loaded - reactflow is heavy and causes Module Federation issues if bundled in main chunk)
const ProcessListPage = lazy(() => import('./pages/process/ProcessListPage'));
const ProcessEditorPage = lazy(() => import('./pages/process/ProcessEditorPage'));
const ProcessTemplatesPage = lazy(() => import('./pages/process/ProcessTemplatesPage'));

// Automation Pages (lazy loaded)
const AutomationProgramsPage = lazy(() => import('./pages/automation/AutomationProgramsPage'));
const AutomationProgramEditorPage = lazy(() => import('./pages/automation/AutomationProgramEditorPage'));

// Loading fallback
function PageLoader() {
  return (
    <div className="flex h-64 items-center justify-center">
      <div className="h-8 w-8 animate-spin rounded-full border-4 border-gray-200 border-t-indigo-600" />
    </div>
  );
}

// ============================================================================
// Sensor Module
// ============================================================================

const SensorModule: React.FC = () => {
  return (
    <Suspense fallback={<PageLoader />}>
      <Routes>
        {/* SCADA View - Main Page */}
        <Route index element={<SensorScadaPage />} />
        <Route path="scada" element={<SensorScadaPage />} />

        {/* Industry Setup */}
        <Route path="setup" element={<IndustrySetupPage />} />

        {/* Dashboard (legacy, optional access) */}
        <Route path="dashboard" element={<SensorDashboardPage />} />

        {/* Widget Dashboard - Customizable widgets */}
        <Route path="widgets" element={<WidgetDashboardPage />} />

        {/* Devices */}
        <Route path="devices" element={<DevicesPage />} />
        <Route path="devices/:deviceId" element={<DeviceDetailPage />} />

        {/* Readings */}
        <Route path="readings" element={<ReadingsPage />} />

        {/* Alerts */}
        <Route path="alerts" element={<AlertsPage />} />

        {/* Thresholds */}
        <Route path="thresholds" element={<ThresholdsPage />} />

        {/* Calibration */}
        <Route path="calibration" element={<CalibrationPage />} />

        {/* Analytics */}
        <Route path="analytics" element={<SensorAnalyticsPage />} />

        {/* Process Editor */}
        <Route path="processes" element={<ProcessListPage />} />
        <Route path="process/new" element={<ProcessEditorPage />} />
        <Route path="process/:processId" element={<ProcessEditorPage />} />
        <Route path="processes/templates" element={<ProcessTemplatesPage />} />

        {/* Automation Programs */}
        <Route path="automation" element={<AutomationProgramsPage />} />
        <Route path="automation/new" element={<AutomationProgramEditorPage />} />
        <Route path="automation/:programId" element={<AutomationProgramEditorPage />} />

        {/* Unknown routes */}
        <Route path="*" element={<Navigate to="/sensor" replace />} />
      </Routes>
    </Suspense>
  );
};

export default SensorModule;
