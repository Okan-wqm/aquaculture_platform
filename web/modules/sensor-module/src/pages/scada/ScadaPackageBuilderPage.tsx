/**
 * ScadaPackageBuilderPage - Main SCADA Package Builder with 3-panel layout
 *
 * Layout:
 *   Toolbar (top) - package name, target device, save, preview, deploy
 *   Left: WidgetPalette | Center: ScreenCanvas | Right: PropertiesPanel
 *   Status bar (bottom)
 */

import React, { useEffect, useState, useCallback, useMemo } from 'react';
import { useParams, useSearchParams, useNavigate, Link } from 'react-router-dom';
import {
  ArrowLeft,
  Save,
  Eye,
  ChevronDown,
  Loader2,
  Monitor,
  Wifi,
  WifiOff,
  CheckCircle,
  Search,
  Bookmark,
} from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';

import { useScadaPackageStore, type ScadaPackageJSON } from '../../store/scadaPackageStore';
import { WidgetPalette } from '../../components/scada-builder/WidgetPalette';
import { ScreenCanvas } from '../../components/scada-builder/ScreenCanvas';
import { PropertiesPanel } from '../../components/scada-builder/PropertiesPanel';
import { DeployScadaDialog } from '../../components/scada-builder/DeployScadaDialog';
import ScreenTabBar from '../../components/scada-builder/ScreenTabBar';
import { SceneTreePanel } from '../../components/scada-builder/SceneTreePanel';
import { ScreenBreadcrumb } from '../../components/scada-builder/ScreenBreadcrumb';
import { GlobalAlarmBanner } from '../../components/scada-builder/GlobalAlarmBanner';
import { WidgetSearchPanel } from '../../components/scada-builder/WidgetSearchPanel';
import { WidgetTemplatePanel } from '../../components/scada-builder/WidgetTemplatePanel';
import { UndoRedoToolbar } from '../../components/scada-builder/UndoRedoToolbar';
import {
  useScadaPackageById,
  useCreateScadaPackage,
  useUpdateScadaPackage,
} from '../../hooks/useScadaPackage';
import { useEdgeDevices } from '../../hooks/useEdgeDevices';
import { useScadaKeyboardShortcuts } from '../../hooks/useScadaKeyboardShortcuts';
import { ScadaDataProvider } from '../../context/ScadaDataProvider';

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
  const [showDeployMenu, setShowDeployMenu] = useState(false);
  const [showDeployDialog, setShowDeployDialog] = useState(false);
  const [showDeviceDropdown, setShowDeviceDropdown] = useState(false);
  const [showPreview, setShowPreview] = useState(false);
  const [showSearch, setShowSearch] = useState(false);
  const [showTemplates, setShowTemplates] = useState(false);
  const deployParam = searchParams.get('deploy');

  const {
    packageId: storePackageId,
    packageName,
    setPackageName,
    setPackageId,
    setProcessId,
    screens,
    activeScreenId,
    selectedWidgetId,
    isDirty,
    loadFromJSON,
    importProcessAsWidget,
    toScadaPackageJSON,
    // Alarm & control & trend state
    alarmRules,
    controlPermissions,
    trendConfig,
    // Alarm actions
    addAlarmRule,
    removeAlarmRule,
    updateAlarmRule,
    // Control & trend actions
    updateControlPermissions,
    updateTrendConfig,
    // Widget actions
    updateWidget,
    // Target device
    targetDeviceId,
    setTargetDeviceId,
    // Screen actions
    addScreen,
    // Edge state + actions
    selectedEdgeId,
    updateEdgeData,
    updateEdgeType,
    removeEdge,
    reset,
  } = useScadaPackageStore(useShallow((s) => ({
    packageId: s.packageId,
    packageName: s.packageName,
    setPackageName: s.setPackageName,
    setPackageId: s.setPackageId,
    setProcessId: s.setProcessId,
    screens: s.screens,
    activeScreenId: s.activeScreenId,
    selectedWidgetId: s.selectedWidgetId,
    isDirty: s.isDirty,
    loadFromJSON: s.loadFromJSON,
    importProcessAsWidget: s.importProcessAsWidget,
    toScadaPackageJSON: s.toScadaPackageJSON,
    alarmRules: s.alarmRules,
    controlPermissions: s.controlPermissions,
    trendConfig: s.trendConfig,
    addAlarmRule: s.addAlarmRule,
    removeAlarmRule: s.removeAlarmRule,
    updateAlarmRule: s.updateAlarmRule,
    updateControlPermissions: s.updateControlPermissions,
    updateTrendConfig: s.updateTrendConfig,
    updateWidget: s.updateWidget,
    targetDeviceId: s.targetDeviceId,
    setTargetDeviceId: s.setTargetDeviceId,
    addScreen: s.addScreen,
    selectedEdgeId: s.selectedEdgeId,
    updateEdgeData: s.updateEdgeData,
    updateEdgeType: s.updateEdgeType,
    removeEdge: s.removeEdge,
    reset: s.reset,
  })));

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
      addScreen('dashboard', 'Ekran 1');
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
      useScadaPackageStore.setState({ isDirty: false });
      setSaveSuccess(true);
      setTimeout(() => setSaveSuccess(false), 2000);
    } catch (err) {
      console.error('Save failed:', err);
      setSaveError('Kaydetme başarısız oldu. Lütfen tekrar deneyin.');
      setTimeout(() => setSaveError(null), 5000);
    } finally {
      setIsSaving(false);
    }
  }, [packageName, effectivePackageId, toScadaPackageJSON, updateMutation, createMutation, processId, setPackageId, navigate]);

  // Keyboard shortcuts (Ctrl+Z/Y, Ctrl+C/V/X, Del, Ctrl+S, Esc)
  useScadaKeyboardShortcuts({
    onSave: handleSave,
    isPreview: showPreview,
  });

  // Deploy handler - ensure save first
  const handleDeployClick = useCallback(async () => {
    setShowDeployMenu(false);
    if (!effectivePackageId || isDirty) {
      await handleSave();
    }
    setShowDeployDialog(true);
  }, [effectivePackageId, isDirty, handleSave]);

  // Find selected widget for PropertiesPanel
  const selectedWidget = useMemo(() => {
    if (!selectedWidgetId || !activeScreenId) return null;
    const screen = screens.find((s) => s.id === activeScreenId);
    if (!screen) return null;
    const widget = screen.widgets.find((w) => w.id === selectedWidgetId);
    if (!widget) return null;
    return {
      id: widget.id,
      type: widget.widgetType,
      config: widget.config,
    };
  }, [selectedWidgetId, activeScreenId, screens]);

  // Widget config change handler
  const handleWidgetConfigChange = useCallback(
    (widgetId: string, updates: Record<string, any>) => {
      const state = useScadaPackageStore.getState();
      if (!state.activeScreenId) return;
      const screen = state.screens.find((s) => s.id === state.activeScreenId);
      if (!screen) return;
      const widget = screen.widgets.find((w) => w.id === widgetId);
      if (!widget) return;
      state.updateWidget(state.activeScreenId, widgetId, {
        config: { ...widget.config, ...updates },
      });
    },
    [],
  );

  // Find selected edge for PropertiesPanel
  const selectedEdge = useMemo(() => {
    if (!selectedEdgeId || !activeScreenId) return null;
    const screen = screens.find((s) => s.id === activeScreenId);
    return screen?.edges.find((e) => e.id === selectedEdgeId) || null;
  }, [selectedEdgeId, activeScreenId, screens]);

  // Edge handlers for PropertiesPanel
  const handleEdgeDataChange = useCallback(
    (edgeId: string, updates: Record<string, unknown>) => {
      if (!activeScreenId) return;
      updateEdgeData(activeScreenId, edgeId, updates);
    },
    [activeScreenId, updateEdgeData],
  );

  const handleEdgeTypeChange = useCallback(
    (edgeId: string, newType: string) => {
      if (!activeScreenId) return;
      updateEdgeType(activeScreenId, edgeId, newType as any);
    },
    [activeScreenId, updateEdgeType],
  );

  const handleEdgeDelete = useCallback(
    (edgeId: string) => {
      if (!activeScreenId) return;
      removeEdge(activeScreenId, edgeId);
    },
    [activeScreenId, removeEdge],
  );

  // Alarm rules change handler
  const handleAlarmRulesChange = useCallback(
    (rules: typeof alarmRules) => {
      // Diff: figure out adds, removes, updates
      const existingIds = new Set(alarmRules.map((r) => r.id));
      const newIds = new Set(rules.map((r) => r.id));

      // Removed
      for (const r of alarmRules) {
        if (!newIds.has(r.id)) removeAlarmRule(r.id);
      }
      // Added or updated
      for (const r of rules) {
        if (!existingIds.has(r.id)) {
          addAlarmRule(r);
        } else {
          updateAlarmRule(r.id, r);
        }
      }
    },
    [alarmRules, addAlarmRule, removeAlarmRule, updateAlarmRule],
  );

  // Count total widgets and edges across all screens
  const totalWidgets = screens.reduce((sum, s) => sum + s.widgets.length, 0);
  const totalEdges = screens.reduce((sum, s) => sum + s.edges.length, 0);
  const alarmWidgets = screens.reduce(
    (sum, s) =>
      sum +
      s.widgets.filter(
        (w) => w.widgetType === 'alarmBanner' || w.widgetType === 'alarmList',
      ).length,
    0,
  );

  // Loading state
  if (loadingPackage && routePackageId && routePackageId !== 'new') {
    return (
      <div className="flex items-center justify-center h-screen bg-gray-100">
        <div className="text-center">
          <Loader2 className="w-8 h-8 animate-spin text-cyan-600 mx-auto" />
          <p className="mt-2 text-sm text-gray-500">Paket yükleniyor...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-screen bg-gray-100">
      {/* Toolbar */}
      <div className="flex items-center justify-between px-4 py-2 bg-white border-b border-gray-200 shadow-sm">
        {/* Left */}
        <div className="flex items-center gap-3">
          <Link
            to="/sensor/scada-packages"
            className="flex items-center gap-1.5 text-gray-600 hover:text-gray-900 text-sm"
          >
            <ArrowLeft className="w-4 h-4" />
            <span>Geri</span>
          </Link>
          <div className="h-5 w-px bg-gray-300" />
          <input
            type="text"
            value={packageName}
            onChange={(e) => setPackageName(e.target.value)}
            placeholder="Paket Adı"
            aria-label="Paket adı"
            className="text-base font-medium text-gray-900 border-none bg-transparent focus:outline-none focus:ring-0 w-56"
          />
          {isDirty && (
            <span className="text-xs text-yellow-600 bg-yellow-50 px-2 py-0.5 rounded">
              Kaydedilmemiş
            </span>
          )}
          {saveSuccess && (
            <span className="flex items-center gap-1 text-xs text-green-600 bg-green-50 px-2 py-0.5 rounded">
              <CheckCircle className="w-3 h-3" />
              Kaydedildi
            </span>
          )}
          {saveError && (
            <span className="text-xs text-red-600 bg-red-50 px-2 py-0.5 rounded">
              {saveError}
            </span>
          )}

          {/* Target Device Selector */}
          <div className="h-5 w-px bg-gray-300" />
          <div className="relative">
            <button
              onClick={() => setShowDeviceDropdown(!showDeviceDropdown)}
              className="flex items-center gap-1.5 px-2.5 py-1.5 text-sm text-gray-700 bg-gray-50 border border-gray-300 rounded-lg hover:bg-gray-100"
            >
              <Monitor className="w-4 h-4 text-gray-500" />
              {selectedDevice ? (
                <span className="flex items-center gap-1.5">
                  <span className="truncate max-w-[120px]">{selectedDevice.deviceName}</span>
                  {selectedDevice.isOnline ? (
                    <Wifi className="w-3 h-3 text-green-500" />
                  ) : (
                    <WifiOff className="w-3 h-3 text-gray-400" />
                  )}
                </span>
              ) : (
                <span className="text-gray-400">Cihaz Seç</span>
              )}
              <ChevronDown className="w-3 h-3 text-gray-400" />
            </button>

            {showDeviceDropdown && (
              <>
                <div
                  className="fixed inset-0 z-30"
                  onClick={() => setShowDeviceDropdown(false)}
                />
                <div className="absolute left-0 mt-1 w-64 bg-white rounded-lg shadow-lg border border-gray-200 z-40 py-1 max-h-64 overflow-y-auto">
                  <button
                    onClick={() => {
                      setTargetDeviceId(null);
                      setShowDeviceDropdown(false);
                    }}
                    className="w-full text-left px-3 py-2 text-sm text-gray-500 hover:bg-gray-50"
                  >
                    Cihaz Seçme
                  </button>
                  {devices.map((device) => (
                    <button
                      key={device.id}
                      onClick={() => {
                        setTargetDeviceId(device.id);
                        setShowDeviceDropdown(false);
                      }}
                      className={`w-full text-left px-3 py-2 text-sm hover:bg-gray-50 flex items-center justify-between ${
                        targetDeviceId === device.id ? 'bg-cyan-50 text-cyan-700' : 'text-gray-700'
                      }`}
                    >
                      <span className="truncate">{device.deviceName}</span>
                      <span className="flex items-center gap-1.5 flex-shrink-0 ml-2">
                        <span className="text-xs text-gray-400">{device.deviceCode}</span>
                        {device.isOnline ? (
                          <span className="w-2 h-2 rounded-full bg-green-500" />
                        ) : (
                          <span className="w-2 h-2 rounded-full bg-gray-300" />
                        )}
                      </span>
                    </button>
                  ))}
                  {devices.length === 0 && (
                    <p className="px-3 py-2 text-xs text-gray-400">Edge device bulunamadı</p>
                  )}
                </div>
              </>
            )}
          </div>
        </div>

        {/* Right */}
        <div className="flex items-center gap-2">
          <UndoRedoToolbar />
          {/* Widget Search */}
          <div className="relative">
            <button
              onClick={() => setShowSearch(!showSearch)}
              className={`flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg transition-colors ${
                showSearch
                  ? 'text-white bg-cyan-600 hover:bg-cyan-700'
                  : 'text-gray-700 bg-white border border-gray-300 hover:bg-gray-50'
              }`}
              title="Widget Ara"
            >
              <Search className="w-4 h-4" />
              Ara
            </button>
            {showSearch && (
              <>
                <div className="fixed inset-0 z-30" onClick={() => setShowSearch(false)} />
                <div className="absolute right-0 mt-1 z-40">
                  <WidgetSearchPanel />
                </div>
              </>
            )}
          </div>

          {/* Widget Templates */}
          <div className="relative">
            <button
              onClick={() => setShowTemplates(!showTemplates)}
              className={`flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg transition-colors ${
                showTemplates
                  ? 'text-white bg-cyan-600 hover:bg-cyan-700'
                  : 'text-gray-700 bg-white border border-gray-300 hover:bg-gray-50'
              }`}
              title="Sablonlar"
            >
              <Bookmark className="w-4 h-4" />
              Sablonlar
            </button>
            {showTemplates && (
              <>
                <div className="fixed inset-0 z-30" onClick={() => setShowTemplates(false)} />
                <div className="absolute right-0 mt-1 z-40">
                  <WidgetTemplatePanel />
                </div>
              </>
            )}
          </div>

          <button
            onClick={handleSave}
            disabled={isSaving || !packageName.trim()}
            className={`flex items-center gap-1.5 px-3 py-1.5 text-sm text-white rounded-lg transition-colors ${
              isSaving || !packageName.trim()
                ? 'bg-cyan-400 cursor-not-allowed'
                : 'bg-cyan-600 hover:bg-cyan-700'
            }`}
          >
            {isSaving ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Save className="w-4 h-4" />
            )}
            {isSaving ? 'Kaydediliyor...' : 'Kaydet'}
          </button>

          <button
            onClick={() => setShowPreview(!showPreview)}
            className={`flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg transition-colors ${
              showPreview
                ? 'text-white bg-cyan-600 hover:bg-cyan-700'
                : 'text-gray-700 bg-white border border-gray-300 hover:bg-gray-50'
            }`}
          >
            <Eye className="w-4 h-4" />
            {showPreview ? 'Düzenle' : 'Önizleme'}
          </button>

          <div className="relative">
            <button
              onClick={() => setShowDeployMenu(!showDeployMenu)}
              className="flex items-center gap-1.5 px-3 py-1.5 text-sm text-white bg-indigo-600 rounded-lg hover:bg-indigo-700"
            >
              Deploy
              <ChevronDown className="w-3.5 h-3.5" />
            </button>
            {showDeployMenu && (
              <>
                <div
                  className="fixed inset-0 z-30"
                  onClick={() => setShowDeployMenu(false)}
                />
                <div className="absolute right-0 mt-1 w-48 bg-white rounded-lg shadow-lg border border-gray-200 z-40 py-1">
                  <button
                    className="w-full text-left px-3 py-2 text-sm text-gray-700 hover:bg-gray-50"
                    onClick={handleDeployClick}
                  >
                    Edge Device'a Deploy
                  </button>
                  <button
                    className="w-full text-left px-3 py-2 text-sm text-gray-700 hover:bg-gray-50"
                    onClick={() => setShowDeployMenu(false)}
                  >
                    Cloud'a Publish
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      </div>

      {/* Main Content */}
      <div className="flex-1 flex overflow-hidden">
        {/* Scene Tree Panel (hidden in preview) */}
        {!showPreview && <SceneTreePanel />}

        {/* Left Panel - Widget Palette (hidden in preview) */}
        {!showPreview && <WidgetPalette />}

        {/* Center - Canvas with Screen Tabs */}
        <div className="flex-1 flex flex-col overflow-hidden">
          {/* Global Alarm Banner */}
          <GlobalAlarmBanner />

          {/* Screen tabs - using ScreenTabBar component */}
          <ScreenTabBar />

          {/* Breadcrumb navigation for nested screens */}
          <ScreenBreadcrumb />

          {/* Canvas — wrapped with ScadaDataProvider in preview mode for live data */}
          <div className="flex-1 flex flex-col">
            {showPreview && selectedDevice?.deviceCode ? (
              <ScadaDataProvider
                initialDeviceCodes={[selectedDevice.deviceCode]}
                enabled
              >
                <ScreenCanvas isPreview deviceCode={selectedDevice.deviceCode} />
              </ScadaDataProvider>
            ) : (
              <ScreenCanvas isPreview={showPreview} />
            )}
          </div>
        </div>

        {/* Right Panel - PropertiesPanel (hidden in preview) */}
        {!showPreview && <PropertiesPanel
          selectedWidget={selectedWidget}
          onWidgetConfigChange={handleWidgetConfigChange}
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
        />}
      </div>

      {/* Status Bar */}
      <div className="px-4 py-1 bg-white border-t border-gray-200 flex items-center justify-between text-xs text-gray-500">
        <div className="flex items-center gap-4">
          <span>Durum: Taslak</span>
          <span>v1</span>
          <span>{screens.length} ekran</span>
          <span>{totalWidgets} widget</span>
          <span>{totalEdges} baglanti</span>
          <span>{alarmWidgets} alarm</span>
          {selectedDevice && (
            <span className="flex items-center gap-1">
              <Monitor className="w-3 h-3" />
              {selectedDevice.deviceName}
            </span>
          )}
        </div>
        <div className="flex items-center gap-3">
          {activeScreenId && (
            <span className="text-gray-400">
              {screens.find((s) => s.id === activeScreenId)?.name ?? ''}
            </span>
          )}
          <span className="w-2 h-2 rounded-full bg-green-500" />
          <span>Hazır</span>
        </div>
      </div>

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
    </div>
  );
};

export default ScadaPackageBuilderPage;
