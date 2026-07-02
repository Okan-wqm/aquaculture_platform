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
import EdgeDeviceDetailPage from './pages/EdgeDeviceDetailPage';
import ReadingsPage from './pages/ReadingsPage';
import AlertsPage from './pages/AlertsPage';
import AlertRulesPage from './pages/AlertRulesPage';
import EscalationPoliciesPage from './pages/EscalationPoliciesPage';
import ThresholdsPage from './pages/ThresholdsPage';
import CalibrationPage from './pages/CalibrationPage';
import SensorAnalyticsPage from './pages/SensorAnalyticsPage';
import WidgetDashboardPage from './pages/WidgetDashboardPage';

// Process Editor Pages (lazy loaded - reactflow is heavy and causes Module Federation issues if bundled in main chunk)
const ProcessListPage = lazy(() => import('./pages/process/ProcessListPage'));
const ProcessEditorPage = lazy(() => import('./pages/process/ProcessEditorPage'));
const ProcessTemplatesPage = lazy(() => import('./pages/process/ProcessTemplatesPage'));

// SCADA Package Pages (lazy loaded)
const ScadaPackageListPage = lazy(() => import('./pages/scada/ScadaPackageListPage'));
const ScadaPackageBuilderPage = lazy(() => import('./pages/scada/ScadaPackageBuilderPage'));
const ScadaOperatorPage = lazy(() => import('./pages/scada/ScadaOperatorPage'));

// Unified SCADA Editor (lazy loaded)
const UnifiedEditorPage = lazy(() => import('./pages/unified/UnifiedEditorPage'));

// Automation Pages (lazy loaded)
const AutomationProgramsPage = lazy(() => import('./pages/automation/AutomationProgramsPage'));
const AutomationProgramEditorPage = lazy(() => import('./pages/automation/AutomationProgramEditorPage'));

// PLC Control Pages (lazy loaded)
const PlcDashboardPage = lazy(() => import('./pages/plc/PlcDashboardPage'));
const PlcConnectionsPage = lazy(() => import('./pages/plc/PlcConnectionsPage'));
const PlcFeedingParamsPage = lazy(() => import('./pages/plc/PlcFeedingParamsPage'));
const PlcAlarmsPage = lazy(() => import('./pages/plc/PlcAlarmsPage'));

// VFD Programming Page (lazy loaded)
const VfdProgrammingPage = lazy(() => import('./pages/VfdProgrammingPage'));

// Water Chemistry Monitoring (lazy — recharts drill-down arrives in P1)
const WaterChemistryMonitoringPage = lazy(
  () => import('./pages/water-chemistry/WaterChemistryMonitoringPage'),
);

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

        {/* Water Chemistry Monitoring (per-scope resolved parameters + provenance) */}
        <Route path="water-chemistry" element={<WaterChemistryMonitoringPage />} />
        <Route path="water-chemistry/:scopeKind/:scopeId" element={<WaterChemistryMonitoringPage />} />


        {/* Devices */}
        <Route path="devices" element={<DevicesPage />} />
        <Route path="devices/:deviceId" element={<DeviceDetailPage />} />
        <Route path="devices/edge/:deviceId" element={<EdgeDeviceDetailPage />} />
        <Route path="devices/edge/:deviceId/config" element={<EdgeDeviceDetailPage />} />

        {/* Readings */}
        <Route path="readings" element={<ReadingsPage />} />

        {/* Alerts */}
        <Route path="alerts" element={<AlertsPage />} />
        <Route path="alert-rules" element={<AlertRulesPage />} />
        <Route path="escalation-policies" element={<EscalationPoliciesPage />} />

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

        {/* SCADA Package Builder */}
        <Route path="scada-packages" element={<ScadaPackageListPage />} />
        <Route path="scada-builder/new" element={<ScadaPackageBuilderPage />} />
        <Route path="scada-builder/:packageId" element={<ScadaPackageBuilderPage />} />

        {/* SCADA Operator Runtime (HMI) */}
        <Route path="scada/operator/:packageId" element={<ScadaOperatorPage />} />

        {/* Unified SCADA Editor */}
        <Route path="unified-editor/new" element={<UnifiedEditorPage />} />
        <Route path="unified-editor/:processId" element={<UnifiedEditorPage />} />

        {/* Automation Programs */}
        <Route path="automation" element={<AutomationProgramsPage />} />
        <Route path="automation/new" element={<AutomationProgramEditorPage />} />
        <Route path="automation/:programId" element={<AutomationProgramEditorPage />} />

        {/* PLC Control */}
        <Route path="plc" element={<PlcDashboardPage />} />
        <Route path="plc/connections" element={<PlcConnectionsPage />} />
        <Route path="plc/feeding" element={<PlcFeedingParamsPage />} />
        <Route path="plc/alarms" element={<PlcAlarmsPage />} />

        {/* VFD Programming */}
        <Route path="vfd-programming" element={<VfdProgrammingPage />} />
        <Route path="vfd-programming/:deviceId" element={<VfdProgrammingPage />} />

        {/* Unknown routes */}
        <Route path="*" element={<Navigate to="/sensor" replace />} />
      </Routes>
    </Suspense>
  );
};

export default SensorModule;
