/**
 * HmiPropertiesPanel — right-panel wiring for the unified editor's HMI mode.
 *
 * Mounts the full builder PropertiesPanel (Properties / Events / Animations /
 * Alarms / Control / Trends / Auto / Scripts) bound to the SCADA package
 * store. HMI selection flows through the store's `selectedWidgetId` (the real
 * <ScreenCanvas> writes it via setSelectedWidget), so the panel lights up on
 * canvas selection — unlike the legacy branch, which read the P&ID iframe's
 * processStore selection that ScreenCanvas never sets.
 */

import React from 'react';
import { useShallow } from 'zustand/react/shallow';

import { PropertiesPanel } from '../scada-builder/PropertiesPanel';
import { usePropertiesPanelHandlers } from '../../pages/scada/usePropertiesPanelHandlers';
import { useScadaPackageStore } from '../../store/scada';

export const HmiPropertiesPanel: React.FC = () => {
  const updateControlPermissions = useScadaPackageStore((s) => s.updateControlPermissions);
  const updateTrendConfig = useScadaPackageStore((s) => s.updateTrendConfig);
  const setScripts = useScadaPackageStore((s) => s.setScripts);

  const {
    screens,
    activeScreenId,
    selectedWidgetId,
    selectedEdgeId,
    targetDeviceId,
    alarmRules,
    controlPermissions,
    trendConfig,
    scripts,
  } = useScadaPackageStore(
    useShallow((s) => ({
      screens: s.screens,
      activeScreenId: s.activeScreenId,
      selectedWidgetId: s.selectedWidgetId,
      selectedEdgeId: s.selectedEdgeId,
      targetDeviceId: s.targetDeviceId,
      alarmRules: s.alarmRules,
      controlPermissions: s.controlPermissions,
      trendConfig: s.trendConfig,
      scripts: s.scripts,
    })),
  );

  const {
    selectedWidget,
    selectedEdge,
    handleWidgetConfigChange,
    handleWidgetUpdate,
    handleWidgetEventsChange,
    handleWidgetAnimationsChange,
    handleEdgeDataChange,
    handleEdgeTypeChange,
    handleEdgeDelete,
    handleAlarmRulesChange,
  } = usePropertiesPanelHandlers(
    selectedWidgetId,
    selectedEdgeId,
    activeScreenId,
    screens,
    alarmRules,
  );

  return (
    <PropertiesPanel
      selectedWidget={selectedWidget}
      onWidgetConfigChange={handleWidgetConfigChange}
      onWidgetUpdate={handleWidgetUpdate}
      alarmRules={alarmRules}
      onAlarmRulesChange={handleAlarmRulesChange}
      controlSecurity={controlPermissions.securityLevels}
      onControlSecurityChange={(config) =>
        updateControlPermissions({ ...controlPermissions, securityLevels: config })
      }
      emergencyStop={controlPermissions.emergencyStop ?? undefined}
      onEmergencyStopChange={(config) =>
        updateControlPermissions({ ...controlPermissions, emergencyStop: config })
      }
      trendConfig={trendConfig}
      onTrendConfigChange={updateTrendConfig}
      deviceId={targetDeviceId}
      selectedEdge={selectedEdge}
      onEdgeDataChange={handleEdgeDataChange}
      onEdgeTypeChange={handleEdgeTypeChange}
      onEdgeDelete={handleEdgeDelete}
      onWidgetEventsChange={handleWidgetEventsChange}
      onWidgetAnimationsChange={handleWidgetAnimationsChange}
      scripts={scripts}
      onScriptsChange={setScripts}
    />
  );
};

export default HmiPropertiesPanel;
