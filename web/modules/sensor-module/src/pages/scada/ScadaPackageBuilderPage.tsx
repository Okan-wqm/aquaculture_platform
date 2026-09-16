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
} from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';

import { useScadaPackageStore, type ScadaPackageJSON } from '../../store/scada';
import { ScreenCanvas } from '../../components/scada-builder/ScreenCanvas';
import { PropertiesPanel } from '../../components/scada-builder/PropertiesPanel';
import { DeployToEdgeDialog } from '../../components/deploy/DeployToEdgeDialog';
import { ScadaPackagePreview } from '../../components/deploy/ScadaPackagePreview';
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
  useDeployScadaPackage,
  usePublishScadaPackage,
} from '../../hooks/useScadaPackage';
import { useEdgeDevices } from '../../hooks/useEdgeDevices';
import { useScadaKeyboardShortcuts } from '../../hooks/useScadaKeyboardShortcuts';
import { SimulationSidebar } from '../../components/scada-builder/SimulationSidebar';
import { StableModeProvider } from '../../components/scada-builder/StableModeProvider';
import { ExportDialog } from '../../components/scada-builder/ExportDialog';
import { AQUACULTURE_RAS_DEMO } from '../../store/scada/templates';
import { decidePackageLoad, shouldAutoAddScreen } from './loadGuard';

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
  const [publishMessage, setPublishMessage] = useState<string | null>(null);
  /** Transient inline notice (e.g. script-test info). Auto-dismisses. */
  const [infoNotice, setInfoNotice] = useState<string | null>(null);
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
  ], []);

  // Left-panel rail wiring: the collapsed rail icons and the expanded panel
  // tabs share ONE active-tab state, so icon ↔ tab stay in sync.
  const [leftPanelTab, setLeftPanelTab] = useState<'scene' | 'palette'>('scene');

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
  const setPackageVersion = useScadaPackageStore((s) => s.setPackageVersion);
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
  const deployMutation = useDeployScadaPackage();
  const publishMutation = usePublishScadaPackage();

  // Edge devices for target device selector
  const { data: deviceConnection } = useEdgeDevices({ limit: 50 });
  const devices = deviceConnection?.items || [];

  const selectedDevice = useMemo(
    () => devices.find((d) => d.id === targetDeviceId) || null,
    [devices, targetDeviceId],
  );

  // Load package data when fetched — ID-BASED LOAD GUARD (data-loss fix):
  //  - same id + dirty store  → never clobber unsaved edits
  //  - different id (A→B or /new→existing) → reset() first (clears screens,
  //    history, clipboard), then load the fetched entity
  //  - the fetch must belong to the current route or it is skipped entirely
  useEffect(() => {
    if (!scadaPackage || !routePackageId || routePackageId === 'new') return;

    const decision = decidePackageLoad({
      routePackageId,
      fetchedPackageId: scadaPackage.id,
      storePackageId,
      isDirty,
    });
    if (decision === 'skip') return;
    if (decision === 'reset-and-load') reset();

    setPackageId(scadaPackage.id);
    setPackageName(scadaPackage.name);
    setPackageVersion(scadaPackage.version ?? 1);
    if (scadaPackage.packageData) {
      loadFromJSON(scadaPackage.packageData as unknown as ScadaPackageJSON, {
        version: scadaPackage.version,
      });
    }
  }, [
    scadaPackage, routePackageId, storePackageId, isDirty,
    setPackageId, setPackageName, setPackageVersion, loadFromJSON, reset,
  ]);

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

  // Ensure there's at least one screen — but ONLY when the empty store
  // actually belongs to this route. Otherwise the effect races a pending
  // package load (loadingPackage just flipped false) and injects a phantom
  // "Screen 1" into a store that is about to be replaced by fetched data.
  useEffect(() => {
    if (screens.length === 0) {
      const autoAdd = shouldAutoAddScreen({
        storePackageId,
        routePackageId: routePackageId ?? null,
        isLoading: loadingPackage,
      });
      if (autoAdd) addScreen('dashboard', 'Screen 1');
    }
  }, [screens.length, addScreen, loadingPackage, storePackageId, routePackageId]);

  // Save handler
  const handleSave = useCallback(async () => {
    // A4/Plan 2: while a package fetch is in flight the store may still hold
    // the PREVIOUS package's document — saving in that window would write A's
    // content into B (effectivePackageId already points at the route target).
    if (loadingPackage) {
      setSaveError('Package is still loading — save blocked.');
      setTimeout(() => setSaveError(null), 5000);
      return false;
    }
    // Visible error instead of a silent no-op when the name is empty
    if (!packageName.trim()) {
      setSaveError('Package name is required before saving.');
      setTimeout(() => setSaveError(null), 5000);
      return false;
    }
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
      return true;
    } catch (err) {
      console.error('Save failed:', err);
      setSaveError('Save failed. Please try again.');
      setTimeout(() => setSaveError(null), 5000);
      return false;
    } finally {
      setIsSaving(false);
    }
  }, [loadingPackage, packageName, effectivePackageId, toScadaPackageJSON, updateMutation, createMutation, processId, setPackageId, navigate, markClean]);

  // Keyboard shortcuts (Ctrl+Z/Y, Ctrl+C/V/X, Del, Ctrl+S, Esc)
  useScadaKeyboardShortcuts({
    onSave: handleSave,
    isPreview: mode !== 'edit',
  });

  // Deploy handler - ensure save first; block the dialog when the save
  // could not complete (e.g. empty package name) instead of deploying nothing
  const handleDeployClick = useCallback(async () => {
    if (!effectivePackageId || isDirty) {
      const saved = await handleSave();
      if (!saved) return;
    }
    setShowDeployDialog(true);
  }, [effectivePackageId, isDirty, handleSave]);

  // Publish to Cloud — saves first (the publish button is disabled while
  // dirty, but keep the save here as a safety net), then publishes and
  // surfaces the returned version.
  const handlePublishToCloud = useCallback(async () => {
    if (isDirty) {
      const saved = await handleSave();
      if (!saved) return;
    }
    if (!effectivePackageId) {
      setPublishMessage('Save the package before publishing.');
      return;
    }
    try {
      const result = await publishMutation.mutateAsync({ id: effectivePackageId });
      setPublishMessage(
        result.success
          ? `Published to cloud${result.version != null ? ` (v${result.version})` : ''}${result.message ? ` — ${result.message}` : ''}`
          : `Publish failed: ${result.message ?? 'unknown error'}`,
      );
    } catch (err) {
      setPublishMessage('Publish failed. Please try again.');
    } finally {
      setTimeout(() => setPublishMessage(null), 6000);
    }
  }, [isDirty, handleSave, effectivePackageId, publishMutation]);

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
        onPublishToCloud={handlePublishToCloud}
        isPublishing={publishMutation.isPending}
        publishMessage={publishMessage}
      />

      {/* Main Content */}
      <div className="flex-1 flex overflow-hidden">
        {/* Left Panel — Unified: Scene Tree + Widget Palette (hidden in preview/simulation) */}
        {mode === 'edit' && (
          <CollapsiblePanel
            side="left"
            collapsed={panelCollapse.leftCollapsed}
            onToggle={panelCollapse.toggleLeft}
            width={240}
            railIcons={leftRailIcons}
            activeRailIcon={leftPanelTab}
            onRailIconClick={(iconId) => {
              if (iconId === 'scene' || iconId === 'palette') setLeftPanelTab(iconId);
            }}
          >
            <UnifiedLeftPanel
              activeTab={leftPanelTab}
              onTabChange={setLeftPanelTab}
            />
          </CollapsiblePanel>
        )}

        {/* Center - Canvas with Screen Tabs */}
        <div className="flex-1 flex flex-col overflow-hidden">
          {/* Global Alarm Banner */}
          <GlobalAlarmBanner liveDataActive={mode === 'preview'} />

          {/* Screen tabs - using ScreenTabBar component */}
          <ScreenTabBar />

          {/* Breadcrumb navigation for nested screens */}
          <ScreenBreadcrumb />

          {/* Canvas — single stable instance, data provider switches internally
               to prevent unmount/remount that would destroy ReactFlow drag positions */}
          <div className="flex-1 flex flex-col">
            <StableModeProvider mode={mode}>
              <ScreenCanvas isPreview={mode !== 'edit'} />
            </StableModeProvider>
          </div>
        </div>

        {/* Right Panel — Collapsible: SimulationSidebar or PropertiesPanel.
            No rail icons (A7/Plan 2): the PropertiesPanel manages its own tab
            state internally, so rail icons that implied tab switching were a
            dead affordance — the collapse toggle alone remains. */}
        <CollapsiblePanel
          side="right"
          collapsed={panelCollapse.rightCollapsed}
          onToggle={panelCollapse.toggleRight}
          width={320}
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
              onTestScript={() => {
                // No client-side execution: scripts run server-side after
                // publish. Surface an inline notice instead of console.log.
                setInfoNotice('Script test runs server-side after publish');
                setTimeout(() => setInfoNotice(null), 5000);
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

      {/* Inline info notice (script test, etc.) */}
      {infoNotice && (
        <div className="px-4 py-1.5 bg-cyan-50 border-t border-cyan-100 text-xs text-cyan-800" role="status">
          {infoNotice}
        </div>
      )}

      {/* Status Bar */}
      <ScadaBuilderStatusBar
        screens={screenSummaries}
        activeScreenId={activeScreenId}
        mode={mode}
        selectedDeviceName={selectedDevice?.deviceName ?? null}
        packageStatus={scadaPackage?.status ?? null}
        packageVersion={scadaPackage?.version ?? null}
      />

      {/* Deploy Dialog */}
      {showDeployDialog && effectivePackageId && (
        <DeployToEdgeDialog
          title="Deploy SCADA Package"
          artifactLabel="SCADA Package"
          artifactName={packageName}
          accent="purple"
          preview={<ScadaPackagePreview packageData={toScadaPackageJSON()} />}
          isOpen={showDeployDialog}
          onClose={() => setShowDeployDialog(false)}
          onDeploy={(deviceId) =>
            deployMutation.mutateAsync({ packageId: effectivePackageId, deviceId })
          }
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
