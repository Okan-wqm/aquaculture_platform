/**
 * ScadaBuilderToolbar — Top toolbar extracted from ScadaPackageBuilderPage.
 *
 * Contains: Back link, package name input, save/dirty indicators,
 * target device selector, search/templates/CSV buttons,
 * mode segment control, deploy dropdown.
 */

import React, { useState, useRef } from 'react';
import { useClickOutside, Spinner, Button, Input } from '@aquaculture/shared-ui';
import { Link } from 'react-router-dom';
import {
  ArrowLeft,
  Save,
  Eye,
  ChevronDown,
  Monitor,
  Wifi,
  WifiOff,
  CheckCircle,
  Search,
  Bookmark,
  Zap,
  Pencil,
  FileSpreadsheet,
  ImageDown,
  FlaskConical,
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
  /** Callback to open the PNG/PDF export dialog. */
  onExportDialogOpen?: () => void;
  /** Callback to load the built-in RAS demo template. */
  onLoadDemo?: () => void;
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
  onExportDialogOpen,
  onLoadDemo,
}) => {
  const [showDeviceDropdown, setShowDeviceDropdown] = useState(false);
  const [showDeployMenu, setShowDeployMenu] = useState(false);
  const [showSearch, setShowSearch] = useState(false);
  const [showTemplates, setShowTemplates] = useState(false);
  const deviceDropdownRef = useRef<HTMLDivElement>(null);
  const searchPanelRef = useRef<HTMLDivElement>(null);
  const templatePanelRef = useRef<HTMLDivElement>(null);
  const deployMenuRef = useRef<HTMLDivElement>(null);
  useClickOutside(deviceDropdownRef, () => setShowDeviceDropdown(false), showDeviceDropdown);
  useClickOutside(searchPanelRef, () => setShowSearch(false), showSearch);
  useClickOutside(templatePanelRef, () => setShowTemplates(false), showTemplates);
  useClickOutside(deployMenuRef, () => setShowDeployMenu(false), showDeployMenu);

  return (
    <div className="flex items-center justify-between px-4 py-2 bg-white dark:bg-gray-900 border-b border-gray-200 dark:border-gray-700 shadow-sm">
      {/* Left */}
      <div className="flex items-center gap-3">
        <Link
          to="/sensor/scada-packages"
          className="flex items-center gap-1.5 text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100 text-sm"
        >
          <ArrowLeft className="w-4 h-4" />
          <span>Back</span>
        </Link>
        <div className="h-5 w-px bg-gray-300" />
        <Input type="text" value={packageName} onChange={(e) => onPackageNameChange(e.target.value)} placeholder="Package Name" aria-label="Package name" />
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
        <div className="relative" ref={deviceDropdownRef}>
          <button
            onClick={() => setShowDeviceDropdown(!showDeviceDropdown)}
            className="flex items-center gap-1.5 px-2.5 py-1.5 text-sm text-gray-700 dark:text-gray-300 bg-gray-50 dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700"
          >
            <Monitor className="w-4 h-4 text-gray-500 dark:text-gray-400" />
            {selectedDevice ? (
              <span className="flex items-center gap-1.5">
                <span className="truncate max-w-[120px]">{selectedDevice.deviceName}</span>
                {selectedDevice.isOnline ? (
                  <Wifi className="w-3 h-3 text-green-500" />
                ) : (
                  <WifiOff className="w-3 h-3 text-gray-500 dark:text-gray-400" />
                )}
              </span>
            ) : (
              <span className="text-gray-500 dark:text-gray-400">Select Device</span>
            )}
            <ChevronDown className="w-3 h-3 text-gray-500 dark:text-gray-400" />
          </button>

          {showDeviceDropdown && (
            <div className="absolute left-0 mt-1 w-64 bg-white dark:bg-gray-900 rounded-lg shadow-lg border border-gray-200 dark:border-gray-700 z-40 py-1 max-h-64 overflow-y-auto">
              <Button variant="ghost" size="sm" onClick={() => {
                  onTargetDeviceChange(null);
                  setShowDeviceDropdown(false);
                }}>No Device</Button>
              {devices.map((device) => (
                <button
                  key={device.id}
                  onClick={() => {
                    onTargetDeviceChange(device.id);
                    setShowDeviceDropdown(false);
                  }}
                  className={`w-full text-left px-3 py-2 text-sm hover:bg-gray-50 dark:hover:bg-gray-800 flex items-center justify-between ${
                    targetDeviceId === device.id ? 'bg-cyan-50 text-cyan-700' : 'text-gray-700 dark:text-gray-300'
                  }`}
                >
                  <span className="truncate">{device.deviceName}</span>
                  <span className="flex items-center gap-1.5 flex-shrink-0 ml-2">
                    <span className="text-xs text-gray-500 dark:text-gray-400">{device.deviceCode}</span>
                    {device.isOnline ? (
                      <span className="w-2 h-2 rounded-full bg-green-500" />
                    ) : (
                      <span className="w-2 h-2 rounded-full bg-gray-300" />
                    )}
                  </span>
                </button>
              ))}
              {devices.length === 0 && (
                <p className="px-3 py-2 text-xs text-gray-500 dark:text-gray-400">No edge devices found</p>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Right */}
      <div className="flex items-center gap-2">
        <UndoRedoToolbar />
        {/* Widget Search */}
        <div className="relative" ref={searchPanelRef}>
          <button
            onClick={() => setShowSearch(!showSearch)}
            className={`flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg transition-colors ${
              showSearch
                ? 'text-white bg-cyan-600 hover:bg-cyan-700'
                : 'text-gray-700 dark:text-gray-300 bg-white dark:bg-gray-900 border border-gray-300 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-800'
            }`}
            title="Search Widgets"
          >
            <Search className="w-4 h-4" />
            Search
          </button>
          {showSearch && (
            <div className="absolute right-0 mt-1 z-40">
              <WidgetSearchPanel />
            </div>
          )}
        </div>

        {/* Widget Templates */}
        <div className="relative" ref={templatePanelRef}>
          <button
            onClick={() => setShowTemplates(!showTemplates)}
            className={`flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg transition-colors ${
              showTemplates
                ? 'text-white bg-cyan-600 hover:bg-cyan-700'
                : 'text-gray-700 dark:text-gray-300 bg-white dark:bg-gray-900 border border-gray-300 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-800'
            }`}
            title="Templates"
          >
            <Bookmark className="w-4 h-4" />
            Templates
          </button>
          {showTemplates && (
            <div className="absolute right-0 mt-1 z-40">
              <WidgetTemplatePanel />
            </div>
          )}
        </div>

        {/* Load Demo Template */}
        {onLoadDemo && (
          <Button variant="primary" size="sm" leftIcon={<FlaskConical className="w-4 h-4" />} onClick={onLoadDemo} title="Load RAS Demo Template">Demo</Button>
        )}

        {/* CSV Tag Import/Export */}
        <Button variant="secondary" size="sm" leftIcon={<FileSpreadsheet className="w-4 h-4" />} onClick={onCsvDialogOpen} title="CSV Tag Import/Export">CSV</Button>

        {/* PNG/PDF Export */}
        {onExportDialogOpen && (
          <Button variant="secondary" size="sm" leftIcon={<ImageDown className="w-4 h-4" />} onClick={onExportDialogOpen} title="Export as PNG/PDF">Export</Button>
        )}

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
            <Spinner size="sm" color="inherit" />
          ) : (
            <Save className="w-4 h-4" />
          )}
          {isSaving ? 'Saving...' : 'Save'}
        </button>

        {/* Mode Segment Control */}
        <div className="flex items-center bg-gray-100 dark:bg-gray-800 rounded-lg p-0.5 border border-gray-200 dark:border-gray-700" role="radiogroup" aria-label="Builder mode">
          <button
            onClick={() => onModeChange('edit')}
            role="radio"
            aria-checked={mode === 'edit'}
            aria-label="Edit mode"
            className={`flex items-center gap-1 px-2.5 py-1 text-xs rounded-md transition-colors ${
              mode === 'edit'
                ? 'bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100 shadow-sm font-medium'
                : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-100'
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
                ? 'bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100 shadow-sm font-medium'
                : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-100'
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
                : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-100'
            }`}
          >
            <Zap className="w-3.5 h-3.5" />
            Simulation
          </button>
        </div>

        <div className="relative" ref={deployMenuRef}>
          <Button variant="primary" size="sm" rightIcon={<ChevronDown className="w-3.5 h-3.5" />} onClick={() => setShowDeployMenu(!showDeployMenu)}>Deploy</Button>
          {showDeployMenu && (
            <div className="absolute right-0 mt-1 w-48 bg-white dark:bg-gray-900 rounded-lg shadow-lg border border-gray-200 dark:border-gray-700 z-40 py-1">
              <Button variant="ghost" size="sm" onClick={() => {
                  setShowDeployMenu(false);
                  onDeployClick();
                }}>Deploy to Edge Device</Button>
              <Button variant="ghost" size="sm" onClick={() => setShowDeployMenu(false)}>Publish to Cloud</Button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
