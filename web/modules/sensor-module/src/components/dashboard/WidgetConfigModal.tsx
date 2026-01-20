/**
 * Widget Configuration Modal
 *
 * Modal for adding/editing dashboard widgets.
 * Uses data channels grouped by sensor for selection.
 */

import React, { useState, useEffect, useMemo } from 'react';
import { X, Check, Gauge, TrendingUp, BarChart3, Table, Activity, ChevronDown, ChevronRight, Target, Grid, GitBranch, AreaChart, GitFork } from 'lucide-react';
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

const WidgetIcon: React.FC<{ type: WidgetType; size?: number }> = ({
  type,
  size = 24,
}) => {
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
  temperature: '#EF4444',
  ph: '#8B5CF6',
  dissolvedOxygen: '#0EA5E9',
  dissolved_oxygen: '#0EA5E9',
  salinity: '#10B981',
  ammonia: '#F59E0B',
  nitrite: '#EC4899',
  nitrate: '#6366F1',
  turbidity: '#78716C',
  waterLevel: '#14B8A6',
  water_level: '#14B8A6',
};

function getChannelColor(channelKey: string): string {
  return CHANNEL_COLORS[channelKey] || '#6B7280';
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
    editingWidget?.processId || null
  );
  const [selectedType, setSelectedType] = useState<WidgetType | null>(
    editingWidget?.type || null
  );
  const [title, setTitle] = useState(editingWidget?.title || '');
  const [selectedChannelIds, setSelectedChannelIds] = useState<Set<string>>(
    new Set(editingWidget?.dataChannelIds || [])
  );
  const [timeRange, setTimeRange] = useState<TimeRange>(
    editingWidget?.timeRange || 'live'
  );
  const [refreshInterval, setRefreshInterval] = useState(
    editingWidget?.refreshInterval || 10000
  );
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
        const sensorIds = new Set(editingWidget.selectedChannels.map(ch => ch.sensorId));
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
        if (selectedType === 'gauge' || selectedType === 'radial-gauge' || selectedType === 'sparkline' || selectedType === 'stat-card') {
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
    const yAxisConfig: YAxisConfig | undefined = yAxisEnabled && supportsYAxis ? {
      min: yAxisMin ? parseFloat(yAxisMin) : undefined,
      max: yAxisMax ? parseFloat(yAxisMax) : undefined,
      label: yAxisLabel || undefined,
    } : undefined;

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

  const isSingleSelect = selectedType === 'gauge' || selectedType === 'radial-gauge' || selectedType === 'sparkline' || selectedType === 'stat-card';

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto">
      {/* Backdrop */}
      <div className="fixed inset-0 bg-black bg-opacity-50" onClick={onClose} />

      {/* Modal */}
      <div className="relative min-h-screen flex items-center justify-center p-4">
        <div className="relative bg-white rounded-xl shadow-2xl w-full max-w-2xl max-h-[90vh] overflow-hidden">
          {/* Header */}
          <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200">
            <div>
              <h2 className="text-xl font-semibold text-gray-900">
                {editingWidget ? 'Edit Widget' : 'Add Widget'}
              </h2>
              <p className="text-sm text-gray-500 mt-1">
                {step === 'type'
                  ? 'Select widget type'
                  : 'Configure data channels'}
              </p>
            </div>
            <button
              onClick={onClose}
              className="p-2 text-gray-400 hover:text-gray-600 rounded-lg hover:bg-gray-100"
            >
              <X size={20} />
            </button>
          </div>

          {/* Content */}
          <div className="p-6 overflow-y-auto max-h-[60vh]">
            {step === 'type' ? (
              /* Step 1: Widget Type Selection */
              <div className="grid grid-cols-2 gap-4">
                {WIDGET_TYPES.map((type) => (
                  <button
                    key={type.type}
                    onClick={() => handleTypeSelect(type.type)}
                    className={`
                      flex items-start gap-4 p-4 border-2 rounded-lg text-left transition-all
                      ${
                        selectedType === type.type
                          ? 'border-cyan-500 bg-cyan-50'
                          : 'border-gray-200 hover:border-gray-300 hover:bg-gray-50'
                      }
                    `}
                  >
                    <div
                      className={`
                        p-3 rounded-lg
                        ${
                          selectedType === type.type
                            ? 'bg-cyan-100 text-cyan-600'
                            : 'bg-gray-100 text-gray-600'
                        }
                      `}
                    >
                      <WidgetIcon type={type.type} />
                    </div>
                    <div>
                      <h3 className="font-medium text-gray-900">{type.label}</h3>
                      <p className="text-sm text-gray-500 mt-1">
                        {type.description}
                      </p>
                    </div>
                  </button>
                ))}
              </div>
            ) : (
              /* Step 2: Widget Configuration */
              <div className="space-y-6">
                {/* Title */}
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    Widget Title
                  </label>
                  <input
                    type="text"
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    placeholder="Enter widget title"
                    className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-cyan-500"
                  />
                </div>

                {/* Process Selection (for process-view widget) */}
                {isProcessView ? (
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-2">
                      Select Process
                    </label>
                    {processesLoading ? (
                      <div className="text-center py-8 text-gray-500">
                        Loading processes...
                      </div>
                    ) : activeProcesses.length === 0 ? (
                      <div className="text-center py-8 text-gray-500">
                        No processes available
                      </div>
                    ) : (
                      <div className="border border-gray-200 rounded-lg max-h-64 overflow-y-auto">
                        {activeProcesses.map((process) => (
                          <label
                            key={process.id}
                            className={`
                              flex items-center gap-3 px-4 py-3 cursor-pointer
                              ${selectedProcessId === process.id
                                ? 'bg-cyan-50 border-l-2 border-cyan-500'
                                : 'hover:bg-gray-50'
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
                              className="h-4 w-4 text-cyan-600 focus:ring-cyan-500 border-gray-300"
                            />
                            <div className="flex-1">
                              <p className="font-medium text-gray-900">{process.name}</p>
                              {process.description && (
                                <p className="text-sm text-gray-500 truncate">{process.description}</p>
                              )}
                            </div>
                            <span className={`text-xs px-2 py-0.5 rounded-full ${
                              process.status === 'active' ? 'bg-green-100 text-green-700' :
                              process.status === 'draft' ? 'bg-yellow-100 text-yellow-700' :
                              'bg-gray-100 text-gray-600'
                            }`}>
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
                    <label className="block text-sm font-medium text-gray-700 mb-2">
                      Select Data Channel{' '}
                      {isSingleSelect && (
                        <span className="text-gray-400">(single selection)</span>
                      )}
                    </label>
                    {channelsLoading ? (
                    <div className="text-center py-8 text-gray-500">
                      Loading data channels...
                    </div>
                  ) : channelsError ? (
                    <div className="text-center py-8 text-red-500">
                      Error: {channelsError}
                    </div>
                  ) : groupedBySensor.length === 0 ? (
                    <div className="text-center py-8 text-gray-500">
                      No data channels found
                    </div>
                  ) : (
                    <div className="border border-gray-200 rounded-lg max-h-64 overflow-y-auto">
                      {groupedBySensor.map((group) => (
                        <div key={group.sensorId} className="border-b last:border-b-0">
                          {/* Sensor Header (Collapsible) */}
                          <button
                            onClick={() => toggleSensorExpand(group.sensorId)}
                            className="w-full flex items-center gap-2 px-4 py-3 bg-gray-50 hover:bg-gray-100 text-left"
                          >
                            {expandedSensors.has(group.sensorId) ? (
                              <ChevronDown size={16} className="text-gray-500" />
                            ) : (
                              <ChevronRight size={16} className="text-gray-500" />
                            )}
                            <span className="font-medium text-gray-900">
                              {group.sensorName}
                            </span>
                            <span className="text-xs text-gray-500 ml-auto">
                              {group.channels.length} channels
                            </span>
                          </button>

                          {/* Channels List */}
                          {expandedSensors.has(group.sensorId) && (
                            <div className="divide-y divide-gray-100">
                              {group.channels.map((channel) => {
                                // Check if channel is already used in another widget
                                // Allow if it's part of the currently editing widget
                                const isAlreadyUsed = usedChannelIds.has(channel.id) &&
                                  !editingWidget?.dataChannelIds?.includes(channel.id);

                                return (
                                  <label
                                    key={channel.id}
                                    className={`
                                      flex items-center gap-3 px-4 py-2 pl-10
                                      ${isAlreadyUsed
                                        ? 'opacity-50 cursor-not-allowed bg-gray-50'
                                        : selectedChannelIds.has(channel.id)
                                          ? 'bg-cyan-50 cursor-pointer'
                                          : 'hover:bg-gray-50 cursor-pointer'
                                      }
                                    `}
                                  >
                                    <input
                                      type={isSingleSelect ? 'radio' : 'checkbox'}
                                      name="channel"
                                      checked={selectedChannelIds.has(channel.id)}
                                      disabled={isAlreadyUsed}
                                      onChange={() => !isAlreadyUsed && handleChannelToggle(channel, group.sensorName)}
                                      className="h-4 w-4 text-cyan-600 focus:ring-cyan-500 border-gray-300 disabled:opacity-50"
                                    />
                                    <div
                                      className="w-3 h-3 rounded-full flex-shrink-0"
                                      style={{
                                        backgroundColor: getChannelColor(channel.channelKey),
                                        opacity: isAlreadyUsed ? 0.5 : 1,
                                      }}
                                    />
                                    <div className="flex-1 min-w-0">
                                      <p className={`font-medium truncate ${isAlreadyUsed ? 'text-gray-400' : 'text-gray-900'}`}>
                                        {channel.displayLabel}
                                      </p>
                                      {isAlreadyUsed && (
                                        <p className="text-xs text-amber-600">
                                          Used in another widget
                                        </p>
                                      )}
                                    </div>
                                    <span className="text-xs text-gray-500 flex-shrink-0">
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
                            className="inline-flex items-center gap-1 px-2 py-1 bg-cyan-100 text-cyan-800 text-xs rounded-full"
                          >
                            <span
                              className="w-2 h-2 rounded-full"
                              style={{ backgroundColor: getChannelColor(ch.channelKey) }}
                            />
                            {ch.displayLabel}
                            <button
                              onClick={() => handleChannelToggle(
                                { id: ch.id, channelKey: ch.channelKey, displayLabel: ch.displayLabel } as DataChannel,
                                ch.sensorName
                              )}
                              className="ml-1 hover:text-cyan-600"
                            >
                              <X size={12} />
                            </button>
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                )}

                {/* Y-Axis Configuration (for chart types) */}
                {supportsYAxis && (
                  <div className="border border-gray-200 rounded-lg p-4">
                    <div className="flex items-center justify-between mb-3">
                      <label className="text-sm font-medium text-gray-700">
                        Y-Axis Configuration
                      </label>
                      <label className="flex items-center gap-2 text-sm">
                        <input
                          type="checkbox"
                          checked={yAxisEnabled}
                          onChange={(e) => setYAxisEnabled(e.target.checked)}
                          className="h-4 w-4 text-cyan-600 focus:ring-cyan-500 border-gray-300 rounded"
                        />
                        <span className="text-gray-600">Custom Range</span>
                      </label>
                    </div>

                    {yAxisEnabled && (
                      <div className="grid grid-cols-3 gap-3">
                        <div>
                          <label className="block text-xs text-gray-500 mb-1">
                            Min Value
                          </label>
                          <input
                            type="number"
                            value={yAxisMin}
                            onChange={(e) => setYAxisMin(e.target.value)}
                            placeholder="Auto"
                            className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-cyan-500"
                          />
                        </div>
                        <div>
                          <label className="block text-xs text-gray-500 mb-1">
                            Max Value
                          </label>
                          <input
                            type="number"
                            value={yAxisMax}
                            onChange={(e) => setYAxisMax(e.target.value)}
                            placeholder="Auto"
                            className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-cyan-500"
                          />
                        </div>
                        <div>
                          <label className="block text-xs text-gray-500 mb-1">
                            Axis Label
                          </label>
                          <input
                            type="text"
                            value={yAxisLabel}
                            onChange={(e) => setYAxisLabel(e.target.value)}
                            placeholder="e.g., Temperature (°C)"
                            className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-cyan-500"
                          />
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {/* Time Range */}
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-2">
                      Time Range
                    </label>
                    <select
                      value={timeRange}
                      onChange={(e) => setTimeRange(e.target.value as TimeRange)}
                      className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-cyan-500"
                    >
                      {TIME_RANGES.map((range) => (
                        <option key={range.value} value={range.value}>
                          {range.label}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-2">
                      Refresh Interval
                    </label>
                    <select
                      value={refreshInterval}
                      onChange={(e) => setRefreshInterval(Number(e.target.value))}
                      className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-cyan-500"
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
          <div className="flex items-center justify-between px-6 py-4 border-t border-gray-200 bg-gray-50">
            <div>
              {step === 'config' && (
                <button
                  onClick={() => setStep('type')}
                  className="text-sm text-gray-500 hover:text-gray-700"
                >
                  Change widget type
                </button>
              )}
            </div>
            <div className="flex items-center gap-3">
              <button
                onClick={onClose}
                className="px-4 py-2 text-gray-700 hover:bg-gray-100 rounded-lg transition-colors"
              >
                Cancel
              </button>
              {step === 'config' && (
                <button
                  onClick={handleSave}
                  disabled={!title || (isProcessView ? !selectedProcessId : selectedChannelIds.size === 0)}
                  className={`
                    flex items-center gap-2 px-4 py-2 rounded-lg transition-colors
                    ${
                      title && (isProcessView ? selectedProcessId : selectedChannelIds.size > 0)
                        ? 'bg-cyan-600 text-white hover:bg-cyan-700'
                        : 'bg-gray-300 text-gray-500 cursor-not-allowed'
                    }
                  `}
                >
                  <Check size={16} />
                  {editingWidget ? 'Update' : 'Add'}
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default WidgetConfigModal;
