/**
 * ScadaBuilderToolbar — Top toolbar extracted from ScadaPackageBuilderPage.
 *
 * Contains: Back link, package name input, save/dirty indicators,
 * target device selector, search/templates/CSV buttons,
 * mode segment control, deploy dropdown.
 */

import React, { useState } from 'react';
import { Link } from 'react-router-dom';
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
  Zap,
  Pencil,
  FileSpreadsheet,
} from 'lucide-react';

import { UndoRedoToolbar } from '../../components/scada-builder/UndoRedoToolbar';
import { WidgetSearchPanel } from '../../components/scada-builder/WidgetSearchPanel';
import { WidgetTemplatePanel } from '../../components/scada-builder/WidgetTemplatePanel';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type BuilderMode = 'edit' | 'preview' | 'simulation';

interface EdgeDevice {
  id: string;
  deviceName: string;
  deviceCode: string;
  isOnline: boolean;
}

export interface ScadaBuilderToolbarProps {
  packageName: string;
  onPackageNameChange: (name: string) => void;
  isDirty: boolean;
  isSaving: boolean;
  saveSuccess: boolean;
  saveError: string | null;
  onSave: () => void;
  mode: BuilderMode;
  onModeChange: (mode: BuilderMode) => void;
  onDeployClick: () => void;
  targetDeviceId: string | null;
  onTargetDeviceChange: (deviceId: string | null) => void;
  selectedDevice: EdgeDevice | null;
  devices: EdgeDevice[];
  onCsvDialogOpen: () => void;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export const ScadaBuilderToolbar: React.FC<ScadaBuilderToolbarProps> = ({
  packageName,
  onPackageNameChange,
  isDirty,
  isSaving,
  saveSuccess,
  saveError,
  onSave,
  mode,
  onModeChange,
  onDeployClick,
  targetDeviceId,
  onTargetDeviceChange,
  selectedDevice,
  devices,
  onCsvDialogOpen,
}) => {
  const [showDeviceDropdown, setShowDeviceDropdown] = useState(false);
  const [showDeployMenu, setShowDeployMenu] = useState(false);
  const [showSearch, setShowSearch] = useState(false);
  const [showTemplates, setShowTemplates] = useState(false);

  return (
    <div className="flex items-center justify-between px-4 py-2 bg-white border-b border-gray-200 shadow-sm">
      {/* Left */}
      <div className="flex items-center gap-3">
        <Link
          to="/sensor/scada-packages"
          className="flex items-center gap-1.5 text-gray-600 hover:text-gray-900 text-sm"
        >
          <ArrowLeft className="w-4 h-4" />
          <span>Back</span>
        </Link>
        <div className="h-5 w-px bg-gray-300" />
        <input
          type="text"
          value={packageName}
          onChange={(e) => onPackageNameChange(e.target.value)}
          placeholder="Package Name"
          aria-label="Package name"
          className="text-base font-medium text-gray-900 border-none bg-transparent focus:outline-none focus:ring-0 w-56"
        />
        {isDirty && (
          <span className="text-xs text-yellow-600 bg-yellow-50 px-2 py-0.5 rounded">
            Unsaved
          </span>
        )}
        {saveSuccess && (
          <span className="flex items-center gap-1 text-xs text-green-600 bg-green-50 px-2 py-0.5 rounded">
            <CheckCircle className="w-3 h-3" />
            Saved
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
                  <WifiOff className="w-3 h-3 text-gray-500" />
                )}
              </span>
            ) : (
              <span className="text-gray-500">Select Device</span>
            )}
            <ChevronDown className="w-3 h-3 text-gray-500" />
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
                    onTargetDeviceChange(null);
                    setShowDeviceDropdown(false);
                  }}
                  className="w-full text-left px-3 py-2 text-sm text-gray-500 hover:bg-gray-50"
                >
                  No Device
                </button>
                {devices.map((device) => (
                  <button
                    key={device.id}
                    onClick={() => {
                      onTargetDeviceChange(device.id);
                      setShowDeviceDropdown(false);
                    }}
                    className={`w-full text-left px-3 py-2 text-sm hover:bg-gray-50 flex items-center justify-between ${
                      targetDeviceId === device.id ? 'bg-cyan-50 text-cyan-700' : 'text-gray-700'
                    }`}
                  >
                    <span className="truncate">{device.deviceName}</span>
                    <span className="flex items-center gap-1.5 flex-shrink-0 ml-2">
                      <span className="text-xs text-gray-500">{device.deviceCode}</span>
                      {device.isOnline ? (
                        <span className="w-2 h-2 rounded-full bg-green-500" />
                      ) : (
                        <span className="w-2 h-2 rounded-full bg-gray-300" />
                      )}
                    </span>
                  </button>
                ))}
                {devices.length === 0 && (
                  <p className="px-3 py-2 text-xs text-gray-500">No edge devices found</p>
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
            title="Search Widgets"
          >
            <Search className="w-4 h-4" />
            Search
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
            title="Templates"
          >
            <Bookmark className="w-4 h-4" />
            Templates
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

        {/* CSV Tag Import/Export */}
        <button
          onClick={onCsvDialogOpen}
          className="flex items-center gap-1.5 px-3 py-1.5 text-sm text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
          title="CSV Tag Import/Export"
        >
          <FileSpreadsheet className="w-4 h-4" />
          CSV
        </button>

        <button
          onClick={onSave}
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
          {isSaving ? 'Saving...' : 'Save'}
        </button>

        {/* Mode Segment Control */}
        <div className="flex items-center bg-gray-100 rounded-lg p-0.5 border border-gray-200" role="radiogroup" aria-label="Builder mode">
          <button
            onClick={() => onModeChange('edit')}
            role="radio"
            aria-checked={mode === 'edit'}
            aria-label="Edit mode"
            className={`flex items-center gap-1 px-2.5 py-1 text-xs rounded-md transition-colors ${
              mode === 'edit'
                ? 'bg-white text-gray-900 shadow-sm font-medium'
                : 'text-gray-500 hover:text-gray-700'
            }`}
          >
            <Pencil className="w-3.5 h-3.5" />
            Edit
          </button>
          <button
            onClick={() => onModeChange('preview')}
            role="radio"
            aria-checked={mode === 'preview'}
            aria-label="Preview mode"
            className={`flex items-center gap-1 px-2.5 py-1 text-xs rounded-md transition-colors ${
              mode === 'preview'
                ? 'bg-white text-gray-900 shadow-sm font-medium'
                : 'text-gray-500 hover:text-gray-700'
            }`}
          >
            <Eye className="w-3.5 h-3.5" />
            Preview
          </button>
          <button
            onClick={() => onModeChange('simulation')}
            role="radio"
            aria-checked={mode === 'simulation'}
            aria-label="Simulation mode"
            className={`flex items-center gap-1 px-2.5 py-1 text-xs rounded-md transition-colors ${
              mode === 'simulation'
                ? 'bg-cyan-600 text-white shadow-sm font-medium'
                : 'text-gray-500 hover:text-gray-700'
            }`}
          >
            <Zap className="w-3.5 h-3.5" />
            Simulation
          </button>
        </div>

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
                  onClick={() => {
                    setShowDeployMenu(false);
                    onDeployClick();
                  }}
                >
                  Deploy to Edge Device
                </button>
                <button
                  className="w-full text-left px-3 py-2 text-sm text-gray-700 hover:bg-gray-50"
                  onClick={() => setShowDeployMenu(false)}
                >
                  Publish to Cloud
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
};
