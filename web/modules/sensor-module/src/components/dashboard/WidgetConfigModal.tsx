/**
 * Widget Configuration Modal
 *
 * Modal for adding/editing dashboard widgets.
 * Uses data channels grouped by sensor for selection.
 */

import React, { useState, useEffect, useMemo } from 'react';
import {
  Button,
  Checkbox,
  colors as themeColors,
  Input,
  Modal,
  ToggleButton,
} from '@aquaculture/shared-ui';
import {
  X,
  Check,
  Gauge,
  TrendingUp,
  BarChart3,
  Table,
  Activity,
  ChevronDown,
  ChevronRight,
  Target,
  Grid,
  GitBranch,
  AreaChart,
  GitFork,
} from 'lucide-react';
import {
  WidgetConfig,
  WidgetType,
  TimeRange,
  SelectedChannel,
  WidgetSettings,
  YAxisConfig,
  WIDGET_TYPES,
  TIME_RANGES,
  REFRESH_INTERVALS,
  WIDGET_CATEGORIES,
} from './types';
import { useDataChannelList, DataChannel } from '../../hooks/useDataChannelList';
import { useActiveProcesses } from '../../hooks/useProcess';

// ============================================================================
// Types
// ============================================================================

interface WidgetConfigModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSave: (config: WidgetConfig) => void;
  editingWidget?: WidgetConfig | null;
  /** IDs of channels already used in other widgets - these will be disabled */
  usedChannelIds?: Set<string>;
}

// ============================================================================
// Widget Icon Component
// ============================================================================

const WidgetIcon: React.FC<{ type: WidgetType; size?: number }> = ({ type, size = 24 }) => {
  switch (type) {
    case 'gauge':
      return <Gauge size={size} />;
    case 'radial-gauge':
      return <Target size={size} />;
    case 'line-chart':
      return <Activity size={size} />;
    case 'area-chart':
      return <AreaChart size={size} />;
    case 'bar-chart':
      return <BarChart3 size={size} />;
    case 'multi-line':
      return <GitBranch size={size} />;
    case 'heatmap':
      return <Grid size={size} />;
    case 'sparkline':
      return <TrendingUp size={size} />;
    case 'stat-card':
      return <Activity size={size} />;
    case 'table':
      return <Table size={size} />;
    case 'process-view':
      return <GitFork size={size} />;
    default:
      return <Activity size={size} />;
  }
};

// ============================================================================
// Channel Color Helper
// ============================================================================

const CHANNEL_COLORS: Record<string, string> = {
  temperature: themeColors.error[500],
  ph: themeColors.primary[700],
  dissolvedOxygen: themeColors.primary[400],
  dissolved_oxygen: themeColors.primary[400],
  salinity: themeColors.success[500],
  ammonia: themeColors.warning[500],
  nitrite: themeColors.accent[500],
  nitrate: themeColors.primary[500],
  turbidity: themeColors.gray[400],
  waterLevel: themeColors.secondary[600],
  water_level: themeColors.secondary[600],
};

function getChannelColor(channelKey: string): string {
  return CHANNEL_COLORS[channelKey] || themeColors.gray[400];
}

// ============================================================================
// Widget Config Modal Component
// ============================================================================

export const WidgetConfigModal: React.FC<WidgetConfigModalProps> = ({
  isOpen,
  onClose,
  onSave,
  editingWidget,
  usedChannelIds = new Set(),
}) => {
  // Fetch available data channels grouped by sensor
  const { groupedBySensor, loading: channelsLoading, error: channelsError } = useDataChannelList();

  // Fetch available processes for process-view widget
  const { processes: activeProcesses, loading: processesLoading } = useActiveProcesses();

  // Form state
  const [step, setStep] = useState<'type' | 'config'>('type');
  const [selectedProcessId, setSelectedProcessId] = useState<string | null>(
    editingWidget?.processId || null,
  );
  const [selectedType, setSelectedType] = useState<WidgetType | null>(editingWidget?.type || null);
  const [title, setTitle] = useState(editingWidget?.title || '');
  const [selectedChannelIds, setSelectedChannelIds] = useState<Set<string>>(
    new Set(editingWidget?.dataChannelIds || []),
  );
  const [timeRange, setTimeRange] = useState<TimeRange>(editingWidget?.timeRange || 'live');
  const [refreshInterval, setRefreshInterval] = useState(editingWidget?.refreshInterval || 10000);
  const [expandedSensors, setExpandedSensors] = useState<Set<string>>(new Set());

  // Y-axis configuration state
  const [yAxisEnabled, setYAxisEnabled] = useState(false);
  const [yAxisMin, setYAxisMin] = useState<string>('');
  const [yAxisMax, setYAxisMax] = useState<string>('');
  const [yAxisLabel, setYAxisLabel] = useState('');

  // Build selected channels info from IDs
  const selectedChannels = useMemo((): SelectedChannel[] => {
    const result: SelectedChannel[] = [];
    for (const group of groupedBySensor) {
      for (const channel of group.channels) {
        if (selectedChannelIds.has(channel.id)) {
          result.push({
            id: channel.id,
            channelKey: channel.channelKey,
            displayLabel: channel.displayLabel,
            unit: channel.unit,
            sensorId: channel.sensorId,
            sensorName: group.sensorName,
          });
        }
      }
    }
    return result;
  }, [groupedBySensor, selectedChannelIds]);

  // Reset form when modal opens
  useEffect(() => {
    if (isOpen && !editingWidget) {
      setStep('type');
      setSelectedType(null);
      setTitle('');
      setSelectedChannelIds(new Set());
      setSelectedProcessId(null);
      setTimeRange('live');
      setRefreshInterval(10000);
      setExpandedSensors(new Set());
      // Reset Y-axis settings
      setYAxisEnabled(false);
      setYAxisMin('');
      setYAxisMax('');
      setYAxisLabel('');
    } else if (editingWidget) {
      setStep('config');
      setSelectedType(editingWidget.type);
      setTitle(editingWidget.title);
      setSelectedChannelIds(new Set(editingWidget.dataChannelIds || []));
      setSelectedProcessId(editingWidget.processId || null);
      setTimeRange(editingWidget.timeRange);
      setRefreshInterval(editingWidget.refreshInterval);
      // Expand sensors that have selected channels
      if (editingWidget.selectedChannels) {
        const sensorIds = new Set(editingWidget.selectedChannels.map((ch) => ch.sensorId));
        setExpandedSensors(sensorIds);
      }
      // Load Y-axis settings
      const yAxis = editingWidget.settings?.yAxis;
      if (yAxis && (yAxis.min !== undefined || yAxis.max !== undefined)) {
        setYAxisEnabled(true);
        setYAxisMin(yAxis.min?.toString() || '');
        setYAxisMax(yAxis.max?.toString() || '');
        setYAxisLabel(yAxis.label || '');
      } else {
        setYAxisEnabled(false);
        setYAxisMin('');
        setYAxisMax('');
        setYAxisLabel('');
      }
    }
  }, [isOpen, editingWidget]);

  // Auto-expand all sensors when loading completes
  useEffect(() => {
    if (!channelsLoading && groupedBySensor.length > 0 && expandedSensors.size === 0) {
      // Expand first sensor by default
      setExpandedSensors(new Set([groupedBySensor[0]?.sensorId || '']));
    }
  }, [channelsLoading, groupedBySensor]);

  // Handle type selection
  const handleTypeSelect = (type: WidgetType) => {
    setSelectedType(type);
    setStep('config');
  };

  // Toggle sensor expansion
  const toggleSensorExpand = (sensorId: string) => {
    setExpandedSensors((prev) => {
      const next = new Set(prev);
      if (next.has(sensorId)) {
        next.delete(sensorId);
      } else {
        next.add(sensorId);
      }
      return next;
    });
  };

  // Handle channel toggle
  const handleChannelToggle = (channel: DataChannel, sensorName: string) => {
    setSelectedChannelIds((prev) => {
      const next = new Set(prev);

      if (next.has(channel.id)) {
        next.delete(channel.id);
      } else {
        // For single-select widget types, only allow single channel
        if (
          selectedType === 'gauge' ||
          selectedType === 'radial-gauge' ||
          selectedType === 'sparkline' ||
          selectedType === 'stat-card'
        ) {
          next.clear();
        }
        next.add(channel.id);

        // Auto-set title if empty
        if (!title) {
          setTitle(channel.displayLabel);
        }
      }

      return next;
    });
  };

  // Check if widget type supports Y-axis configuration
  const supportsYAxis = useMemo(() => {
    return ['line-chart', 'area-chart', 'bar-chart', 'multi-line'].includes(selectedType || '');
  }, [selectedType]);

  // Check if this is a process-view widget
  const isProcessView = selectedType === 'process-view';

  // Handle save
  const handleSave = () => {
    // Validation differs for process-view vs regular widgets
    if (!selectedType || !title) return;
    if (isProcessView && !selectedProcessId) return;
    if (!isProcessView && selectedChannelIds.size === 0) return;

    const typeInfo = WIDGET_TYPES.find((t) => t.type === selectedType);

    // Build Y-axis config if enabled
    const yAxisConfig: YAxisConfig | undefined =
      yAxisEnabled && supportsYAxis
        ? {
            min: yAxisMin ? parseFloat(yAxisMin) : undefined,
            max: yAxisMax ? parseFloat(yAxisMax) : undefined,
            label: yAxisLabel || undefined,
          }
        : undefined;

    const settings: WidgetSettings = {
      showLegend: true,
      showGrid: true,
      colorScheme: 'default',
      decimalPlaces: 2,
      ...(yAxisConfig && { yAxis: yAxisConfig }),
    };

    const config: WidgetConfig = {
      id: editingWidget?.id || '',
      type: selectedType,
      title,
      dataChannelIds: isProcessView ? [] : Array.from(selectedChannelIds),
      selectedChannels: isProcessView ? [] : selectedChannels,
      processId: isProcessView ? selectedProcessId || undefined : undefined,
      timeRange,
      refreshInterval,
      gridPosition: editingWidget?.gridPosition || {
        x: 0,
        y: 0,
        w: typeInfo?.defaultSize.w || 6,
        h: typeInfo?.defaultSize.h || 4,
      },
      settings,
    };

    onSave(config);
  };

  if (!isOpen) return null;

  const isSingleSelect =
    selectedType === 'gauge' ||
    selectedType === 'radial-gauge' ||
    selectedType === 'sparkline' ||
    selectedType === 'stat-card';

  return (
    <Modal
      isOpen
      onClose={onClose}
      size="lg"
      className="max-h-[90vh] overflow-hidden"
      bodyClassName=""
      title={editingWidget ? 'Edit Widget' : 'Add Widget'}
      description={step === 'type' ? 'Select widget type' : 'Configure data channels'}
    >
      {/* Content */}
      <div className="p-6 overflow-y-auto max-h-[60vh]">
        {step === 'type' ? (
          /* Step 1: Widget Type Selection */
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {WIDGET_TYPES.map((type) => (
              <ToggleButton
                key={type.type}
                onClick={() => handleTypeSelect(type.type)}
                pressed={selectedType === type.type}
                className="flex items-start gap-4 p-4 border-2 rounded-lg text-left transition-all"
                pressedClassName="border-info-500 bg-info-50 dark:bg-info-900/20"
                idleClassName="border-gray-200 dark:border-gray-700 hover:border-gray-300 dark:hover:border-gray-500 hover:bg-gray-50 dark:hover:bg-gray-800"
              >
                <div
                  className={`
                        p-3 rounded-lg
                        ${
                          selectedType === type.type
                            ? 'bg-info-100 dark:bg-info-900/40 text-info-600 dark:text-info-400'
                            : 'bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400'
                        }
                      `}
                >
                  <WidgetIcon type={type.type} />
                </div>
                <div>
                  <h3 className="font-medium text-gray-900 dark:text-gray-100">{type.label}</h3>
                  <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
                    {type.description}
                  </p>
                </div>
              </ToggleButton>
            ))}
          </div>
        ) : (
          /* Step 2: Widget Configuration */
          <div className="space-y-6">
            {/* Title */}
            <Input
              label="Widget Title"
              fullWidth
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Enter widget title"
            />

            {/* Process Selection (for process-view widget) */}
            {isProcessView ? (
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                  Select Process
                </label>
                {processesLoading ? (
                  <div className="text-center py-8 text-gray-500 dark:text-gray-400">
                    Loading processes...
                  </div>
                ) : activeProcesses.length === 0 ? (
                  <div className="text-center py-8 text-gray-500 dark:text-gray-400">
                    No processes available
                  </div>
                ) : (
                  <div className="border border-gray-200 dark:border-gray-700 rounded-lg max-h-64 overflow-y-auto">
                    {activeProcesses.map((process) => (
                      <label
                        key={process.id}
                        className={`
                              flex items-center gap-3 px-4 py-3 cursor-pointer
                              ${
                                selectedProcessId === process.id
                                  ? 'bg-info-50 dark:bg-info-900/20 border-l-2 border-info-500'
                                  : 'hover:bg-gray-50 dark:hover:bg-gray-800'
                              }
                            `}
                      >
                        <input
                          type="radio"
                          name="process"
                          checked={selectedProcessId === process.id}
                          onChange={() => {
                            setSelectedProcessId(process.id);
                            if (!title) setTitle(process.name);
                          }}
                          className="h-4 w-4 text-info-600 focus:ring-info-500 border-gray-300 dark:border-gray-600"
                        />
                        <div className="flex-1">
                          <p className="font-medium text-gray-900 dark:text-gray-100">
                            {process.name}
                          </p>
                          {process.description && (
                            <p className="text-sm text-gray-500 dark:text-gray-400 truncate">
                              {process.description}
                            </p>
                          )}
                        </div>
                        <span
                          className={`text-xs px-2 py-0.5 rounded-full ${
                            process.status === 'active'
                              ? 'bg-success-100 dark:bg-success-900/40 text-success-700 dark:text-success-300'
                              : process.status === 'draft'
                                ? 'bg-warning-100 dark:bg-warning-900/40 text-warning-700 dark:text-warning-300'
                                : 'bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400'
                          }`}
                        >
                          {process.status}
                        </span>
                      </label>
                    ))}
                  </div>
                )}
              </div>
            ) : (
              /* Data Channel Selection - Grouped by Sensor */
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                  Select Data Channel{' '}
                  {isSingleSelect && (
                    <span className="text-gray-500 dark:text-gray-400">(single selection)</span>
                  )}
                </label>
                {channelsLoading ? (
                  <div className="text-center py-8 text-gray-500 dark:text-gray-400">
                    Loading data channels...
                  </div>
                ) : channelsError ? (
                  <div className="text-center py-8 text-error-500">Error: {channelsError}</div>
                ) : groupedBySensor.length === 0 ? (
                  <div className="text-center py-8 text-gray-500 dark:text-gray-400">
                    No data channels found
                  </div>
                ) : (
                  <div className="border border-gray-200 dark:border-gray-700 rounded-lg max-h-64 overflow-y-auto">
                    {groupedBySensor.map((group) => (
                      <div key={group.sensorId} className="border-b last:border-b-0">
                        {/* Sensor Header (Collapsible) */}
                        <button
                          onClick={() => toggleSensorExpand(group.sensorId)}
                          className="w-full flex items-center gap-2 px-4 py-3 bg-gray-50 dark:bg-gray-800 hover:bg-gray-100 dark:hover:bg-gray-700 text-left"
                        >
                          {expandedSensors.has(group.sensorId) ? (
                            <ChevronDown size={16} className="text-gray-500 dark:text-gray-400" />
                          ) : (
                            <ChevronRight size={16} className="text-gray-500 dark:text-gray-400" />
                          )}
                          <span className="font-medium text-gray-900 dark:text-gray-100">
                            {group.sensorName}
                          </span>
                          <span className="text-xs text-gray-500 dark:text-gray-400 ml-auto">
                            {group.channels.length} channels
                          </span>
                        </button>

                        {/* Channels List */}
                        {expandedSensors.has(group.sensorId) && (
                          <div className="divide-y divide-gray-100 dark:divide-gray-700">
                            {group.channels.map((channel) => {
                              // Check if channel is already used in another widget
                              // Allow if it's part of the currently editing widget
                              const isAlreadyUsed =
                                usedChannelIds.has(channel.id) &&
                                !editingWidget?.dataChannelIds?.includes(channel.id);

                              return (
                                <label
                                  key={channel.id}
                                  className={`
                                      flex items-center gap-3 px-4 py-2 pl-10
                                      ${
                                        isAlreadyUsed
                                          ? 'opacity-50 cursor-not-allowed bg-gray-50 dark:bg-gray-800'
                                          : selectedChannelIds.has(channel.id)
                                            ? 'bg-info-50 dark:bg-info-900/20 cursor-pointer'
                                            : 'hover:bg-gray-50 dark:hover:bg-gray-800 cursor-pointer'
                                      }
                                    `}
                                >
                                  <input
                                    type={isSingleSelect ? 'radio' : 'checkbox'}
                                    name="channel"
                                    checked={selectedChannelIds.has(channel.id)}
                                    disabled={isAlreadyUsed}
                                    onChange={() =>
                                      !isAlreadyUsed &&
                                      handleChannelToggle(channel, group.sensorName)
                                    }
                                    className="h-4 w-4 text-info-600 focus:ring-info-500 border-gray-300 dark:border-gray-600 disabled:opacity-50"
                                  />
                                  <div
                                    className="w-3 h-3 rounded-full flex-shrink-0"
                                    style={{
                                      backgroundColor: getChannelColor(channel.channelKey),
                                      opacity: isAlreadyUsed ? 0.5 : 1,
                                    }}
                                  />
                                  <div className="flex-1 min-w-0">
                                    <p
                                      className={`font-medium truncate ${isAlreadyUsed ? 'text-gray-500 dark:text-gray-400' : 'text-gray-900 dark:text-gray-100'}`}
                                    >
                                      {channel.displayLabel}
                                    </p>
                                    {isAlreadyUsed && (
                                      <p className="text-xs text-warning-600 dark:text-warning-400">
                                        Used in another widget
                                      </p>
                                    )}
                                  </div>
                                  <span className="text-xs text-gray-500 dark:text-gray-400 flex-shrink-0">
                                    {channel.unit || '-'}
                                  </span>
                                </label>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}

                {/* Selected Channels Summary */}
                {selectedChannels.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-2">
                    {selectedChannels.map((ch) => (
                      <span
                        key={ch.id}
                        className="inline-flex items-center gap-1 px-2 py-1 bg-info-100 dark:bg-info-900/40 text-info-800 dark:text-info-200 text-xs rounded-full"
                      >
                        <span
                          className="w-2 h-2 rounded-full"
                          style={{ backgroundColor: getChannelColor(ch.channelKey) }}
                        />
                        {ch.displayLabel}
                        <Button
                          variant="ghost"
                          iconOnly
                          aria-label="Close"
                          className="ml-1"
                          onClick={() =>
                            handleChannelToggle(
                              {
                                id: ch.id,
                                channelKey: ch.channelKey,
                                displayLabel: ch.displayLabel,
                              } as DataChannel,
                              ch.sensorName,
                            )
                          }
                        >
                          <X size={12} />
                        </Button>
                      </span>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* Y-Axis Configuration (for chart types) */}
            {supportsYAxis && (
              <div className="border border-gray-200 dark:border-gray-700 rounded-lg p-4">
                <div className="flex items-center justify-between mb-3">
                  <label className="text-sm font-medium text-gray-700 dark:text-gray-300">
                    Y-Axis Configuration
                  </label>
                  <Checkbox
                    label="Custom Range"
                    checked={yAxisEnabled}
                    onChange={(e) => setYAxisEnabled(e.target.checked)}
                  />
                </div>

                {yAxisEnabled && (
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                    <Input
                      label="Min Value"
                      fullWidth
                      type="number"
                      value={yAxisMin}
                      onChange={(e) => setYAxisMin(e.target.value)}
                      placeholder="Auto"
                    />
                    <Input
                      label="Max Value"
                      fullWidth
                      type="number"
                      value={yAxisMax}
                      onChange={(e) => setYAxisMax(e.target.value)}
                      placeholder="Auto"
                    />
                    <Input
                      label="Axis Label"
                      fullWidth
                      type="text"
                      value={yAxisLabel}
                      onChange={(e) => setYAxisLabel(e.target.value)}
                      placeholder="e.g., Temperature (°C)"
                    />
                  </div>
                )}
              </div>
            )}

            {/* Time Range */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                  Time Range
                </label>
                <select
                  value={timeRange}
                  onChange={(e) => setTimeRange(e.target.value as TimeRange)}
                  className="w-full px-4 py-2 border border-gray-300 dark:border-gray-600 rounded-lg focus:outline-hidden focus:ring-2 focus:ring-info-500"
                >
                  {TIME_RANGES.map((range) => (
                    <option key={range.value} value={range.value}>
                      {range.label}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                  Refresh Interval
                </label>
                <select
                  value={refreshInterval}
                  onChange={(e) => setRefreshInterval(Number(e.target.value))}
                  className="w-full px-4 py-2 border border-gray-300 dark:border-gray-600 rounded-lg focus:outline-hidden focus:ring-2 focus:ring-info-500"
                >
                  {REFRESH_INTERVALS.map((interval) => (
                    <option key={interval.value} value={interval.value}>
                      {interval.label}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="flex items-center justify-between px-6 py-4 border-t border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800">
        <div>
          {step === 'config' && (
            <Button variant="ghost" onClick={() => setStep('type')}>
              Change widget type
            </Button>
          )}
        </div>
        <div className="flex items-center gap-3">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          {step === 'config' && (
            <button
              onClick={handleSave}
              disabled={
                !title || (isProcessView ? !selectedProcessId : selectedChannelIds.size === 0)
              }
              className={`
                    flex items-center gap-2 px-4 py-2 rounded-lg transition-colors
                    ${
                      title && (isProcessView ? selectedProcessId : selectedChannelIds.size > 0)
                        ? 'bg-info-600 text-white hover:bg-info-700'
                        : 'bg-gray-300 text-gray-500 dark:text-gray-400 cursor-not-allowed'
                    }
                  `}
            >
              <Check size={16} />
              {editingWidget ? 'Update' : 'Add'}
            </button>
          )}
        </div>
      </div>
    </Modal>
  );
};

export default WidgetConfigModal;
