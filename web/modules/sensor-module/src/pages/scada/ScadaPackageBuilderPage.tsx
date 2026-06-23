/**
 * ScadaPackageBuilderPage - Main SCADA Package Builder with collapsible 3-panel layout
 *
 * Layout:
 *   Toolbar (top) - package name, target device, save, preview, deploy
 *   Left: UnifiedLeftPanel (collapsible, w=240) | Center: ScreenCanvas | Right: PropertiesPanel (collapsible, w=320)
 *   Status bar (bottom)
 *
 * Panel collapse: Ctrl+[ (left), Ctrl+] (right), Ctrl+\ (both)
 * Sub-components: ScadaBuilderToolbar, ScadaBuilderStatusBar, usePropertiesPanelHandlers
 */

import React, { useEffect, useState, useCallback, useMemo } from 'react';
import { useParams, useSearchParams, useNavigate } from 'react-router-dom';
import {
  Loader2,
  GitBranch,
  Layers,
  List,
  Settings,
  Package,
} from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';

import { useScadaPackageStore, type ScadaPackageJSON } from '../../store/scadaPackageStore';
import { ScreenCanvas } from '../../components/scada-builder/ScreenCanvas';
import { PropertiesPanel } from '../../components/scada-builder/PropertiesPanel';
import { DeployScadaDialog } from '../../components/scada-builder/DeployScadaDialog';
import ScreenTabBar from '../../components/scada-builder/ScreenTabBar';
import { ScreenBreadcrumb } from '../../components/scada-builder/ScreenBreadcrumb';
import { UnifiedLeftPanel } from '../../components/scada-builder/UnifiedLeftPanel';
import { CollapsiblePanel, type RailIcon } from '../../components/scada-builder/CollapsiblePanel';
import { usePanelCollapse } from '../../components/scada-builder/usePanelCollapse';
import { usePanelShortcuts } from '../../components/scada-builder/usePanelShortcuts';
import { GlobalAlarmBanner } from '../../components/scada-builder/GlobalAlarmBanner';
import { CsvTagDialog } from '../../components/scada-builder/CsvTagDialog';
import { ScadaBuilderToolbar, type BuilderMode } from './ScadaBuilderToolbar';
import { ScadaBuilderStatusBar } from './ScadaBuilderStatusBar';
import { usePropertiesPanelHandlers } from './usePropertiesPanelHandlers';
import {
  useScadaPackageById,
  useCreateScadaPackage,
  useUpdateScadaPackage,
} from '../../hooks/useScadaPackage';
import { useEdgeDevices } from '../../hooks/useEdgeDevices';
import { useScadaKeyboardShortcuts } from '../../hooks/useScadaKeyboardShortcuts';
import { SimulationSidebar } from '../../components/scada-builder/SimulationSidebar';
import { StableModeProvider } from '../../components/scada-builder/StableModeProvider';
import { ExportDialog } from '../../components/scada-builder/ExportDialog';
import { AQUACULTURE_RAS_DEMO } from '../../store/scada/templates';

const DEFAULT_EMERGENCY_STOP = {
  holdDuration: 3000,
  affectedTags: [] as string[],
  resetRequiresPin: false,
};

const ScadaPackageBuilderPage: React.FC = () => {
  const { packageId: routePackageId } = useParams<{ packageId: string }>();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const processId = searchParams.get('processId');

  const [isSaving, setIsSaving] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [showDeployDialog, setShowDeployDialog] = useState(false);
  const [mode, setMode] = useState<BuilderMode>('edit');
  const [showCsvDialog, setShowCsvDialog] = useState(false);
  const [showExportDialog, setShowExportDialog] = useState(false);
  const deployParam = searchParams.get('deploy');

  // Panel collapse state + keyboard shortcuts (Ctrl+[, Ctrl+], Ctrl+\)
  const panelCollapse = usePanelCollapse();
  usePanelShortcuts(panelCollapse);

  const leftRailIcons: RailIcon[] = useMemo(() => [
    { id: 'scene', icon: <GitBranch className="w-4 h-4" />, label: 'Scene Tree' },
    { id: 'palette', icon: <Layers className="w-4 h-4" />, label: 'Widget Palette' },
    { id: 'layers', icon: <List className="w-4 h-4" />, label: 'Layers' },
  ], []);

  const rightRailIcons: RailIcon[] = useMemo(() => [
    { id: 'properties', icon: <Settings className="w-4 h-4" />, label: 'Properties' },
    { id: 'package', icon: <Package className="w-4 h-4" />, label: 'Package Settings' },
  ], []);

  // ---------------------------------------------------------------------------
  // Performans: 30+ property'li tek selector yerine amac bazli kucuk selector'lar
  // simTagValues gibi sik degisen state, toolbar gibi nadir degisen state'i
  // gereksiz render etmez. Action'lar hic degismez, selector'a gerek yok.
  //
  // Performance: purpose-based small selectors instead of a single 30+ property selector.
  // Frequently changing state (e.g. simTagValues) no longer triggers re-renders
  // for rarely changing UI state (toolbar, screens). Actions never change — no selector needed.
  // ---------------------------------------------------------------------------

  // Stable action references — bunlar Zustand store icinde fonksiyon oldugundan
  // hic degismez, useShallow'a dahil etmek gereksiz karsilastirma maliyeti ekler.
  // Stable action references — these are functions inside Zustand store and never change.
  // Including them in useShallow adds unnecessary comparison overhead.
  const setPackageName = useScadaPackageStore((s) => s.setPackageName);
  const setPackageId = useScadaPackageStore((s) => s.setPackageId);
  const setProcessId = useScadaPackageStore((s) => s.setProcessId);
  const loadFromJSON = useScadaPackageStore((s) => s.loadFromJSON);
  const importProcessAsWidget = useScadaPackageStore((s) => s.importProcessAsWidget);
  const toScadaPackageJSON = useScadaPackageStore((s) => s.toScadaPackageJSON);
  const updateControlPermissions = useScadaPackageStore((s) => s.updateControlPermissions);
  const updateTrendConfig = useScadaPackageStore((s) => s.updateTrendConfig);
  const setTargetDeviceId = useScadaPackageStore((s) => s.setTargetDeviceId);
  const addScreen = useScadaPackageStore((s) => s.addScreen);
  const reset = useScadaPackageStore((s) => s.reset);
  const setSimulationMode = useScadaPackageStore((s) => s.setSimulationMode);
  const setScripts = useScadaPackageStore((s) => s.setScripts);
  // Mimari tutarlılık: isDirty'yi named action üzerinden temizle
  // Architectural consistency: clear isDirty via named action for devtools/middleware visibility
  const markClean = useScadaPackageStore((s) => s.markClean);

  // UI state — nadir degisir (screen switch, mode change, save durumu)
  // UI state — changes rarely (screen switch, mode change, save status)
  const {
    packageId: storePackageId,
    packageName,
    screens,
    activeScreenId,
    selectedWidgetId,
    isDirty,
    targetDeviceId,
    selectedEdgeId,
  } = useScadaPackageStore(
    useShallow((s) => ({
      packageId: s.packageId,
      packageName: s.packageName,
      screens: s.screens,
      activeScreenId: s.activeScreenId,
      selectedWidgetId: s.selectedWidgetId,
      isDirty: s.isDirty,
      targetDeviceId: s.targetDeviceId,
      selectedEdgeId: s.selectedEdgeId,
    })),
  );

  // Properties panel state — sadece sag panel acikken gerekli
  // Properties panel state — only needed when the right panel is open
  const { alarmRules, controlPermissions, trendConfig, scripts } = useScadaPackageStore(
    useShallow((s) => ({
      alarmRules: s.alarmRules,
      controlPermissions: s.controlPermissions,
      trendConfig: s.trendConfig,
      scripts: s.scripts,
    })),
  );

  // Properties panel handlers (widget/edge/alarm)
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

  // Effective packageId (from route or store)
  const effectivePackageId = routePackageId && routePackageId !== 'new' ? routePackageId : storePackageId;

  // Reset store when navigating to a new package
  useEffect(() => {
    if (routePackageId === 'new') {
      reset();
    }
  }, [routePackageId, reset]);

  // Warn before unloading when there are unsaved changes
  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      if (isDirty) {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [isDirty]);

  // Load existing package
  const { scadaPackage, loading: loadingPackage } = useScadaPackageById(
    routePackageId && routePackageId !== 'new' ? routePackageId : undefined,
  );

  // Mutations
  const createMutation = useCreateScadaPackage();
  const updateMutation = useUpdateScadaPackage();

  // Edge devices for target device selector
  const { data: deviceConnection } = useEdgeDevices({ limit: 50 });
  const devices = deviceConnection?.items || [];

  const selectedDevice = useMemo(
    () => devices.find((d) => d.id === targetDeviceId) || null,
    [devices, targetDeviceId],
  );

  // Load package data when fetched
  useEffect(() => {
    if (scadaPackage && routePackageId && routePackageId !== 'new') {
      setPackageId(scadaPackage.id);
      setPackageName(scadaPackage.name);
      if (scadaPackage.packageData) {
        loadFromJSON(scadaPackage.packageData as unknown as ScadaPackageJSON);
      }
    }
  }, [scadaPackage, routePackageId, setPackageId, setPackageName, loadFromJSON]);

  // Auto-open deploy dialog when ?deploy=true and package is loaded
  useEffect(() => {
    if (deployParam === 'true' && effectivePackageId && !loadingPackage) {
      setShowDeployDialog(true);
    }
  }, [deployParam, effectivePackageId, loadingPackage]);

  // Import from process on mount
  useEffect(() => {
    if (routePackageId === 'new' && processId) {
      setProcessId(processId);
      importProcessAsWidget({ id: processId, name: 'Process', nodes: [], edges: [] });
    }
  }, [routePackageId, processId, setProcessId, importProcessAsWidget]);

  // Ensure there's at least one screen (guard against loading race condition)
  useEffect(() => {
    if (screens.length === 0 && !loadingPackage) {
      addScreen('dashboard', 'Screen 1');
    }
  }, [screens.length, addScreen, loadingPackage]);

  // Save handler
  const handleSave = useCallback(async () => {
    if (!packageName.trim()) return;
    setIsSaving(true);
    setSaveSuccess(false);
    setSaveError(null);
    try {
      const packageData = toScadaPackageJSON();
      if (effectivePackageId) {
        // Update existing
        await updateMutation.mutateAsync({
          id: effectivePackageId,
          input: {
            name: packageName,
            packageData,
          },
        });
      } else {
        // Create new
        const result = await createMutation.mutateAsync({
          name: packageName,
          processId: processId || undefined,
          packageData,
        });
        setPackageId(result.id);
        navigate(`/sensor/scada-builder/${result.id}`, { replace: true });
      }
      // Mark store as clean after successful save
      // Named action: devtools ve middleware isDirty geçişini izleyebilir
      // Named action: devtools and middleware can observe isDirty transition
      markClean();
      setSaveSuccess(true);
      setTimeout(() => setSaveSuccess(false), 2000);
    } catch (err) {
      console.error('Save failed:', err);
      setSaveError('Save failed. Please try again.');
      setTimeout(() => setSaveError(null), 5000);
    } finally {
      setIsSaving(false);
    }
  }, [packageName, effectivePackageId, toScadaPackageJSON, updateMutation, createMutation, processId, setPackageId, navigate, markClean]);

  // Keyboard shortcuts (Ctrl+Z/Y, Ctrl+C/V/X, Del, Ctrl+S, Esc)
  useScadaKeyboardShortcuts({
    onSave: handleSave,
    isPreview: mode !== 'edit',
  });

  // Deploy handler - ensure save first
  const handleDeployClick = useCallback(async () => {
    if (!effectivePackageId || isDirty) {
      await handleSave();
    }
    setShowDeployDialog(true);
  }, [effectivePackageId, isDirty, handleSave]);

  // Mode change handler — syncs simulation mode with store
  const handleModeChange = useCallback((newMode: BuilderMode) => {
    setMode(newMode);
    setSimulationMode(newMode === 'simulation');
  }, [setSimulationMode]);

  // Load demo template handler — replaces current package data with built-in RAS demo
  const handleLoadDemo = useCallback(() => {
     
    if (isDirty && !confirm('Loading the demo template will replace your current work. Continue?')) {
      return;
    }
    loadFromJSON(AQUACULTURE_RAS_DEMO);
    setPackageName(AQUACULTURE_RAS_DEMO.meta?.packageName ?? 'RAS Demo');
  }, [isDirty, loadFromJSON, setPackageName]);

  // Screen summaries for status bar
  const screenSummaries = useMemo(() => screens.map((s) => ({
    id: s.id,
    name: s.name,
    widgetCount: s.widgets.length,
    edgeCount: s.edges.length,
    alarmWidgetCount: s.widgets.filter(
      (w) => w.widgetType === 'alarmBanner' || w.widgetType === 'alarmList',
    ).length,
  })), [screens]);

  // Loading state
  if (loadingPackage && routePackageId && routePackageId !== 'new') {
    return (
      <div className="flex items-center justify-center h-screen bg-gray-100">
        <div className="text-center">
          <Loader2 className="w-8 h-8 animate-spin text-cyan-600 mx-auto" />
          <p className="mt-2 text-sm text-gray-500">Loading package...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-screen bg-gray-100">
      {/* Toolbar */}
      <ScadaBuilderToolbar
        packageName={packageName}
        onPackageNameChange={setPackageName}
        isDirty={isDirty}
        isSaving={isSaving}
        saveSuccess={saveSuccess}
        saveError={saveError}
        onSave={handleSave}
        mode={mode}
        onModeChange={handleModeChange}
        onDeployClick={handleDeployClick}
        targetDeviceId={targetDeviceId}
        onTargetDeviceChange={setTargetDeviceId}
        selectedDevice={selectedDevice}
        devices={devices}
        onCsvDialogOpen={() => setShowCsvDialog(true)}
        onExportDialogOpen={() => setShowExportDialog(true)}
        onLoadDemo={handleLoadDemo}
      />

      {/* Main Content */}
      <div className="flex-1 flex overflow-hidden">
        {/* Left Panel — Unified: Scene Tree + Widget Palette + Layers (hidden in preview/simulation) */}
        {mode === 'edit' && (
          <CollapsiblePanel
            side="left"
            collapsed={panelCollapse.leftCollapsed}
            onToggle={panelCollapse.toggleLeft}
            width={240}
            railIcons={leftRailIcons}
          >
            <UnifiedLeftPanel />
          </CollapsiblePanel>
        )}

        {/* Center - Canvas with Screen Tabs */}
        <div className="flex-1 flex flex-col overflow-hidden">
          {/* Global Alarm Banner */}
          <GlobalAlarmBanner />

          {/* Screen tabs - using ScreenTabBar component */}
          <ScreenTabBar />

          {/* Breadcrumb navigation for nested screens */}
          <ScreenBreadcrumb />

          {/* Canvas — single stable instance, data provider switches internally
               to prevent unmount/remount that would destroy ReactFlow drag positions */}
          <div className="flex-1 flex flex-col">
            <StableModeProvider
              mode={mode}
              deviceCode={selectedDevice?.deviceCode ?? null}
            >
              <ScreenCanvas
                isPreview={mode !== 'edit'}
                deviceCode={
                  mode === 'simulation'
                    ? '__sim__'
                    : mode === 'preview' && selectedDevice?.deviceCode
                      ? selectedDevice.deviceCode
                      : undefined
                }
              />
            </StableModeProvider>
          </div>
        </div>

        {/* Right Panel — Collapsible: SimulationSidebar or PropertiesPanel */}
        <CollapsiblePanel
          side="right"
          collapsed={panelCollapse.rightCollapsed}
          onToggle={panelCollapse.toggleRight}
          width={320}
          railIcons={rightRailIcons}
        >
          {mode === 'simulation' ? (
            <SimulationSidebar />
          ) : (
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
              emergencyStop={controlPermissions.emergencyStop || DEFAULT_EMERGENCY_STOP}
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
              onTestScript={(scriptId) => {
                // Phase 5B placeholder: the ScriptExecutor sandbox from Phase 5A
                // will handle actual execution; this currently logs to console.
                console.log('[SCADA] Test script:', scriptId);
              }}
            />
          )}
        </CollapsiblePanel>
      </div>

      {/* Accessibility: live region for selection announcements */}
      <div className="sr-only" aria-live="polite" aria-atomic="true">
        {selectedWidgetId
          ? `Widget selected: ${selectedWidget?.name || selectedWidget?.type}`
          : 'No widget selected'}
      </div>

      {/* Status Bar */}
      <ScadaBuilderStatusBar
        screens={screenSummaries}
        activeScreenId={activeScreenId}
        mode={mode}
        selectedDeviceName={selectedDevice?.deviceName ?? null}
      />

      {/* Deploy Dialog */}
      {showDeployDialog && effectivePackageId && (
        <DeployScadaDialog
          packageId={effectivePackageId}
          packageName={packageName}
          packageData={toScadaPackageJSON()}
          isOpen={showDeployDialog}
          onClose={() => setShowDeployDialog(false)}
        />
      )}

      {/* CSV Tag Import/Export Dialog */}
      <CsvTagDialog open={showCsvDialog} onClose={() => setShowCsvDialog(false)} />

      {/* PNG/PDF Export Dialog */}
      <ExportDialog isOpen={showExportDialog} onClose={() => setShowExportDialog(false)} />
    </div>
  );
};

export default ScadaPackageBuilderPage;
