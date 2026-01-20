/**
 * Sensor Module Root
 *
 * Sensor monitoring module main routing component.
 * Includes Process Editor for equipment connection diagrams.
 * Main page is SCADA view with live sensor data.
 */

import React from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import SensorScadaPage from './pages/SensorScadaPage';
import SensorDashboardPage from './pages/SensorDashboardPage';
import DevicesPage from './pages/DevicesPage';
import DeviceDetailPage from './pages/DeviceDetailPage';
import ReadingsPage from './pages/ReadingsPage';
import AlertsPage from './pages/AlertsPage';
import ThresholdsPage from './pages/ThresholdsPage';
import CalibrationPage from './pages/CalibrationPage';
import SensorAnalyticsPage from './pages/SensorAnalyticsPage';
import WidgetDashboardPage from './pages/WidgetDashboardPage';

// Process Editor Pages
import ProcessListPage from './pages/process/ProcessListPage';
import ProcessEditorPage from './pages/process/ProcessEditorPage';
import ProcessTemplatesPage from './pages/process/ProcessTemplatesPage';

// ============================================================================
// Sensor Module
// ============================================================================

const SensorModule: React.FC = () => {
  return (
    <Routes>
      {/* SCADA View - Main Page */}
      <Route index element={<SensorScadaPage />} />
      <Route path="scada" element={<SensorScadaPage />} />

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

      {/* Unknown routes */}
      <Route path="*" element={<Navigate to="/sensor" replace />} />
    </Routes>
  );
};

export default SensorModule;
