/**
 * WidgetConfigModal
 *
 * Two-step configuration form for a data-channel dashboard widget placed on the
 * P&ID canvas: pick a widget type, then bind it to a sensor data channel with
 * time-range / refresh / Y-axis options. Shared by the legacy ProcessEditorPage
 * and the UnifiedEditorPage so both editors expose the same widget-config path —
 * extracted from ProcessEditorPage as part of the Unified↔ProcessEditor
 * feature-parity work (6c) that precedes retiring the process page shell.
 */

import React, { useEffect, useState } from 'react';
import { X, Loader2, ChevronDown, ChevronRight } from 'lucide-react';

import { useDataChannelList, DataChannel } from '../../hooks/useDataChannelList';
import { WIDGET_TYPES, TIME_RANGES, REFRESH_INTERVALS, WidgetType } from '../dashboard/types';

// Widget types suitable for the process editor (single data-channel visualizations).
const PROCESS_WIDGET_TYPES = WIDGET_TYPES.filter(
  (t) => !['process-view', 'table', 'heatmap', 'multi-line'].includes(t.type),
);

const WIDGET_ICONS: Record<string, string> = {
  gauge: '🎯',
  'radial-gauge': '⭕',
  'line-chart': '📈',
  'area-chart': '📊',
  'bar-chart': '📶',
  sparkline: '〰️',
  'stat-card': '🔢',
  alert: '⚠️',
};

export interface WidgetConfigModalProps {
  nodeId: string | null;
  data: Record<string, unknown> | null;
  onClose: () => void;
  onSave: (data: Record<string, unknown>) => void;
}

export const WidgetConfigModal: React.FC<WidgetConfigModalProps> = ({ data, onClose, onSave }) => {
  const [step, setStep] = useState<'type' | 'config'>(data?.widgetType ? 'config' : 'type');

  const [selectedType, setSelectedType] = useState<WidgetType | null>(
    (data?.widgetType as WidgetType) || null,
  );
  const [title, setTitle] = useState((data?.title as string) || '');
  const [selectedChannelId, setSelectedChannelId] = useState<string | null>(
    (data?.dataChannelId as string) || null,
  );
  const [timeRange, setTimeRange] = useState((data?.timeRange as string) || 'live');
  const [refreshInterval, setRefreshInterval] = useState((data?.refreshInterval as number) || 10000);
  const [expandedSensors, setExpandedSensors] = useState<Set<string>>(new Set());

  const [yAxisMin, setYAxisMin] = useState<string>(
    data?.yAxisMin !== undefined ? String(data.yAxisMin) : '',
  );
  const [yAxisMax, setYAxisMax] = useState<string>(
    data?.yAxisMax !== undefined ? String(data.yAxisMax) : '',
  );

  const { groupedBySensor, loading, error } = useDataChannelList();

  // Auto-expand the first sensor when channels load.
  useEffect(() => {
    if (groupedBySensor.length > 0 && expandedSensors.size === 0) {
      setExpandedSensors(new Set([groupedBySensor[0].sensorId]));
    }
  }, [groupedBySensor, expandedSensors.size]);

  const handleTypeSelect = (type: WidgetType): void => {
    setSelectedType(type);
    setStep('config');
  };

  const handleChannelSelect = (channel: DataChannel): void => {
    setSelectedChannelId(channel.id);
    if (!title) {
      setTitle(channel.displayLabel);
    }
  };

  const toggleSensor = (sensorId: string): void => {
    const next = new Set(expandedSensors);
    if (next.has(sensorId)) {
      next.delete(sensorId);
    } else {
      next.add(sensorId);
    }
    setExpandedSensors(next);
  };

  const handleSave = (): void => {
    if (!selectedType || !selectedChannelId) return;

    const selectedChannel = groupedBySensor
      .flatMap((g) => g.channels)
      .find((c) => c.id === selectedChannelId);

    onSave({
      widgetType: selectedType,
      title: title || selectedChannel?.displayLabel || 'Widget',
      dataChannelId: selectedChannelId,
      selectedChannel: selectedChannel
        ? {
            channelId: selectedChannel.id,
            sensorId: selectedChannel.sensorId,
            channelKey: selectedChannel.channelKey,
            displayLabel: selectedChannel.displayLabel,
            unit: selectedChannel.unit,
            minValue: selectedChannel.minValue,
            maxValue: selectedChannel.maxValue,
          }
        : null,
      timeRange,
      refreshInterval,
      yAxisMin: yAxisMin !== '' ? parseFloat(yAxisMin) : undefined,
      yAxisMax: yAxisMax !== '' ? parseFloat(yAxisMax) : undefined,
    });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />

      <div className="relative bg-white rounded-lg shadow-xl w-full max-w-lg mx-4 max-h-[90vh] overflow-hidden flex flex-col">
        {/* Header */}
        <div className="px-4 py-3 border-b border-gray-200">
          <div className="flex items-center justify-between">
            <h3 className="text-lg font-semibold text-gray-900">Widget Configuration</h3>
            <button
              onClick={onClose}
              className="p-1 text-gray-500 hover:text-gray-600 rounded-lg hover:bg-gray-100"
              aria-label="Close"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
          <p className="text-sm text-gray-500 mt-1">
            {step === 'type' ? 'Step 1: Select widget type' : 'Step 2: Configure data source'}
          </p>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-4">
          {step === 'type' && (
            <div className="grid grid-cols-2 gap-3">
              {PROCESS_WIDGET_TYPES.map((wt) => (
                <button
                  key={wt.type}
                  onClick={() => handleTypeSelect(wt.type)}
                  className={`p-4 border rounded-lg text-left transition-all hover:border-cyan-500 hover:shadow-md ${
                    selectedType === wt.type
                      ? 'border-cyan-500 bg-cyan-50 ring-2 ring-cyan-200'
                      : 'border-gray-200 bg-white'
                  }`}
                >
                  <div className="text-2xl mb-2">{WIDGET_ICONS[wt.type] || '📊'}</div>
                  <div className="font-medium text-gray-900">{wt.label}</div>
                  <div className="text-xs text-gray-500 mt-1">{wt.description}</div>
                </button>
              ))}
            </div>
          )}

          {step === 'config' && (
            <div className="space-y-4">
              <div className="flex items-center gap-2 p-2 bg-gray-50 rounded-lg">
                <span className="text-xl">{WIDGET_ICONS[selectedType || 'line-chart'] || '📊'}</span>
                <span className="font-medium text-gray-700">
                  {PROCESS_WIDGET_TYPES.find((t) => t.type === selectedType)?.label || 'Widget'}
                </span>
                <button
                  onClick={() => setStep('type')}
                  className="ml-auto text-xs text-cyan-600 hover:underline"
                >
                  Change
                </button>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Title</label>
                <input
                  type="text"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-cyan-500 focus:border-transparent"
                  placeholder="Widget title (auto-fills from channel)"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Select Data Channel
                </label>

                {loading && (
                  <div className="flex items-center justify-center py-8">
                    <Loader2 className="w-6 h-6 text-cyan-600 animate-spin" />
                    <span className="ml-2 text-gray-500">Loading channels...</span>
                  </div>
                )}

                {error && (
                  <div className="p-4 bg-red-50 text-red-600 rounded-lg text-sm">{error}</div>
                )}

                {!loading && !error && groupedBySensor.length === 0 && (
                  <div className="p-4 bg-gray-50 text-gray-500 rounded-lg text-sm text-center">
                    No data channels available. Register sensors first.
                  </div>
                )}

                {!loading && !error && groupedBySensor.length > 0 && (
                  <div className="border border-gray-200 rounded-lg divide-y divide-gray-200 max-h-64 overflow-y-auto">
                    {groupedBySensor.map((group) => (
                      <div key={group.sensorId}>
                        <button
                          onClick={() => toggleSensor(group.sensorId)}
                          className="w-full px-3 py-2 flex items-center justify-between bg-gray-50 hover:bg-gray-100 transition-colors"
                        >
                          <div className="flex items-center gap-2">
                            {expandedSensors.has(group.sensorId) ? (
                              <ChevronDown className="w-4 h-4 text-gray-500" />
                            ) : (
                              <ChevronRight className="w-4 h-4 text-gray-500" />
                            )}
                            <span className="font-medium text-sm text-gray-700">
                              {group.sensorName}
                            </span>
                            {group.sensorType && (
                              <span className="text-xs text-gray-500">({group.sensorType})</span>
                            )}
                          </div>
                          <span className="text-xs text-gray-500">
                            {group.channels.length} channel
                            {group.channels.length !== 1 ? 's' : ''}
                          </span>
                        </button>

                        {expandedSensors.has(group.sensorId) && (
                          <div className="divide-y divide-gray-100">
                            {group.channels.map((channel) => (
                              <label
                                key={channel.id}
                                className={`flex items-center gap-3 px-4 py-2 cursor-pointer transition-colors ${
                                  selectedChannelId === channel.id ? 'bg-cyan-50' : 'hover:bg-gray-50'
                                }`}
                              >
                                <input
                                  type="radio"
                                  name="dataChannel"
                                  checked={selectedChannelId === channel.id}
                                  onChange={() => handleChannelSelect(channel)}
                                  className="text-cyan-600 focus:ring-cyan-500"
                                />
                                <div className="flex-1 min-w-0">
                                  <div className="text-sm text-gray-900 truncate">
                                    {channel.displayLabel}
                                  </div>
                                  <div className="text-xs text-gray-500">
                                    {channel.channelKey}
                                    {channel.unit && ` • ${channel.unit}`}
                                  </div>
                                </div>
                                {!channel.isEnabled && (
                                  <span className="text-xs text-yellow-600 bg-yellow-50 px-1.5 py-0.5 rounded">
                                    Disabled
                                  </span>
                                )}
                              </label>
                            ))}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Time Range</label>
                <select
                  value={timeRange}
                  onChange={(e) => setTimeRange(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-cyan-500 focus:border-transparent"
                >
                  {TIME_RANGES.map((tr) => (
                    <option key={tr.value} value={tr.value}>
                      {tr.label}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Refresh Interval
                </label>
                <select
                  value={refreshInterval}
                  onChange={(e) => setRefreshInterval(Number(e.target.value))}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-cyan-500 focus:border-transparent"
                >
                  {REFRESH_INTERVALS.map((ri) => (
                    <option key={ri.value} value={ri.value}>
                      {ri.label}
                    </option>
                  ))}
                </select>
              </div>

              {selectedType &&
                ['line-chart', 'area-chart', 'bar-chart', 'sparkline', 'gauge', 'radial-gauge'].includes(
                  selectedType,
                ) && (
                  <div className="pt-3 border-t border-gray-200">
                    <label className="block text-sm font-medium text-gray-700 mb-2">
                      Y-Axis Range (optional)
                    </label>
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className="block text-xs text-gray-500 mb-1">Min Value</label>
                        <input
                          type="number"
                          value={yAxisMin}
                          onChange={(e) => setYAxisMin(e.target.value)}
                          className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-cyan-500 focus:border-transparent text-sm"
                          placeholder="Auto"
                        />
                      </div>
                      <div>
                        <label className="block text-xs text-gray-500 mb-1">Max Value</label>
                        <input
                          type="number"
                          value={yAxisMax}
                          onChange={(e) => setYAxisMax(e.target.value)}
                          className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-cyan-500 focus:border-transparent text-sm"
                          placeholder="Auto"
                        />
                      </div>
                    </div>
                    <p className="text-xs text-gray-500 mt-1">
                      Leave empty for automatic range based on data
                    </p>
                  </div>
                )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-4 py-3 border-t border-gray-200 flex justify-between items-center bg-gray-50">
          {step === 'config' && (
            <button
              onClick={() => setStep('type')}
              className="text-sm text-cyan-600 hover:text-cyan-700 hover:underline"
            >
              ← Change widget type
            </button>
          )}
          {step === 'type' && <div />}
          <div className="flex gap-3">
            <button
              onClick={onClose}
              className="px-4 py-2 text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50"
            >
              Cancel
            </button>
            {step === 'config' && (
              <button
                onClick={handleSave}
                disabled={!selectedType || !selectedChannelId}
                className={`px-4 py-2 text-white rounded-lg transition-colors ${
                  !selectedType || !selectedChannelId
                    ? 'bg-gray-300 cursor-not-allowed'
                    : 'bg-cyan-600 hover:bg-cyan-700'
                }`}
              >
                Save Widget
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

export default WidgetConfigModal;
