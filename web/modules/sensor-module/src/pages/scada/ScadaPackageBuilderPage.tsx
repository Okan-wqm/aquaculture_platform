/**
 * ScadaPackageBuilderPage - Main SCADA Package Builder with 3-panel layout
 *
 * Layout:
 *   Toolbar (top) - package name, save, preview, deploy
 *   Left: WidgetPalette | Center: ScreenCanvas | Right: PropertiesPanel (placeholder)
 *   Status bar (bottom)
 */

import React, { useEffect, useState, useCallback } from 'react';
import { useParams, useSearchParams, Link } from 'react-router-dom';
import {
  ArrowLeft,
  Save,
  Eye,
  ChevronDown,
  Plus,
  Loader2,
  X,
} from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';

import { useScadaPackageStore } from '../../store/scadaPackageStore';
import { WidgetPalette } from '../../components/scada-builder/WidgetPalette';
import { ScreenCanvas } from '../../components/scada-builder/ScreenCanvas';

const ScadaPackageBuilderPage: React.FC = () => {
  const { packageId } = useParams<{ packageId: string }>();
  const [searchParams] = useSearchParams();
  const processId = searchParams.get('processId');

  const [isSaving, setIsSaving] = useState(false);
  const [showDeployMenu, setShowDeployMenu] = useState(false);

  const {
    packageName,
    setPackageName,
    setPackageId,
    setProcessId,
    screens,
    activeScreenId,
    setActiveScreen,
    addScreen,
    removeScreen,
    selectedWidgetId,
    isDirty,
    loadFromJSON,
    importProcessAsWidget,
  } = useScadaPackageStore(useShallow((s) => ({
    packageName: s.packageName,
    setPackageName: s.setPackageName,
    setPackageId: s.setPackageId,
    setProcessId: s.setProcessId,
    screens: s.screens,
    activeScreenId: s.activeScreenId,
    setActiveScreen: s.setActiveScreen,
    addScreen: s.addScreen,
    removeScreen: s.removeScreen,
    selectedWidgetId: s.selectedWidgetId,
    isDirty: s.isDirty,
    loadFromJSON: s.loadFromJSON,
    importProcessAsWidget: s.importProcessAsWidget,
  })));

  // Load existing package or import from process on mount
  useEffect(() => {
    if (packageId && packageId !== 'new') {
      // In a real implementation, this would fetch from API and call loadFromJSON
      setPackageId(packageId);
    } else if (processId) {
      // Import process as a processView widget
      setProcessId(processId);
      importProcessAsWidget({ id: processId, name: 'Process', nodes: [], edges: [] });
    }
  }, [packageId, processId, setPackageId, setProcessId, loadFromJSON, importProcessAsWidget]);

  // Ensure there's at least one screen
  useEffect(() => {
    if (screens.length === 0) {
      addScreen('dashboard', 'Ekran 1');
    }
  }, [screens.length, addScreen]);

  // Save handler
  const handleSave = useCallback(async () => {
    setIsSaving(true);
    try {
      // In a real implementation this would call a GraphQL mutation
      // using toScadaPackageJSON() to get the payload
      await new Promise((resolve) => setTimeout(resolve, 500));
    } finally {
      setIsSaving(false);
    }
  }, []);

  // Count total widgets across all screens
  const totalWidgets = screens.reduce((sum, s) => sum + s.widgets.length, 0);
  // Count alarm widgets
  const alarmWidgets = screens.reduce(
    (sum, s) =>
      sum +
      s.widgets.filter(
        (w) => w.widgetType === 'alarmBanner' || w.widgetType === 'alarmList'
      ).length,
    0
  );

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
            placeholder="Paket Adi"
            className="text-base font-medium text-gray-900 border-none bg-transparent focus:outline-none focus:ring-0 w-56"
          />
          {isDirty && (
            <span className="text-xs text-yellow-600 bg-yellow-50 px-2 py-0.5 rounded">
              Kaydedilmemis
            </span>
          )}
        </div>

        {/* Right */}
        <div className="flex items-center gap-2">
          <button
            onClick={handleSave}
            disabled={isSaving}
            className={`flex items-center gap-1.5 px-3 py-1.5 text-sm text-white rounded-lg transition-colors ${
              isSaving
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

          <button className="flex items-center gap-1.5 px-3 py-1.5 text-sm text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50">
            <Eye className="w-4 h-4" />
            Onizleme
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
                    onClick={() => setShowDeployMenu(false)}
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
        {/* Left Panel - Widget Palette */}
        <WidgetPalette />

        {/* Center - Canvas with Screen Tabs */}
        <div className="flex-1 flex flex-col overflow-hidden">
          {/* Screen tabs */}
          <div className="flex items-center gap-1 px-2 py-1 bg-gray-50 border-b border-gray-200">
            {screens.map((screen) => (
              <div
                key={screen.id}
                className={`flex items-center gap-1 px-3 py-1 rounded-t text-sm cursor-pointer transition-colors ${
                  activeScreenId === screen.id
                    ? 'bg-white border border-b-0 border-gray-200 text-gray-900 font-medium -mb-px'
                    : 'text-gray-500 hover:text-gray-700 hover:bg-gray-100'
                }`}
                onClick={() => setActiveScreen(screen.id)}
              >
                <span className="truncate max-w-[120px]">{screen.name}</span>
                {screens.length > 1 && (
                  <button
                    className="text-gray-400 hover:text-red-500 ml-1"
                    onClick={(e) => {
                      e.stopPropagation();
                      removeScreen(screen.id);
                    }}
                  >
                    <X className="w-3 h-3" />
                  </button>
                )}
              </div>
            ))}
            <button
              onClick={() => addScreen('dashboard', `Ekran ${screens.length + 1}`)}
              className="p-1 text-gray-400 hover:text-cyan-600 hover:bg-cyan-50 rounded"
              title="Yeni ekran ekle"
            >
              <Plus className="w-4 h-4" />
            </button>
          </div>

          {/* Canvas */}
          <ScreenCanvas />
        </div>

        {/* Right Panel - Properties (placeholder) */}
        <div className="w-72 border-l border-gray-200 bg-white flex flex-col">
          <div className="px-3 py-2 border-b border-gray-200 bg-gray-50">
            <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wider">
              Ozellikler
            </h3>
          </div>
          <div className="flex-1 overflow-y-auto p-3">
            {selectedWidgetId ? (
              <div className="space-y-3">
                <p className="text-sm text-gray-600">
                  Widget ID:{' '}
                  <code className="text-xs bg-gray-100 px-1 rounded">
                    {selectedWidgetId}
                  </code>
                </p>
                <p className="text-xs text-gray-400">
                  Properties panel detaylari baska agent tarafindan olusturulacak.
                </p>
              </div>
            ) : (
              <div className="text-center text-gray-400 text-sm mt-8">
                <p>Widget secin</p>
                <p className="text-xs mt-1">
                  Ozellikleri burada duzenleyebilirsiniz
                </p>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Status Bar */}
      <div className="px-4 py-1 bg-white border-t border-gray-200 flex items-center justify-between text-xs text-gray-500">
        <div className="flex items-center gap-4">
          <span>Durum: Taslak</span>
          <span>v1</span>
          <span>{screens.length} ekran</span>
          <span>{totalWidgets} widget</span>
          <span>{alarmWidgets} alarm</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="w-2 h-2 rounded-full bg-green-500" />
          <span>Hazir</span>
        </div>
      </div>
    </div>
  );
};

export default ScadaPackageBuilderPage;
