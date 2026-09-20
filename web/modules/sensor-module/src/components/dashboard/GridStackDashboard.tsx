/**
 * GridStack Dashboard Component
 *
 * Drag-and-drop widget grid for sensor data visualization.
 * Uses GridStack.js for responsive grid layout.
 * Persists layouts to database via useDashboardLayout hook.
 */

import React, { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import {
  Button,
  Checkbox,
  Input,
  Modal,
  Slider,
  Spinner,
  Textarea,
  ToggleButton,
  useClickOutside,
  useConfirm,
} from '@aquaculture/shared-ui';
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
import { AlertWidgetContent } from './widgets/AlertWidgetContent';
import { HeatmapWidgetContent } from './widgets/HeatmapWidgetContent';
import {
  useDashboardLayout,
  DashboardLayout,
  SaveLayoutInput,
  ProcessBackground,
} from '../../hooks/useDashboardLayout';
export type { DashboardLayout } from '../../hooks/useDashboardLayout';
import { useActiveProcesses } from '../../hooks/useProcess';

// ============================================================================
// Types
// ============================================================================

interface GridStackDashboardProps {
  className?: string;
  /** Legacy prop - layout is now managed internally via useDashboardLayout */
  initialLayout?: DashboardLayout;
  /** Legacy prop - layout changes are now persisted internally */
  onLayoutChange?: (layout: DashboardLayout) => void;
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
      return <HeatmapWidgetContent config={config} />;
    case 'alert':
      return <AlertWidgetContent config={config} />;
    case 'process-view':
      return <ProcessViewWidgetContent config={config} />;
    default:
      return (
        <div className="flex items-center justify-center h-full text-gray-500 dark:text-gray-400">
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

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      size="sm"
      title={isUpdate ? 'Update Layout' : 'Save New Layout'}
      showCloseButton={!saving}
      closeOnEscape={!saving}
      closeOnOverlayClick={!saving}
      bodyClassName="p-6"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <button
            onClick={() => onSave(name, description, setAsDefault)}
            disabled={!name.trim() || saving}
            className={`
              flex items-center gap-2 px-4 py-2 rounded-lg transition-colors
              ${
                name.trim() && !saving
                  ? 'bg-info-600 text-white hover:bg-info-700'
                  : 'bg-gray-300 text-gray-500 dark:text-gray-400 cursor-not-allowed'
              }
            `}
          >
            {saving && <Spinner size="sm" color="inherit" />}
            {isUpdate ? 'Update' : 'Save'}
          </button>
        </>
      }
    >
      <div className="space-y-4">
        <Input
          label="Layout Name"
          fullWidth
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Enter dashboard name"
        />

        <Textarea
          label="Description (Optional)"
          fullWidth
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Layout description"
          rows={2}
        />

        <Checkbox
          label="Set as default"
          checked={setAsDefault}
          onChange={(e) => setSetAsDefault(e.target.checked)}
        />
      </div>
    </Modal>
  );
};

// ============================================================================
// GridStack Dashboard Component
// ============================================================================

export const GridStackDashboard: React.FC<GridStackDashboardProps> = ({ className = '' }) => {
  const confirm = useConfirm();
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
  const layoutDropdownRef = useRef<HTMLDivElement>(null);
  const processDropdownRef = useRef<HTMLDivElement>(null);
  useClickOutside(layoutDropdownRef, () => setShowLayoutDropdown(false), showLayoutDropdown);
  useClickOutside(processDropdownRef, () => setShowProcessDropdown(false), showProcessDropdown);

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

  // Initialize GridStack ONCE — PERF-002: do not destroy/re-init on every widget add/remove.
  // Widget additions and removals are handled by GridStack.makeWidget()/removeWidget() below.
  useEffect(() => {
    if (!gridRef.current) return;

    if (gridInstanceRef.current) return; // already initialized — don't re-init

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
      gridRef.current,
    );

    gridInstanceRef.current = grid;

    // Listen for changes - filter out phantom DOM elements
    // PERF-009: use O(1) Map lookup instead of O(N) find per item; only commit on dragstop/resizestop
    const widgetMap = new Map(localWidgets.map((w) => [w.id, w]));

    const applyGridPositions = () => {
      if (isUpdatingRef.current) return;
      isUpdatingRef.current = true;
      try {
        const items = grid.getGridItems();
        const updatedWidgets = items
          .map((el) => {
            const node = el.gridstackNode;
            const widgetId = el.getAttribute('data-widget-id');
            if (!widgetId) return null;
            const existingWidget = widgetMap.get(widgetId);
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
        setTimeout(() => {
          isUpdatingRef.current = false;
        }, 0);
      }
    };

    // Commit only on drag/resize end to avoid continuous state updates during drag (PERF-009)
    grid.on('dragstop resizestop', applyGridPositions);

    return () => {
      grid.destroy(false);
      gridInstanceRef.current = null;
    };
  }, []); // PERF-002: run once on mount — add/remove is handled by makeWidget/removeWidget below

  // PERF-002: Register new DOM nodes with GridStack when localWidgets changes (instead of full re-init)
  useEffect(() => {
    const grid = gridInstanceRef.current;
    if (!grid || !gridRef.current) return;

    const registeredIds = new Set<string>();
    grid.getGridItems().forEach((el) => {
      const id = el.getAttribute('data-widget-id');
      if (id) registeredIds.add(id);
    });

    // Make any newly rendered DOM nodes known to GridStack
    localWidgets.forEach((w) => {
      if (registeredIds.has(w.id)) return;
      const el = gridRef.current?.querySelector(`[data-widget-id="${w.id}"]`) as HTMLElement | null;
      if (el) grid.makeWidget(el);
    });
  }, [localWidgets]);

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
      // BUG-012: use crypto.randomUUID() to avoid millisecond-resolution collision
      id: `widget-${typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2)}`,
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
    setLocalWidgets((prev) => prev.map((w) => (w.id === config.id ? config : w)));
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
    [currentLayout, localWidgets, processBackground, saveLayout, saveAsNew],
  );

  // Handle layout selection
  const handleLayoutSelect = useCallback(
    async (layoutId: string) => {
      if (hasUnsavedChanges) {
        const proceed = await confirm({
          title: 'Discard unsaved changes?',
          message: 'Switching layouts drops the edits you have not saved.',
          confirmText: 'Discard and switch',
          cancelText: 'Stay',
          variant: 'warning',
        });
        if (!proceed) return;
      }
      await loadLayout(layoutId);
      setShowLayoutDropdown(false);
      setIsEditMode(false);
    },
    [loadLayout, hasUnsavedChanges, confirm],
  );

  // Handle set as default
  const handleSetAsDefault = useCallback(
    async (layoutId: string) => {
      await setAsDefault(layoutId);
      setShowLayoutDropdown(false);
    },
    [setAsDefault],
  );

  // Handle delete layout
  const handleDeleteLayout = useCallback(
    async (layoutId: string) => {
      const proceed = await confirm({
        title: 'Delete this layout?',
        confirmText: 'Delete',
        cancelText: 'Cancel',
        variant: 'danger',
      });
      if (!proceed) return;
      await deleteLayout(layoutId);
      setShowLayoutDropdown(false);
    },
    [deleteLayout, confirm],
  );

  // Loading state
  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Spinner size="lg" />
        <span className="ml-2 text-gray-600 dark:text-gray-400">Loading dashboard...</span>
      </div>
    );
  }

  return (
    <div className={`flex flex-col h-full ${className}`}>
      {/* Error Banner */}
      {error && (
        <div className="flex items-center gap-2 px-4 py-2 bg-error-50 dark:bg-error-900/20 border-b border-error-200 dark:border-error-800 text-error-700 dark:text-error-300">
          <AlertCircle size={16} />
          <span className="text-sm">{error}</span>
          <Button variant="ghost" onClick={clearError}>
            Close
          </Button>
        </div>
      )}

      {/* Toolbar */}
      <div className="flex items-center justify-between px-4 py-2 bg-white dark:bg-gray-900 border-b border-gray-200 dark:border-gray-700">
        <div className="flex items-center gap-3">
          {/* Layout Selector */}
          <div className="relative" ref={layoutDropdownRef}>
            <button
              onClick={() => setShowLayoutDropdown(!showLayoutDropdown)}
              className="flex items-center gap-2 px-3 py-1.5 bg-gray-100 dark:bg-gray-800 rounded-lg hover:bg-gray-200 dark:hover:bg-gray-600 transition-colors"
            >
              <span className="font-medium text-gray-900 dark:text-gray-100">
                {currentLayout?.name || 'Select Layout'}
              </span>
              {currentLayout?.isDefault && (
                <Star size={14} className="text-warning-500 fill-current" />
              )}
              <ChevronDown size={16} className="text-gray-500 dark:text-gray-400" />
            </button>

            {/* Dropdown */}
            {showLayoutDropdown && (
              <div className="absolute top-full left-0 mt-1 w-72 bg-white dark:bg-gray-900 rounded-lg shadow-lg border border-gray-200 dark:border-gray-700 z-50">
                <div className="p-2 border-b border-gray-100 dark:border-gray-700">
                  <span className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">
                    Saved Layouts
                  </span>
                </div>
                <div className="max-h-64 overflow-y-auto">
                  {layouts.length === 0 ? (
                    <div className="p-4 text-center text-gray-500 dark:text-gray-400 text-sm">
                      No saved layouts yet
                    </div>
                  ) : (
                    layouts.map((layout) => (
                      <div
                        key={layout.id}
                        className={`
                          flex items-center justify-between px-3 py-2 hover:bg-gray-50 dark:hover:bg-gray-800
                          ${currentLayout?.id === layout.id ? 'bg-info-50 dark:bg-info-900/20' : ''}
                        `}
                      >
                        <Button
                          variant="ghost"
                          className="flex-1"
                          onClick={() => handleLayoutSelect(layout.id)}
                        >
                          <span className="font-medium text-gray-900 dark:text-gray-100">
                            {layout.name}
                          </span>
                          {layout.isDefault && (
                            <Star size={12} className="inline ml-1 text-warning-500 fill-current" />
                          )}
                          {layout.isSystemDefault && (
                            <span className="text-xs text-gray-500 dark:text-gray-400 ml-1">
                              (System)
                            </span>
                          )}
                        </Button>
                        <div className="flex items-center gap-1">
                          {!layout.isDefault && !layout.isSystemDefault && (
                            <Button
                              variant="ghost"
                              size="sm"
                              iconOnly
                              aria-label="Set as default"
                              onClick={() => handleSetAsDefault(layout.id)}
                              title="Set as default"
                            >
                              <Star size={14} />
                            </Button>
                          )}
                          {!layout.isSystemDefault && (
                            <Button
                              variant="ghost"
                              size="sm"
                              iconOnly
                              aria-label="Delete"
                              onClick={() => handleDeleteLayout(layout.id)}
                              title="Delete"
                            >
                              <Trash2 size={14} />
                            </Button>
                          )}
                        </div>
                      </div>
                    ))
                  )}
                </div>
                <div className="p-2 border-t border-gray-100 dark:border-gray-700">
                  <Button
                    variant="ghost"
                    size="sm"
                    className="justify-center"
                    leftIcon={<Plus size={16} />}
                    onClick={() => {
                      setSaveAsNew(true);
                      setShowSaveModal(true);
                      setShowLayoutDropdown(false);
                    }}
                  >
                    Create New Layout
                  </Button>
                </div>
              </div>
            )}
          </div>

          <span className="text-sm text-gray-500 dark:text-gray-400">
            {localWidgets.length} widget
            {hasUnsavedChanges && (
              <span className="text-warning-600 dark:text-warning-400 ml-2">(unsaved)</span>
            )}
          </span>

          {/* Process Background Selector */}
          <div className="relative" ref={processDropdownRef}>
            <button
              onClick={() => setShowProcessDropdown(!showProcessDropdown)}
              aria-expanded={showProcessDropdown}
              aria-haspopup="listbox"
              className={`flex items-center gap-2 px-3 py-1.5 rounded-lg transition-colors ${
                processBackground.processId
                  ? 'bg-info-100 dark:bg-info-900/40 text-info-700 dark:text-info-300 hover:bg-info-200 dark:hover:bg-info-800/60'
                  : 'bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600'
              }`}
            >
              <GitFork size={16} />
              <span className="text-sm">
                {processBackground.processId
                  ? activeProcesses.find((p) => p.id === processBackground.processId)?.name ||
                    'Process BG'
                  : 'No Background'}
              </span>
              <ChevronDown size={16} />
            </button>

            {/* Process Dropdown */}
            {showProcessDropdown && (
              <div className="absolute top-full left-0 mt-1 w-64 bg-white dark:bg-gray-900 rounded-lg shadow-lg border border-gray-200 dark:border-gray-700 z-50">
                <div className="p-2 border-b border-gray-100 dark:border-gray-700">
                  <span className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">
                    Process Background
                  </span>
                </div>
                <div className="max-h-48 overflow-y-auto">
                  <ToggleButton
                    onClick={() => {
                      setProcessBackground((prev) => ({ ...prev, processId: null }));
                      setShowProcessDropdown(false);
                      setHasUnsavedChanges(true);
                    }}
                    pressed={!processBackground.processId}
                    className="w-full px-3 py-2 text-left text-sm hover:bg-gray-50 dark:hover:bg-gray-800"
                    pressedClassName="bg-info-50 dark:bg-info-900/20 text-info-700 dark:text-info-300"
                  >
                    None
                  </ToggleButton>
                  {activeProcesses.map((process) => (
                    <ToggleButton
                      key={process.id}
                      onClick={() => {
                        setProcessBackground((prev) => ({ ...prev, processId: process.id }));
                        setShowProcessDropdown(false);
                        setHasUnsavedChanges(true);
                      }}
                      pressed={processBackground.processId === process.id}
                      className="w-full px-3 py-2 text-left text-sm hover:bg-gray-50 dark:hover:bg-gray-800"
                      pressedClassName="bg-info-50 dark:bg-info-900/20 text-info-700 dark:text-info-300"
                    >
                      {process.name}
                    </ToggleButton>
                  ))}
                  {activeProcesses.length === 0 && (
                    <div className="px-3 py-2 text-sm text-gray-500 dark:text-gray-400">
                      No processes available
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>

          {/* Opacity Slider (only shown when process background is selected and in edit mode) */}
          {processBackground.processId && isEditMode && (
            <div className="flex items-center gap-2 px-3 py-1.5 bg-gray-100 dark:bg-gray-800 rounded-lg">
              <label
                htmlFor="process-background-opacity"
                className="text-xs text-gray-500 dark:text-gray-400"
              >
                Opacity:
              </label>
              <Slider
                id="process-background-opacity"
                size="xs"
                fullWidth={false}
                className="w-20"
                min={0.1}
                max={1}
                step={0.1}
                value={processBackground.opacity}
                onChange={(opacity) => {
                  setProcessBackground((prev) => ({ ...prev, opacity }));
                  setHasUnsavedChanges(true);
                }}
              />
              <span className="text-xs text-gray-600 dark:text-gray-400 w-8">
                {Math.round(processBackground.opacity * 100)}%
              </span>
            </div>
          )}

          {/* Reset Background Position (only in edit mode with background) */}
          {processBackground.processId && isEditMode && (
            <Button
              variant="ghost"
              size="sm"
              iconOnly
              aria-label="Reset background position"
              onClick={() => {
                setProcessBackground((prev) => ({
                  ...prev,
                  position: { x: 0, y: 0 },
                  scale: 1,
                }));
                setHasUnsavedChanges(true);
              }}
              title="Reset background position"
            >
              <RotateCcw size={16} />
            </Button>
          )}
        </div>

        <div className="flex items-center gap-2">
          {isEditMode ? (
            <>
              <Button
                variant="primary"
                size="sm"
                leftIcon={<Plus size={16} />}
                onClick={() => setShowConfigModal(true)}
              >
                Add Widget
              </Button>
              <Button variant="primary" size="sm" onClick={handleQuickSave} disabled={saving}>
                {saving ? <Spinner size="sm" color="inherit" /> : <Save size={16} />}
                Save
              </Button>
              <button
                onClick={() => {
                  setSaveAsNew(true);
                  setShowSaveModal(true);
                }}
                className="flex items-center gap-2 px-3 py-1.5 bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300 rounded-lg hover:bg-gray-200 dark:hover:bg-gray-600 transition-colors"
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
                className="flex items-center gap-2 px-3 py-1.5 bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300 rounded-lg hover:bg-gray-200 dark:hover:bg-gray-600 transition-colors"
              >
                <Eye size={16} />
                Cancel
              </button>
            </>
          ) : (
            <button
              onClick={() => setIsEditMode(true)}
              className="flex items-center gap-2 px-3 py-1.5 bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300 rounded-lg hover:bg-gray-200 dark:hover:bg-gray-600 transition-colors"
            >
              <Edit2 size={16} />
              Edit
            </button>
          )}
        </div>
      </div>

      {/* Grid Container */}
      <div className="flex-1 overflow-hidden relative bg-gray-50 dark:bg-gray-800">
        {/* Process Background Layer */}
        {processBackground.processId && (
          <div className="absolute inset-0 overflow-hidden z-0">
            <ProcessBackgroundLayer
              processId={processBackground.processId}
              position={processBackground.position}
              scale={processBackground.scale}
              opacity={processBackground.opacity}
              onPositionChange={(pos) => {
                setProcessBackground((prev) => ({ ...prev, position: pos }));
                setHasUnsavedChanges(true);
              }}
              onScaleChange={(scale) => {
                setProcessBackground((prev) => ({ ...prev, scale }));
                setHasUnsavedChanges(true);
              }}
              isEditMode={isEditMode}
            />
          </div>
        )}

        {/* Scrollable Grid Area */}
        <div className="h-full overflow-auto p-4 relative z-[1]">
          {localWidgets.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full text-gray-500 dark:text-gray-400">
              <div className="text-center">
                <Settings size={48} className="mx-auto mb-4 opacity-50" />
                <p className="text-lg font-medium mb-2">Dashboard Empty</p>
                <p className="text-sm mb-4">Click the "Edit" button to add widgets</p>
                <Button
                  variant="primary"
                  leftIcon={<Plus size={16} />}
                  onClick={() => {
                    setIsEditMode(true);
                    setShowConfigModal(true);
                  }}
                >
                  Add First Widget
                </Button>
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
                  <div className="grid-stack-item-content bg-white dark:bg-gray-900 rounded-lg shadow-sm border border-gray-200 dark:border-gray-700 overflow-hidden">
                    {/* Widget Header */}
                    <div className="widget-drag-handle flex items-center justify-between px-3 py-2 bg-gray-50 dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700 cursor-move">
                      <span className="text-sm font-medium text-gray-700 dark:text-gray-300 truncate">
                        {widget.title}
                      </span>
                      {isEditMode && (
                        <div className="flex items-center gap-1">
                          <Button
                            variant="ghost"
                            size="sm"
                            iconOnly
                            aria-label="Edit"
                            onClick={() => handleEditWidget(widget)}
                            title="Edit"
                          >
                            <Settings size={14} />
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            iconOnly
                            aria-label="Remove"
                            onClick={() => handleRemoveWidget(widget.id)}
                            title="Remove"
                          >
                            <Trash2 size={14} />
                          </Button>
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
