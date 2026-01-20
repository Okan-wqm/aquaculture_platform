/**
 * GridStack Dashboard Component
 *
 * Drag-and-drop widget grid for sensor data visualization.
 * Uses GridStack.js for responsive grid layout.
 * Persists layouts to database via useDashboardLayout hook.
 */

import React, { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { GridStack, GridStackWidget } from 'gridstack';
import 'gridstack/dist/gridstack.min.css';

import {
  Plus,
  Save,
  Edit2,
  Eye,
  Trash2,
  Settings,
  ChevronDown,
  Star,
  Copy,
  Loader2,
  AlertCircle,
  GitFork,
  RotateCcw,
} from 'lucide-react';
import { WidgetConfigModal } from './WidgetConfigModal';
import { WidgetConfig, WidgetType } from './types';
import { GaugeWidgetContent } from './widgets/GaugeWidgetContent';
import { RadialGaugeWidgetContent } from './widgets/RadialGaugeWidgetContent';
import { LineChartWidgetContent } from './widgets/LineChartWidgetContent';
import { AreaChartWidgetContent } from './widgets/AreaChartWidgetContent';
import { BarChartWidgetContent } from './widgets/BarChartWidgetContent';
import { SparklineWidgetContent } from './widgets/SparklineWidgetContent';
import { StatCardWidgetContent } from './widgets/StatCardWidgetContent';
import { TableWidgetContent } from './widgets/TableWidgetContent';
import { ProcessViewWidgetContent } from './widgets/ProcessViewWidgetContent';
import { ProcessBackgroundLayer } from './widgets/ProcessBackgroundLayer';
import { useDashboardLayout, DashboardLayout, SaveLayoutInput, ProcessBackground } from '../../hooks/useDashboardLayout';
import { useActiveProcesses } from '../../hooks/useProcess';

// ============================================================================
// Types
// ============================================================================

interface GridStackDashboardProps {
  className?: string;
}

// ============================================================================
// Widget Renderer
// ============================================================================

const WidgetContent: React.FC<{ config: WidgetConfig }> = ({ config }) => {
  switch (config.type) {
    case 'gauge':
      return <GaugeWidgetContent config={config} />;
    case 'radial-gauge':
      return <RadialGaugeWidgetContent config={config} />;
    case 'line-chart':
      return <LineChartWidgetContent config={config} />;
    case 'area-chart':
      return <AreaChartWidgetContent config={config} />;
    case 'bar-chart':
      return <BarChartWidgetContent config={config} />;
    case 'multi-line':
      // Multi-line uses the same component as line-chart with multiple sensors
      return <LineChartWidgetContent config={config} />;
    case 'sparkline':
      return <SparklineWidgetContent config={config} />;
    case 'stat-card':
      return <StatCardWidgetContent config={config} />;
    case 'table':
      return <TableWidgetContent config={config} />;
    case 'heatmap':
      // Heatmap placeholder - to be implemented
      return (
        <div className="flex items-center justify-center h-full text-gray-400 text-sm">
          Heatmap coming soon
        </div>
      );
    case 'process-view':
      return <ProcessViewWidgetContent config={config} />;
    default:
      return (
        <div className="flex items-center justify-center h-full text-gray-400">
          Unknown widget type
        </div>
      );
  }
};

// ============================================================================
// Save Layout Modal
// ============================================================================

interface SaveLayoutModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSave: (name: string, description?: string, setAsDefault?: boolean) => void;
  saving: boolean;
  defaultName?: string;
  isUpdate?: boolean;
}

const SaveLayoutModal: React.FC<SaveLayoutModalProps> = ({
  isOpen,
  onClose,
  onSave,
  saving,
  defaultName = '',
  isUpdate = false,
}) => {
  const [name, setName] = useState(defaultName);
  const [description, setDescription] = useState('');
  const [setAsDefault, setSetAsDefault] = useState(false);

  useEffect(() => {
    if (isOpen) {
      setName(defaultName);
      setDescription('');
      setSetAsDefault(false);
    }
  }, [isOpen, defaultName]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto">
      <div className="fixed inset-0 bg-black bg-opacity-50" onClick={onClose} />
      <div className="relative min-h-screen flex items-center justify-center p-4">
        <div className="relative bg-white rounded-xl shadow-2xl w-full max-w-md p-6">
          <h3 className="text-lg font-semibold text-gray-900 mb-4">
            {isUpdate ? 'Update Layout' : 'Save New Layout'}
          </h3>

          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Layout Name
              </label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Enter dashboard name"
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-cyan-500"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Description (Optional)
              </label>
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Layout description"
                rows={2}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-cyan-500"
              />
            </div>

            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={setAsDefault}
                onChange={(e) => setSetAsDefault(e.target.checked)}
                className="h-4 w-4 text-cyan-600 focus:ring-cyan-500 border-gray-300 rounded"
              />
              <span className="text-sm text-gray-700">Set as default</span>
            </label>
          </div>

          <div className="flex justify-end gap-3 mt-6">
            <button
              onClick={onClose}
              className="px-4 py-2 text-gray-700 hover:bg-gray-100 rounded-lg transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={() => onSave(name, description, setAsDefault)}
              disabled={!name.trim() || saving}
              className={`
                flex items-center gap-2 px-4 py-2 rounded-lg transition-colors
                ${name.trim() && !saving
                  ? 'bg-cyan-600 text-white hover:bg-cyan-700'
                  : 'bg-gray-300 text-gray-500 cursor-not-allowed'
                }
              `}
            >
              {saving && <Loader2 size={16} className="animate-spin" />}
              {isUpdate ? 'Update' : 'Save'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

// ============================================================================
// GridStack Dashboard Component
// ============================================================================

export const GridStackDashboard: React.FC<GridStackDashboardProps> = ({
  className = '',
}) => {
  const gridRef = useRef<HTMLDivElement>(null);
  const gridInstanceRef = useRef<GridStack | null>(null);
  // Bug #6 fix: Prevent race conditions during GridStack state updates
  const isUpdatingRef = useRef(false);

  // Dashboard layout hook
  const {
    layouts,
    currentLayout,
    loading,
    saving,
    error,
    loadLayout,
    saveLayout,
    quickSave,
    deleteLayout,
    setAsDefault,
    updateWidgets,
    setCurrentLayout,
    clearError,
  } = useDashboardLayout();

  // Load active processes for background/widget selection
  const { processes: activeProcesses, loading: processesLoading } = useActiveProcesses();

  const [isEditMode, setIsEditMode] = useState(false);
  const [localWidgets, setLocalWidgets] = useState<WidgetConfig[]>([]);
  const [showConfigModal, setShowConfigModal] = useState(false);
  const [editingWidget, setEditingWidget] = useState<WidgetConfig | null>(null);
  const [showSaveModal, setShowSaveModal] = useState(false);
  const [saveAsNew, setSaveAsNew] = useState(false);
  const [showLayoutDropdown, setShowLayoutDropdown] = useState(false);
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);
  const [showProcessDropdown, setShowProcessDropdown] = useState(false);

  // Process background state
  const [processBackground, setProcessBackground] = useState<ProcessBackground>({
    processId: null,
    position: { x: 0, y: 0 },
    scale: 1,
    opacity: 0.3,
  });

  // Sync local widgets with current layout
  useEffect(() => {
    if (currentLayout?.widgets) {
      setLocalWidgets(currentLayout.widgets);
      setHasUnsavedChanges(false);
    } else {
      setLocalWidgets([]);
    }

    // Sync process background
    if (currentLayout?.processBackground) {
      setProcessBackground(currentLayout.processBackground);
    } else {
      setProcessBackground({
        processId: null,
        position: { x: 0, y: 0 },
        scale: 1,
        opacity: 0.3,
      });
    }
  }, [currentLayout]);

  // Calculate used channel IDs for duplicate prevention
  const usedChannelIds = useMemo(() => {
    const ids = new Set<string>();
    localWidgets.forEach((widget) => {
      widget.dataChannelIds?.forEach((id) => ids.add(id));
    });
    return ids;
  }, [localWidgets]);

  // Initialize GridStack
  useEffect(() => {
    if (!gridRef.current || localWidgets.length === 0) return;

    // Clean up existing instance
    if (gridInstanceRef.current) {
      gridInstanceRef.current.destroy(false);
    }

    // Initialize GridStack with options - 24 columns for finer placement
    const grid = GridStack.init(
      {
        column: 24,
        cellHeight: 40,
        margin: 4,
        float: true,
        animate: true,
        resizable: {
          handles: 'e,se,s,sw,w',
        },
        draggable: {
          handle: '.widget-drag-handle',
        },
        disableDrag: !isEditMode,
        disableResize: !isEditMode,
      },
      gridRef.current
    );

    gridInstanceRef.current = grid;

    // Listen for changes - filter out phantom DOM elements
    // Bug #6 fix: Use isUpdatingRef to prevent race conditions
    grid.on('change', () => {
      // Skip if we're already updating to prevent re-entrance
      if (isUpdatingRef.current) return;

      isUpdatingRef.current = true;
      try {
        const items = grid.getGridItems();
        const updatedWidgets = items
          .map((el) => {
            const node = el.gridstackNode;
            const widgetId = el.getAttribute('data-widget-id');

            // Skip DOM elements without widget ID (GridStack creates temp elements during drag)
            if (!widgetId) return null;

            const existingWidget = localWidgets.find((w) => w.id === widgetId);
            // Skip if widget not found in our state
            if (!existingWidget) return null;

            return {
              ...existingWidget,
              gridPosition: {
                x: node?.x || 0,
                y: node?.y || 0,
                w: node?.w || 2,
                h: node?.h || 2,
              },
            };
          })
          .filter((w): w is WidgetConfig => w !== null);

        setLocalWidgets(updatedWidgets);
        setHasUnsavedChanges(true);
      } finally {
        // Use setTimeout to ensure React state update completes before allowing next update
        setTimeout(() => {
          isUpdatingRef.current = false;
        }, 0);
      }
    });

    return () => {
      grid.destroy(false);
    };
  }, [localWidgets.length > 0 ? localWidgets.map(w => w.id).join(',') : '']);

  // Update GridStack edit mode
  useEffect(() => {
    if (gridInstanceRef.current) {
      gridInstanceRef.current.enableMove(isEditMode);
      gridInstanceRef.current.enableResize(isEditMode);
    }
  }, [isEditMode]);

  // Handle adding widget
  // NOTE: Do NOT call gridInstanceRef.current.addWidget() here!
  // React will render the new widget in JSX, and the useEffect will re-initialize GridStack.
  // Calling addWidget would create duplicate DOM elements - one from GridStack (empty) and one from React (styled).
  const handleAddWidget = useCallback((config: WidgetConfig) => {
    const newWidget: WidgetConfig = {
      ...config,
      id: `widget-${Date.now()}`,
      gridPosition: config.gridPosition || { x: 0, y: 0, w: 3, h: 3 },
    };

    setLocalWidgets((prev) => [...prev, newWidget]);
    setShowConfigModal(false);
    setEditingWidget(null);
    setHasUnsavedChanges(true);
    // GridStack will be re-initialized by useEffect when localWidgets changes
  }, []);

  // Handle removing widget
  const handleRemoveWidget = useCallback((widgetId: string) => {
    setLocalWidgets((prev) => prev.filter((w) => w.id !== widgetId));
    setHasUnsavedChanges(true);

    if (gridInstanceRef.current) {
      const el = gridRef.current?.querySelector(`[data-widget-id="${widgetId}"]`);
      if (el) {
        gridInstanceRef.current.removeWidget(el as HTMLElement);
      }
    }
  }, []);

  // Handle editing widget
  const handleEditWidget = useCallback((widget: WidgetConfig) => {
    setEditingWidget(widget);
    setShowConfigModal(true);
  }, []);

  // Handle update widget (from edit)
  const handleUpdateWidget = useCallback((config: WidgetConfig) => {
    setLocalWidgets((prev) =>
      prev.map((w) => (w.id === config.id ? config : w))
    );
    setShowConfigModal(false);
    setEditingWidget(null);
    setHasUnsavedChanges(true);
  }, []);

  // Handle quick save (update current layout)
  const handleQuickSave = useCallback(async () => {
    if (!currentLayout?.id) {
      // No existing layout - show save dialog
      setSaveAsNew(true);
      setShowSaveModal(true);
      return;
    }

    const success = await quickSave(localWidgets);
    if (success) {
      setHasUnsavedChanges(false);
      setIsEditMode(false);
    }
  }, [currentLayout, localWidgets, quickSave]);

  // Handle save (new or update)
  const handleSave = useCallback(
    async (name: string, description?: string, setDefault?: boolean) => {
      const input: SaveLayoutInput = {
        id: saveAsNew ? undefined : currentLayout?.id,
        name,
        description,
        widgets: localWidgets,
        processBackground: processBackground.processId ? processBackground : undefined,
        gridConfig: { columns: 24, cellHeight: 40, margin: 4 },
        gridVersion: 2,
        isDefault: setDefault,
      };

      const savedLayout = await saveLayout(input);
      if (savedLayout) {
        setShowSaveModal(false);
        setSaveAsNew(false);
        setHasUnsavedChanges(false);
        setIsEditMode(false);
      }
    },
    [currentLayout, localWidgets, processBackground, saveLayout, saveAsNew]
  );

  // Handle layout selection
  const handleLayoutSelect = useCallback(
    async (layoutId: string) => {
      if (hasUnsavedChanges) {
        const confirm = window.confirm(
          'You have unsaved changes. Do you want to continue?'
        );
        if (!confirm) return;
      }
      await loadLayout(layoutId);
      setShowLayoutDropdown(false);
      setIsEditMode(false);
    },
    [loadLayout, hasUnsavedChanges]
  );

  // Handle set as default
  const handleSetAsDefault = useCallback(
    async (layoutId: string) => {
      await setAsDefault(layoutId);
      setShowLayoutDropdown(false);
    },
    [setAsDefault]
  );

  // Handle delete layout
  const handleDeleteLayout = useCallback(
    async (layoutId: string) => {
      const confirm = window.confirm(
        'This layout will be deleted. Are you sure?'
      );
      if (!confirm) return;
      await deleteLayout(layoutId);
      setShowLayoutDropdown(false);
    },
    [deleteLayout]
  );

  // Loading state
  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 size={32} className="animate-spin text-cyan-600" />
        <span className="ml-2 text-gray-600">Loading dashboard...</span>
      </div>
    );
  }

  return (
    <div className={`flex flex-col h-full ${className}`}>
      {/* Error Banner */}
      {error && (
        <div className="flex items-center gap-2 px-4 py-2 bg-red-50 border-b border-red-200 text-red-700">
          <AlertCircle size={16} />
          <span className="text-sm">{error}</span>
          <button
            onClick={clearError}
            className="ml-auto text-red-500 hover:text-red-700"
          >
            Close
          </button>
        </div>
      )}

      {/* Toolbar */}
      <div className="flex items-center justify-between px-4 py-2 bg-white border-b border-gray-200">
        <div className="flex items-center gap-3">
          {/* Layout Selector */}
          <div className="relative">
            <button
              onClick={() => setShowLayoutDropdown(!showLayoutDropdown)}
              className="flex items-center gap-2 px-3 py-1.5 bg-gray-100 rounded-lg hover:bg-gray-200 transition-colors"
            >
              <span className="font-medium text-gray-900">
                {currentLayout?.name || 'Select Layout'}
              </span>
              {currentLayout?.isDefault && (
                <Star size={14} className="text-yellow-500 fill-current" />
              )}
              <ChevronDown size={16} className="text-gray-500" />
            </button>

            {/* Dropdown */}
            {showLayoutDropdown && (
              <div className="absolute top-full left-0 mt-1 w-72 bg-white rounded-lg shadow-lg border border-gray-200 z-50">
                <div className="p-2 border-b border-gray-100">
                  <span className="text-xs font-medium text-gray-500 uppercase">
                    Saved Layouts
                  </span>
                </div>
                <div className="max-h-64 overflow-y-auto">
                  {layouts.length === 0 ? (
                    <div className="p-4 text-center text-gray-500 text-sm">
                      No saved layouts yet
                    </div>
                  ) : (
                    layouts.map((layout) => (
                      <div
                        key={layout.id}
                        className={`
                          flex items-center justify-between px-3 py-2 hover:bg-gray-50
                          ${currentLayout?.id === layout.id ? 'bg-cyan-50' : ''}
                        `}
                      >
                        <button
                          onClick={() => handleLayoutSelect(layout.id)}
                          className="flex-1 text-left"
                        >
                          <span className="font-medium text-gray-900">
                            {layout.name}
                          </span>
                          {layout.isDefault && (
                            <Star
                              size={12}
                              className="inline ml-1 text-yellow-500 fill-current"
                            />
                          )}
                          {layout.isSystemDefault && (
                            <span className="text-xs text-gray-500 ml-1">
                              (System)
                            </span>
                          )}
                        </button>
                        <div className="flex items-center gap-1">
                          {!layout.isDefault && !layout.isSystemDefault && (
                            <button
                              onClick={() => handleSetAsDefault(layout.id)}
                              className="p-1 text-gray-400 hover:text-yellow-500"
                              title="Set as default"
                            >
                              <Star size={14} />
                            </button>
                          )}
                          {!layout.isSystemDefault && (
                            <button
                              onClick={() => handleDeleteLayout(layout.id)}
                              className="p-1 text-gray-400 hover:text-red-500"
                              title="Delete"
                            >
                              <Trash2 size={14} />
                            </button>
                          )}
                        </div>
                      </div>
                    ))
                  )}
                </div>
                <div className="p-2 border-t border-gray-100">
                  <button
                    onClick={() => {
                      setSaveAsNew(true);
                      setShowSaveModal(true);
                      setShowLayoutDropdown(false);
                    }}
                    className="w-full flex items-center justify-center gap-2 px-3 py-2 text-sm text-cyan-600 hover:bg-cyan-50 rounded-lg"
                  >
                    <Plus size={16} />
                    Create New Layout
                  </button>
                </div>
              </div>
            )}
          </div>

          <span className="text-sm text-gray-500">
            {localWidgets.length} widget
            {hasUnsavedChanges && (
              <span className="text-amber-600 ml-2">(unsaved)</span>
            )}
          </span>

          {/* Process Background Selector */}
          <div className="relative">
            <button
              onClick={() => setShowProcessDropdown(!showProcessDropdown)}
              className={`flex items-center gap-2 px-3 py-1.5 rounded-lg transition-colors ${
                processBackground.processId
                  ? 'bg-cyan-100 text-cyan-700 hover:bg-cyan-200'
                  : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
              }`}
            >
              <GitFork size={16} />
              <span className="text-sm">
                {processBackground.processId
                  ? activeProcesses.find(p => p.id === processBackground.processId)?.name || 'Process BG'
                  : 'No Background'
                }
              </span>
              <ChevronDown size={16} />
            </button>

            {/* Process Dropdown */}
            {showProcessDropdown && (
              <div className="absolute top-full left-0 mt-1 w-64 bg-white rounded-lg shadow-lg border border-gray-200 z-50">
                <div className="p-2 border-b border-gray-100">
                  <span className="text-xs font-medium text-gray-500 uppercase">
                    Process Background
                  </span>
                </div>
                <div className="max-h-48 overflow-y-auto">
                  <button
                    onClick={() => {
                      setProcessBackground(prev => ({ ...prev, processId: null }));
                      setShowProcessDropdown(false);
                      setHasUnsavedChanges(true);
                    }}
                    className={`w-full px-3 py-2 text-left text-sm hover:bg-gray-50 ${
                      !processBackground.processId ? 'bg-cyan-50 text-cyan-700' : ''
                    }`}
                  >
                    None
                  </button>
                  {activeProcesses.map(process => (
                    <button
                      key={process.id}
                      onClick={() => {
                        setProcessBackground(prev => ({ ...prev, processId: process.id }));
                        setShowProcessDropdown(false);
                        setHasUnsavedChanges(true);
                      }}
                      className={`w-full px-3 py-2 text-left text-sm hover:bg-gray-50 ${
                        processBackground.processId === process.id ? 'bg-cyan-50 text-cyan-700' : ''
                      }`}
                    >
                      {process.name}
                    </button>
                  ))}
                  {activeProcesses.length === 0 && (
                    <div className="px-3 py-2 text-sm text-gray-400">
                      No processes available
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>

          {/* Opacity Slider (only shown when process background is selected and in edit mode) */}
          {processBackground.processId && isEditMode && (
            <div className="flex items-center gap-2 px-3 py-1.5 bg-gray-100 rounded-lg">
              <span className="text-xs text-gray-500">Opacity:</span>
              <input
                type="range"
                min="0.1"
                max="1"
                step="0.1"
                value={processBackground.opacity}
                onChange={(e) => {
                  setProcessBackground(prev => ({
                    ...prev,
                    opacity: parseFloat(e.target.value)
                  }));
                  setHasUnsavedChanges(true);
                }}
                className="w-20 h-1 bg-gray-300 rounded-lg appearance-none cursor-pointer"
              />
              <span className="text-xs text-gray-600 w-8">
                {Math.round(processBackground.opacity * 100)}%
              </span>
            </div>
          )}

          {/* Reset Background Position (only in edit mode with background) */}
          {processBackground.processId && isEditMode && (
            <button
              onClick={() => {
                setProcessBackground(prev => ({
                  ...prev,
                  position: { x: 0, y: 0 },
                  scale: 1,
                }));
                setHasUnsavedChanges(true);
              }}
              className="p-1.5 text-gray-500 hover:text-gray-700 hover:bg-gray-200 rounded transition-colors"
              title="Reset background position"
            >
              <RotateCcw size={16} />
            </button>
          )}
        </div>

        <div className="flex items-center gap-2">
          {isEditMode ? (
            <>
              <button
                onClick={() => setShowConfigModal(true)}
                className="flex items-center gap-2 px-3 py-1.5 bg-cyan-600 text-white rounded-lg hover:bg-cyan-700 transition-colors"
              >
                <Plus size={16} />
                Add Widget
              </button>
              <button
                onClick={handleQuickSave}
                disabled={saving}
                className="flex items-center gap-2 px-3 py-1.5 bg-green-600 text-white rounded-lg hover:bg-green-700 transition-colors disabled:opacity-50"
              >
                {saving ? (
                  <Loader2 size={16} className="animate-spin" />
                ) : (
                  <Save size={16} />
                )}
                Save
              </button>
              <button
                onClick={() => {
                  setSaveAsNew(true);
                  setShowSaveModal(true);
                }}
                className="flex items-center gap-2 px-3 py-1.5 bg-gray-100 text-gray-700 rounded-lg hover:bg-gray-200 transition-colors"
              >
                <Copy size={16} />
                Save As
              </button>
              <button
                onClick={() => {
                  setIsEditMode(false);
                  // Reset to saved state
                  if (currentLayout?.widgets) {
                    setLocalWidgets(currentLayout.widgets);
                    setHasUnsavedChanges(false);
                  }
                }}
                className="flex items-center gap-2 px-3 py-1.5 bg-gray-100 text-gray-700 rounded-lg hover:bg-gray-200 transition-colors"
              >
                <Eye size={16} />
                Cancel
              </button>
            </>
          ) : (
            <button
              onClick={() => setIsEditMode(true)}
              className="flex items-center gap-2 px-3 py-1.5 bg-gray-100 text-gray-700 rounded-lg hover:bg-gray-200 transition-colors"
            >
              <Edit2 size={16} />
              Edit
            </button>
          )}
        </div>
      </div>

      {/* Click outside to close dropdowns */}
      {(showLayoutDropdown || showProcessDropdown) && (
        <div
          className="fixed inset-0 z-40"
          onClick={() => {
            setShowLayoutDropdown(false);
            setShowProcessDropdown(false);
          }}
        />
      )}

      {/* Grid Container */}
      <div className="flex-1 overflow-hidden relative bg-gray-50">
        {/* Process Background Layer */}
        {processBackground.processId && (
          <div
            className="absolute inset-0 overflow-hidden"
            style={{ zIndex: 0 }}
          >
            <ProcessBackgroundLayer
              processId={processBackground.processId}
              position={processBackground.position}
              scale={processBackground.scale}
              opacity={processBackground.opacity}
              onPositionChange={(pos) => {
                setProcessBackground(prev => ({ ...prev, position: pos }));
                setHasUnsavedChanges(true);
              }}
              onScaleChange={(scale) => {
                setProcessBackground(prev => ({ ...prev, scale }));
                setHasUnsavedChanges(true);
              }}
              isEditMode={isEditMode}
            />
          </div>
        )}

        {/* Scrollable Grid Area */}
        <div className="h-full overflow-auto p-4 relative" style={{ zIndex: 1 }}>
          {localWidgets.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full text-gray-400">
              <div className="text-center">
                <Settings size={48} className="mx-auto mb-4 opacity-50" />
                <p className="text-lg font-medium mb-2">Dashboard Empty</p>
                <p className="text-sm mb-4">
                  Click the "Edit" button to add widgets
                </p>
                <button
                  onClick={() => {
                    setIsEditMode(true);
                    setShowConfigModal(true);
                  }}
                  className="flex items-center gap-2 px-4 py-2 bg-cyan-600 text-white rounded-lg hover:bg-cyan-700 transition-colors mx-auto"
                >
                  <Plus size={16} />
                  Add First Widget
                </button>
              </div>
            </div>
          ) : (
            <div ref={gridRef} className="grid-stack">
              {localWidgets.map((widget) => (
              <div
                key={widget.id}
                className="grid-stack-item"
                data-widget-id={widget.id}
                gs-x={widget.gridPosition.x}
                gs-y={widget.gridPosition.y}
                gs-w={widget.gridPosition.w}
                gs-h={widget.gridPosition.h}
              >
                <div className="grid-stack-item-content bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden">
                  {/* Widget Header */}
                  <div className="widget-drag-handle flex items-center justify-between px-3 py-2 bg-gray-50 border-b border-gray-200 cursor-move">
                    <span className="text-sm font-medium text-gray-700 truncate">
                      {widget.title}
                    </span>
                    {isEditMode && (
                      <div className="flex items-center gap-1">
                        <button
                          onClick={() => handleEditWidget(widget)}
                          className="p-1 text-gray-400 hover:text-gray-600 rounded"
                          title="Edit"
                        >
                          <Settings size={14} />
                        </button>
                        <button
                          onClick={() => handleRemoveWidget(widget.id)}
                          className="p-1 text-gray-400 hover:text-red-600 rounded"
                          title="Remove"
                        >
                          <Trash2 size={14} />
                        </button>
                      </div>
                    )}
                  </div>

                  {/* Widget Content */}
                  <div className="p-3 h-[calc(100%-40px)]">
                    <WidgetContent config={widget} />
                  </div>
                </div>
              </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Widget Config Modal */}
      {showConfigModal && (
        <WidgetConfigModal
          isOpen={showConfigModal}
          onClose={() => {
            setShowConfigModal(false);
            setEditingWidget(null);
          }}
          onSave={editingWidget ? handleUpdateWidget : handleAddWidget}
          editingWidget={editingWidget}
          usedChannelIds={usedChannelIds}
        />
      )}

      {/* Save Layout Modal */}
      <SaveLayoutModal
        isOpen={showSaveModal}
        onClose={() => {
          setShowSaveModal(false);
          setSaveAsNew(false);
        }}
        onSave={handleSave}
        saving={saving}
        defaultName={saveAsNew ? '' : currentLayout?.name || ''}
        isUpdate={!saveAsNew && !!currentLayout?.id}
      />
    </div>
  );
};

export default GridStackDashboard;
