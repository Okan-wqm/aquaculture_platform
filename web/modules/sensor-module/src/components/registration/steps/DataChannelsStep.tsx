import React, { useState, useCallback } from 'react';
import {
  DataChannelConfig,
  DiscoveredChannel,
  ChannelDataType,
  DiscoverySource,
  ConnectionTestResult,
} from '../../../types/registration.types';

interface DataChannelsStepProps {
  protocolCode: string;
  protocolConfig: Record<string, unknown>;
  connectionTestResult?: ConnectionTestResult | null;
  channels: DataChannelConfig[];
  onChange: (channels: DataChannelConfig[]) => void;
  onEditChannel: (channel: DataChannelConfig) => void;
}

// Known aquaculture parameters for inference
const KNOWN_PARAMETERS: Record<string, {
  label: string;
  unit: string;
  min: number;
  max: number;
}> = {
  temperature: { label: 'Temperature', unit: '°C', min: 0, max: 40 },
  temp: { label: 'Temperature', unit: '°C', min: 0, max: 40 },
  ph: { label: 'pH', unit: 'pH', min: 0, max: 14 },
  dissolved_oxygen: { label: 'Dissolved Oxygen', unit: 'mg/L', min: 0, max: 20 },
  do: { label: 'Dissolved Oxygen', unit: 'mg/L', min: 0, max: 20 },
  oxygen: { label: 'Dissolved Oxygen', unit: 'mg/L', min: 0, max: 20 },
  salinity: { label: 'Salinity', unit: 'ppt', min: 0, max: 50 },
  ammonia: { label: 'Ammonia', unit: 'mg/L', min: 0, max: 10 },
  nh3: { label: 'Ammonia', unit: 'mg/L', min: 0, max: 10 },
  nitrite: { label: 'Nitrite', unit: 'mg/L', min: 0, max: 5 },
  no2: { label: 'Nitrite', unit: 'mg/L', min: 0, max: 5 },
  nitrate: { label: 'Nitrate', unit: 'mg/L', min: 0, max: 100 },
  no3: { label: 'Nitrate', unit: 'mg/L', min: 0, max: 100 },
  turbidity: { label: 'Turbidity', unit: 'NTU', min: 0, max: 1000 },
  water_level: { label: 'Water Level', unit: 'cm', min: 0, max: 500 },
  conductivity: { label: 'Conductivity', unit: 'µS/cm', min: 0, max: 50000 },
  orp: { label: 'ORP', unit: 'mV', min: -500, max: 500 },
  alkalinity: { label: 'Alkalinity', unit: 'mg/L CaCO3', min: 0, max: 500 },
};

export function DataChannelsStep({
  protocolCode,
  protocolConfig,
  connectionTestResult,
  channels,
  onChange,
  onEditChannel,
}: DataChannelsStepProps) {
  const [discoveredChannels, setDiscoveredChannels] = useState<DiscoveredChannel[]>([]);
  const [selectedDiscovered, setSelectedDiscovered] = useState<Set<string>>(new Set());
  const [isDiscovering, setIsDiscovering] = useState(false);
  const [discoveryError, setDiscoveryError] = useState<string | null>(null);

  // Discover channels from sample data
  const handleDiscover = useCallback(() => {
    if (!connectionTestResult?.sampleData) {
      setDiscoveryError('No sample data available. Please run connection test first.');
      return;
    }

    setIsDiscovering(true);
    setDiscoveryError(null);

    try {
      const discovered = discoverFromSampleData(connectionTestResult.sampleData);
      setDiscoveredChannels(discovered);
      // Auto-select all discovered channels
      setSelectedDiscovered(new Set(discovered.map(ch => ch.channelKey)));
    } catch (error) {
      setDiscoveryError((error as Error).message);
    } finally {
      setIsDiscovering(false);
    }
  }, [connectionTestResult]);

  // Add selected discovered channels
  const handleAddSelected = useCallback(() => {
    const newChannels: DataChannelConfig[] = [];

    discoveredChannels
      .filter(ch => selectedDiscovered.has(ch.channelKey))
      .forEach((discovered, index) => {
        // Skip if already exists
        if (channels.some(ch => ch.channelKey === discovered.channelKey)) {
          return;
        }

        newChannels.push({
          channelKey: discovered.channelKey,
          displayLabel: discovered.suggestedLabel,
          dataType: discovered.inferredDataType,
          unit: discovered.inferredUnit,
          dataPath: discovered.dataPath,
          minValue: discovered.suggestedMin,
          maxValue: discovered.suggestedMax,
          calibrationEnabled: false,
          calibrationMultiplier: 1.0,
          calibrationOffset: 0.0,
          isEnabled: true,
          displayOrder: channels.length + index,
          discoverySource: DiscoverySource.AUTO,
          sampleValue: discovered.sampleValue,
          displaySettings: {
            showOnDashboard: true,
            precision: 2,
          },
        });
      });

    onChange([...channels, ...newChannels]);
    setDiscoveredChannels([]);
    setSelectedDiscovered(new Set());
  }, [discoveredChannels, selectedDiscovered, channels, onChange]);

  // Toggle channel selection
  const toggleDiscoveredSelection = (channelKey: string) => {
    const newSelected = new Set(selectedDiscovered);
    if (newSelected.has(channelKey)) {
      newSelected.delete(channelKey);
    } else {
      newSelected.add(channelKey);
    }
    setSelectedDiscovered(newSelected);
  };

  // Remove a channel
  const handleRemoveChannel = useCallback((channelKey: string) => {
    onChange(channels.filter(ch => ch.channelKey !== channelKey));
  }, [channels, onChange]);

  // Toggle channel enabled status
  const handleToggleEnabled = useCallback((channelKey: string) => {
    onChange(
      channels.map(ch =>
        ch.channelKey === channelKey ? { ...ch, isEnabled: !ch.isEnabled } : ch
      )
    );
  }, [channels, onChange]);

  // Add manual channel
  const handleAddManual = useCallback(() => {
    const newChannel: DataChannelConfig = {
      channelKey: `channel_${Date.now()}`,
      displayLabel: 'New Channel',
      dataType: ChannelDataType.NUMBER,
      calibrationEnabled: false,
      calibrationMultiplier: 1.0,
      calibrationOffset: 0.0,
      isEnabled: true,
      displayOrder: channels.length,
      discoverySource: DiscoverySource.MANUAL,
      displaySettings: {
        showOnDashboard: true,
        precision: 2,
      },
    };
    onEditChannel(newChannel);
  }, [channels.length, onEditChannel]);

  // Move channel up/down
  const handleMoveChannel = useCallback((index: number, direction: 'up' | 'down') => {
    const newChannels = [...channels];
    const newIndex = direction === 'up' ? index - 1 : index + 1;

    if (newIndex < 0 || newIndex >= newChannels.length) return;

    [newChannels[index], newChannels[newIndex]] = [newChannels[newIndex], newChannels[index]];

    // Update display order
    newChannels.forEach((ch, i) => {
      ch.displayOrder = i;
    });

    onChange(newChannels);
  }, [channels, onChange]);

  const hasSampleData = !!connectionTestResult?.sampleData;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h3 className="text-lg font-medium text-gray-900">Data Channels Configuration</h3>
        <p className="mt-1 text-sm text-gray-500">
          Configure the data channels (metrics) that this sensor will report.
          Each channel can have its own unit, calibration, and alert thresholds.
        </p>
      </div>

      {/* Discovery Section */}
      <div className="bg-blue-50 rounded-lg p-4 border border-blue-200">
        <div className="flex items-start justify-between">
          <div>
            <h4 className="text-sm font-medium text-blue-900 flex items-center">
              <svg className="w-5 h-5 mr-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
              </svg>
              Auto-Discovery
            </h4>
            <p className="text-sm text-blue-700 mt-1">
              {hasSampleData
                ? 'Sample data available. Click to discover data channels automatically.'
                : 'Run a connection test to enable auto-discovery.'}
            </p>
          </div>
          <button
            onClick={handleDiscover}
            disabled={!hasSampleData || isDiscovering}
            className="px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-md hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isDiscovering ? (
              <span className="flex items-center">
                <svg className="animate-spin -ml-1 mr-2 h-4 w-4" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
                Discovering...
              </span>
            ) : (
              'Discover Channels'
            )}
          </button>
        </div>

        {discoveryError && (
          <div className="mt-3 text-sm text-red-600 bg-red-50 p-2 rounded">
            {discoveryError}
          </div>
        )}

        {/* Discovered Channels List */}
        {discoveredChannels.length > 0 && (
          <div className="mt-4">
            <div className="text-sm font-medium text-blue-900 mb-2">
              Discovered {discoveredChannels.length} channel(s):
            </div>
            <div className="space-y-2">
              {discoveredChannels.map(ch => {
                const alreadyAdded = channels.some(c => c.channelKey === ch.channelKey);
                return (
                  <label
                    key={ch.channelKey}
                    className={`flex items-center p-2 bg-white rounded border ${
                      alreadyAdded ? 'border-gray-200 opacity-50' : 'border-blue-200 cursor-pointer hover:bg-blue-50'
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={selectedDiscovered.has(ch.channelKey)}
                      onChange={() => toggleDiscoveredSelection(ch.channelKey)}
                      disabled={alreadyAdded}
                      className="h-4 w-4 text-blue-600 rounded border-gray-300"
                    />
                    <div className="ml-3 flex-1">
                      <span className="text-sm font-medium text-gray-900">{ch.suggestedLabel}</span>
                      <span className="text-xs text-gray-500 ml-2">({ch.channelKey})</span>
                      {ch.inferredUnit && (
                        <span className="ml-2 px-1.5 py-0.5 bg-gray-100 text-gray-600 text-xs rounded">
                          {ch.inferredUnit}
                        </span>
                      )}
                      {ch.sampleValue !== undefined && (
                        <span className="ml-2 text-xs text-gray-500">
                          Sample: {String(ch.sampleValue)}
                        </span>
                      )}
                    </div>
                    {alreadyAdded && (
                      <span className="text-xs text-gray-400">Already added</span>
                    )}
                  </label>
                );
              })}
            </div>
            <button
              onClick={handleAddSelected}
              disabled={selectedDiscovered.size === 0}
              className="mt-3 px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-md hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Add Selected ({selectedDiscovered.size})
            </button>
          </div>
        )}
      </div>

      {/* Configured Channels */}
      <div className="border border-gray-200 rounded-lg">
        <div className="flex items-center justify-between px-4 py-3 bg-gray-50 border-b border-gray-200 rounded-t-lg">
          <h4 className="text-sm font-medium text-gray-900">
            Configured Channels ({channels.length})
          </h4>
          <button
            onClick={handleAddManual}
            className="flex items-center px-3 py-1.5 text-sm font-medium text-blue-600 hover:text-blue-700 hover:bg-blue-50 rounded"
          >
            <svg className="w-4 h-4 mr-1" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
            </svg>
            Add Manual
          </button>
        </div>

        {channels.length === 0 ? (
          <div className="p-8 text-center text-gray-500">
            <svg className="w-12 h-12 mx-auto text-gray-300 mb-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 17v-2m3 2v-4m3 4v-6m2 10H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
            </svg>
            <p className="text-sm">No data channels configured yet.</p>
            <p className="text-xs mt-1">
              Use auto-discovery or add channels manually.
            </p>
          </div>
        ) : (
          <div className="divide-y divide-gray-200">
            {channels.map((channel, index) => (
              <div
                key={channel.channelKey}
                className={`flex items-center px-4 py-3 ${!channel.isEnabled ? 'bg-gray-50 opacity-60' : ''}`}
              >
                {/* Drag handle / reorder buttons */}
                <div className="flex flex-col mr-3">
                  <button
                    onClick={() => handleMoveChannel(index, 'up')}
                    disabled={index === 0}
                    className="p-0.5 text-gray-400 hover:text-gray-600 disabled:opacity-30"
                  >
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 15l7-7 7 7" />
                    </svg>
                  </button>
                  <button
                    onClick={() => handleMoveChannel(index, 'down')}
                    disabled={index === channels.length - 1}
                    className="p-0.5 text-gray-400 hover:text-gray-600 disabled:opacity-30"
                  >
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                    </svg>
                  </button>
                </div>

                {/* Channel info */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center">
                    <span className="text-sm font-medium text-gray-900 truncate">
                      {channel.displayLabel}
                    </span>
                    <span className="ml-2 text-xs text-gray-500">
                      ({channel.channelKey})
                    </span>
                    {channel.discoverySource === DiscoverySource.AUTO && (
                      <span className="ml-2 px-1.5 py-0.5 bg-blue-100 text-blue-700 text-xs rounded">
                        Auto
                      </span>
                    )}
                  </div>
                  <div className="flex items-center mt-1 text-xs text-gray-500 space-x-3">
                    {channel.unit && (
                      <span className="px-1.5 py-0.5 bg-gray-100 rounded">{channel.unit}</span>
                    )}
                    {channel.calibrationEnabled && (
                      <span className="text-orange-600">
                        Calibration: {channel.calibrationMultiplier}x + {channel.calibrationOffset}
                      </span>
                    )}
                    {channel.alertThresholds && (
                      <span className="text-yellow-600">Alerts configured</span>
                    )}
                    {channel.sampleValue !== undefined && (
                      <span>Sample: {String(channel.sampleValue)}</span>
                    )}
                  </div>
                </div>

                {/* Actions */}
                <div className="flex items-center space-x-2 ml-4">
                  {/* Enable/Disable toggle */}
                  <button
                    onClick={() => handleToggleEnabled(channel.channelKey)}
                    className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
                      channel.isEnabled ? 'bg-green-500' : 'bg-gray-300'
                    }`}
                  >
                    <span
                      className={`inline-block h-3 w-3 transform rounded-full bg-white transition-transform ${
                        channel.isEnabled ? 'translate-x-5' : 'translate-x-1'
                      }`}
                    />
                  </button>

                  {/* Edit button */}
                  <button
                    onClick={() => onEditChannel(channel)}
                    className="p-1.5 text-gray-400 hover:text-blue-600 hover:bg-blue-50 rounded"
                    title="Edit channel"
                  >
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                    </svg>
                  </button>

                  {/* Delete button */}
                  <button
                    onClick={() => handleRemoveChannel(channel.channelKey)}
                    className="p-1.5 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded"
                    title="Remove channel"
                  >
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                    </svg>
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Info message */}
      <div className="text-sm text-gray-500 bg-gray-50 rounded-lg p-3">
        <strong>Tip:</strong> Data channels are optional but recommended for multi-parameter sensors.
        Each channel will be displayed separately on dashboards and can have individual alert rules.
      </div>
    </div>
  );
}

// Helper function to discover channels from sample data
function discoverFromSampleData(sampleData: Record<string, unknown>): DiscoveredChannel[] {
  const channels: DiscoveredChannel[] = [];

  function processObject(obj: Record<string, unknown>, prefix = '') {
    for (const [key, value] of Object.entries(obj)) {
      const fullKey = prefix ? `${prefix}.${key}` : key;
      const normalizedKey = key.toLowerCase().replace(/[^a-z0-9]+/g, '_');

      // Skip metadata fields
      if (['timestamp', 'time', 'datetime', 'device_id', 'sensor_id', 'id', 'topic'].includes(normalizedKey)) {
        continue;
      }

      // Handle nested objects
      if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
        processObject(value as Record<string, unknown>, fullKey);
        continue;
      }

      // Get known parameter info
      const known = KNOWN_PARAMETERS[normalizedKey];

      // Infer data type
      let dataType = ChannelDataType.STRING;
      if (typeof value === 'number' || (typeof value === 'string' && !isNaN(parseFloat(value)))) {
        dataType = ChannelDataType.NUMBER;
      } else if (typeof value === 'boolean') {
        dataType = ChannelDataType.BOOLEAN;
      }

      channels.push({
        channelKey: normalizedKey,
        suggestedLabel: known?.label || key.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
        inferredDataType: known ? ChannelDataType.NUMBER : dataType,
        inferredUnit: known?.unit,
        sampleValue: value,
        dataPath: fullKey,
        suggestedMin: known?.min,
        suggestedMax: known?.max,
      });
    }
  }

  processObject(sampleData);
  return channels;
}

export default DataChannelsStep;
