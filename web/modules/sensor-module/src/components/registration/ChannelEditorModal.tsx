import React, { useState, useEffect } from 'react';
import {
  DataChannelConfig,
  ChannelDataType,
  AlertThresholds,
  ChannelDisplaySettings,
} from '../../types/registration.types';

interface ChannelEditorModalProps {
  channel?: DataChannelConfig;
  isOpen: boolean;
  onClose: () => void;
  onSave: (channel: DataChannelConfig) => void;
}

const UNIT_OPTIONS = [
  { value: '', label: 'None' },
  { value: '°C', label: '°C (Celsius)' },
  { value: '°F', label: '°F (Fahrenheit)' },
  { value: 'mg/L', label: 'mg/L' },
  { value: 'ppm', label: 'ppm' },
  { value: 'pH', label: 'pH' },
  { value: 'ppt', label: 'ppt (Salinity)' },
  { value: 'NTU', label: 'NTU (Turbidity)' },
  { value: 'µS/cm', label: 'µS/cm (Conductivity)' },
  { value: 'mV', label: 'mV' },
  { value: 'cm', label: 'cm' },
  { value: 'm', label: 'm' },
  { value: 'L/min', label: 'L/min' },
  { value: 'bar', label: 'bar' },
  { value: '%', label: '%' },
  { value: 'mg/L CaCO3', label: 'mg/L CaCO3 (Alkalinity)' },
  { value: 'custom', label: 'Custom...' },
];

const WIDGET_TYPE_OPTIONS = [
  { value: 'gauge', label: 'Gauge', description: 'Circular gauge with min/max range' },
  { value: 'sparkline', label: 'Sparkline', description: 'Mini line chart showing trend' },
  { value: 'number', label: 'Number', description: 'Simple numeric display' },
  { value: 'status', label: 'Status', description: 'Color-coded status indicator' },
];

const COLOR_PRESETS = [
  '#3B82F6', // blue
  '#10B981', // green
  '#F59E0B', // amber
  '#EF4444', // red
  '#8B5CF6', // purple
  '#06B6D4', // cyan
  '#EC4899', // pink
  '#6B7280', // gray
];

export function ChannelEditorModal({
  channel,
  isOpen,
  onClose,
  onSave,
}: ChannelEditorModalProps) {
  const isNew = !channel?.id && !channel?.channelKey?.startsWith('channel_') === false;

  // Form state
  const [formData, setFormData] = useState<DataChannelConfig>({
    channelKey: '',
    displayLabel: '',
    dataType: ChannelDataType.NUMBER,
    calibrationEnabled: false,
    calibrationMultiplier: 1.0,
    calibrationOffset: 0.0,
    isEnabled: true,
    displayOrder: 0,
    displaySettings: {
      showOnDashboard: true,
      precision: 2,
      widgetType: 'number',
    },
  });

  const [customUnit, setCustomUnit] = useState('');
  const [activeTab, setActiveTab] = useState<'basic' | 'calibration' | 'alerts' | 'display'>('basic');

  // Initialize form data when channel changes
  useEffect(() => {
    if (channel) {
      setFormData({
        ...channel,
        displaySettings: channel.displaySettings || {
          showOnDashboard: true,
          precision: 2,
          widgetType: 'number',
        },
      });
      // Check if unit is custom
      if (channel.unit && !UNIT_OPTIONS.find(u => u.value === channel.unit)) {
        setCustomUnit(channel.unit);
      }
    }
  }, [channel]);

  // Handle form field changes
  const handleChange = (field: keyof DataChannelConfig, value: unknown) => {
    setFormData(prev => ({ ...prev, [field]: value }));
  };

  // Handle nested object changes
  const handleAlertChange = (level: 'warning' | 'critical', bound: 'low' | 'high', value: string) => {
    const numValue = value === '' ? undefined : parseFloat(value);
    setFormData(prev => ({
      ...prev,
      alertThresholds: {
        ...prev.alertThresholds,
        [level]: {
          ...prev.alertThresholds?.[level],
          [bound]: numValue,
        },
      },
    }));
  };

  const handleDisplaySettingChange = (field: keyof ChannelDisplaySettings, value: unknown) => {
    setFormData(prev => ({
      ...prev,
      displaySettings: {
        ...prev.displaySettings,
        [field]: value,
      },
    }));
  };

  // Handle save
  const handleSave = () => {
    // Apply custom unit if selected
    let finalUnit = formData.unit;
    if (formData.unit === 'custom') {
      finalUnit = customUnit;
    }

    onSave({
      ...formData,
      unit: finalUnit,
    });
    onClose();
  };

  // Calculate calibrated value preview
  const getCalibratedPreview = () => {
    if (!formData.calibrationEnabled || formData.sampleValue === undefined) {
      return null;
    }
    const raw = typeof formData.sampleValue === 'number'
      ? formData.sampleValue
      : parseFloat(String(formData.sampleValue));
    if (isNaN(raw)) return null;

    const calibrated = (raw * formData.calibrationMultiplier) + formData.calibrationOffset;
    return { raw, calibrated };
  };

  if (!isOpen) return null;

  const calibratedPreview = getCalibratedPreview();

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto">
      {/* Backdrop */}
      <div className="fixed inset-0 bg-black bg-opacity-50" onClick={onClose} />

      {/* Modal */}
      <div className="flex min-h-full items-center justify-center p-4">
        <div className="relative bg-white rounded-xl shadow-xl w-full max-w-2xl max-h-[90vh] overflow-hidden">
          {/* Header */}
          <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200">
            <h2 className="text-lg font-semibold text-gray-900">
              {isNew ? 'Add Data Channel' : 'Edit Data Channel'}
            </h2>
            <button
              onClick={onClose}
              className="text-gray-400 hover:text-gray-600"
            >
              <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>

          {/* Tabs */}
          <div className="flex border-b border-gray-200">
            {(['basic', 'calibration', 'alerts', 'display'] as const).map(tab => (
              <button
                key={tab}
                onClick={() => setActiveTab(tab)}
                className={`flex-1 px-4 py-3 text-sm font-medium ${
                  activeTab === tab
                    ? 'text-blue-600 border-b-2 border-blue-600 bg-blue-50'
                    : 'text-gray-500 hover:text-gray-700 hover:bg-gray-50'
                }`}
              >
                {tab.charAt(0).toUpperCase() + tab.slice(1)}
              </button>
            ))}
          </div>

          {/* Content */}
          <div className="p-6 overflow-y-auto max-h-[calc(90vh-200px)]">
            {/* Basic Info Tab */}
            {activeTab === 'basic' && (
              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Channel Key <span className="text-red-500">*</span>
                  </label>
                  <input
                    type="text"
                    value={formData.channelKey}
                    onChange={(e) => handleChange('channelKey', e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '_'))}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-blue-500 focus:border-blue-500"
                    placeholder="e.g., temperature, ph_level"
                    disabled={!!channel?.id}
                  />
                  <p className="mt-1 text-xs text-gray-500">
                    Internal identifier. Lowercase letters, numbers, and underscores only.
                  </p>
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Display Label <span className="text-red-500">*</span>
                  </label>
                  <input
                    type="text"
                    value={formData.displayLabel}
                    onChange={(e) => handleChange('displayLabel', e.target.value)}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-blue-500 focus:border-blue-500"
                    placeholder="e.g., Water Temperature"
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Description
                  </label>
                  <textarea
                    value={formData.description || ''}
                    onChange={(e) => handleChange('description', e.target.value)}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-blue-500 focus:border-blue-500"
                    rows={2}
                    placeholder="Optional description for this channel"
                  />
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Data Type
                    </label>
                    <select
                      value={formData.dataType}
                      onChange={(e) => handleChange('dataType', e.target.value)}
                      className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-blue-500 focus:border-blue-500"
                    >
                      <option value={ChannelDataType.NUMBER}>Number</option>
                      <option value={ChannelDataType.BOOLEAN}>Boolean</option>
                      <option value={ChannelDataType.STRING}>String</option>
                      <option value={ChannelDataType.ENUM}>Enum</option>
                    </select>
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Unit
                    </label>
                    <select
                      value={UNIT_OPTIONS.find(u => u.value === formData.unit) ? formData.unit : 'custom'}
                      onChange={(e) => handleChange('unit', e.target.value)}
                      className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-blue-500 focus:border-blue-500"
                    >
                      {UNIT_OPTIONS.map(opt => (
                        <option key={opt.value} value={opt.value}>{opt.label}</option>
                      ))}
                    </select>
                    {(formData.unit === 'custom' || (formData.unit && !UNIT_OPTIONS.find(u => u.value === formData.unit))) && (
                      <input
                        type="text"
                        value={customUnit || formData.unit || ''}
                        onChange={(e) => setCustomUnit(e.target.value)}
                        className="mt-2 w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-blue-500 focus:border-blue-500"
                        placeholder="Enter custom unit"
                      />
                    )}
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Min Value
                    </label>
                    <input
                      type="number"
                      step="any"
                      value={formData.minValue ?? ''}
                      onChange={(e) => handleChange('minValue', e.target.value === '' ? undefined : parseFloat(e.target.value))}
                      className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-blue-500 focus:border-blue-500"
                      placeholder="Optional"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Max Value
                    </label>
                    <input
                      type="number"
                      step="any"
                      value={formData.maxValue ?? ''}
                      onChange={(e) => handleChange('maxValue', e.target.value === '' ? undefined : parseFloat(e.target.value))}
                      className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-blue-500 focus:border-blue-500"
                      placeholder="Optional"
                    />
                  </div>
                </div>

                {formData.sampleValue !== undefined && (
                  <div className="bg-gray-50 rounded-lg p-3">
                    <span className="text-sm text-gray-600">Sample Value: </span>
                    <span className="text-sm font-medium text-gray-900">
                      {String(formData.sampleValue)} {formData.unit}
                    </span>
                  </div>
                )}
              </div>
            )}

            {/* Calibration Tab */}
            {activeTab === 'calibration' && (
              <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <div>
                    <h4 className="text-sm font-medium text-gray-900">Enable Calibration</h4>
                    <p className="text-sm text-gray-500">Apply linear transformation to raw values</p>
                  </div>
                  <button
                    onClick={() => handleChange('calibrationEnabled', !formData.calibrationEnabled)}
                    className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                      formData.calibrationEnabled ? 'bg-blue-600' : 'bg-gray-300'
                    }`}
                  >
                    <span
                      className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                        formData.calibrationEnabled ? 'translate-x-6' : 'translate-x-1'
                      }`}
                    />
                  </button>
                </div>

                {formData.calibrationEnabled && (
                  <>
                    <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
                      <p className="text-sm text-blue-800 font-medium mb-2">Formula:</p>
                      <p className="text-lg font-mono text-blue-900">
                        calibrated = (raw × {formData.calibrationMultiplier}) + {formData.calibrationOffset}
                      </p>
                    </div>

                    <div className="grid grid-cols-2 gap-4">
                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1">
                          Multiplier (Slope)
                        </label>
                        <input
                          type="number"
                          step="0.0001"
                          value={formData.calibrationMultiplier}
                          onChange={(e) => handleChange('calibrationMultiplier', parseFloat(e.target.value) || 1.0)}
                          className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-blue-500 focus:border-blue-500"
                        />
                      </div>
                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1">
                          Offset (Intercept)
                        </label>
                        <input
                          type="number"
                          step="0.0001"
                          value={formData.calibrationOffset}
                          onChange={(e) => handleChange('calibrationOffset', parseFloat(e.target.value) || 0.0)}
                          className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-blue-500 focus:border-blue-500"
                        />
                      </div>
                    </div>

                    {calibratedPreview && (
                      <div className="bg-green-50 border border-green-200 rounded-lg p-4">
                        <p className="text-sm text-green-800 font-medium mb-2">Preview with Sample Value:</p>
                        <div className="flex items-center space-x-4">
                          <div>
                            <span className="text-xs text-green-600">Raw:</span>
                            <p className="text-lg font-medium text-green-900">{calibratedPreview.raw}</p>
                          </div>
                          <svg className="w-6 h-6 text-green-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 7l5 5m0 0l-5 5m5-5H6" />
                          </svg>
                          <div>
                            <span className="text-xs text-green-600">Calibrated:</span>
                            <p className="text-lg font-medium text-green-900">
                              {calibratedPreview.calibrated.toFixed(4)} {formData.unit}
                            </p>
                          </div>
                        </div>
                      </div>
                    )}
                  </>
                )}
              </div>
            )}

            {/* Alerts Tab */}
            {activeTab === 'alerts' && (
              <div className="space-y-6">
                <p className="text-sm text-gray-500">
                  Configure alert thresholds for this channel. Alerts will trigger when values exceed these bounds.
                </p>

                {/* Warning Thresholds */}
                <div className="border border-yellow-200 rounded-lg p-4 bg-yellow-50">
                  <h4 className="text-sm font-medium text-yellow-800 mb-3 flex items-center">
                    <svg className="w-5 h-5 mr-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                    </svg>
                    Warning Thresholds
                  </h4>
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="block text-xs font-medium text-yellow-700 mb-1">Low Warning</label>
                      <input
                        type="number"
                        step="any"
                        value={formData.alertThresholds?.warning?.low ?? ''}
                        onChange={(e) => handleAlertChange('warning', 'low', e.target.value)}
                        className="w-full px-3 py-2 border border-yellow-300 rounded-md focus:ring-yellow-500 focus:border-yellow-500 bg-white"
                        placeholder="Below this = warning"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-yellow-700 mb-1">High Warning</label>
                      <input
                        type="number"
                        step="any"
                        value={formData.alertThresholds?.warning?.high ?? ''}
                        onChange={(e) => handleAlertChange('warning', 'high', e.target.value)}
                        className="w-full px-3 py-2 border border-yellow-300 rounded-md focus:ring-yellow-500 focus:border-yellow-500 bg-white"
                        placeholder="Above this = warning"
                      />
                    </div>
                  </div>
                </div>

                {/* Critical Thresholds */}
                <div className="border border-red-200 rounded-lg p-4 bg-red-50">
                  <h4 className="text-sm font-medium text-red-800 mb-3 flex items-center">
                    <svg className="w-5 h-5 mr-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                    </svg>
                    Critical Thresholds
                  </h4>
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="block text-xs font-medium text-red-700 mb-1">Low Critical</label>
                      <input
                        type="number"
                        step="any"
                        value={formData.alertThresholds?.critical?.low ?? ''}
                        onChange={(e) => handleAlertChange('critical', 'low', e.target.value)}
                        className="w-full px-3 py-2 border border-red-300 rounded-md focus:ring-red-500 focus:border-red-500 bg-white"
                        placeholder="Below this = critical"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-red-700 mb-1">High Critical</label>
                      <input
                        type="number"
                        step="any"
                        value={formData.alertThresholds?.critical?.high ?? ''}
                        onChange={(e) => handleAlertChange('critical', 'high', e.target.value)}
                        className="w-full px-3 py-2 border border-red-300 rounded-md focus:ring-red-500 focus:border-red-500 bg-white"
                        placeholder="Above this = critical"
                      />
                    </div>
                  </div>
                </div>

                {/* Hysteresis */}
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Hysteresis
                  </label>
                  <input
                    type="number"
                    step="0.1"
                    value={formData.alertThresholds?.hysteresis ?? ''}
                    onChange={(e) => setFormData(prev => ({
                      ...prev,
                      alertThresholds: {
                        ...prev.alertThresholds,
                        hysteresis: e.target.value === '' ? undefined : parseFloat(e.target.value),
                      },
                    }))}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-blue-500 focus:border-blue-500"
                    placeholder="Optional - prevents alert flapping"
                  />
                  <p className="mt-1 text-xs text-gray-500">
                    Value must exceed threshold by this amount to trigger alert, and drop below by this amount to clear.
                  </p>
                </div>
              </div>
            )}

            {/* Display Tab */}
            {activeTab === 'display' && (
              <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <div>
                    <h4 className="text-sm font-medium text-gray-900">Show on Dashboard</h4>
                    <p className="text-sm text-gray-500">Display this channel on the main dashboard</p>
                  </div>
                  <button
                    onClick={() => handleDisplaySettingChange('showOnDashboard', !formData.displaySettings?.showOnDashboard)}
                    className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                      formData.displaySettings?.showOnDashboard ? 'bg-blue-600' : 'bg-gray-300'
                    }`}
                  >
                    <span
                      className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                        formData.displaySettings?.showOnDashboard ? 'translate-x-6' : 'translate-x-1'
                      }`}
                    />
                  </button>
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    Widget Type
                  </label>
                  <div className="grid grid-cols-2 gap-3">
                    {WIDGET_TYPE_OPTIONS.map(opt => (
                      <button
                        key={opt.value}
                        onClick={() => handleDisplaySettingChange('widgetType', opt.value)}
                        className={`p-3 text-left border rounded-lg transition-colors ${
                          formData.displaySettings?.widgetType === opt.value
                            ? 'border-blue-500 bg-blue-50'
                            : 'border-gray-200 hover:border-gray-300'
                        }`}
                      >
                        <span className="text-sm font-medium text-gray-900">{opt.label}</span>
                        <p className="text-xs text-gray-500 mt-0.5">{opt.description}</p>
                      </button>
                    ))}
                  </div>
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    Color
                  </label>
                  <div className="flex items-center space-x-2">
                    {COLOR_PRESETS.map(color => (
                      <button
                        key={color}
                        onClick={() => handleDisplaySettingChange('color', color)}
                        className={`w-8 h-8 rounded-full border-2 transition-transform ${
                          formData.displaySettings?.color === color
                            ? 'border-gray-900 scale-110'
                            : 'border-transparent hover:scale-105'
                        }`}
                        style={{ backgroundColor: color }}
                      />
                    ))}
                    <input
                      type="color"
                      value={formData.displaySettings?.color || '#3B82F6'}
                      onChange={(e) => handleDisplaySettingChange('color', e.target.value)}
                      className="w-8 h-8 rounded cursor-pointer"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Decimal Precision
                    </label>
                    <select
                      value={formData.displaySettings?.precision ?? 2}
                      onChange={(e) => handleDisplaySettingChange('precision', parseInt(e.target.value))}
                      className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-blue-500 focus:border-blue-500"
                    >
                      <option value={0}>0 (Integer)</option>
                      <option value={1}>1 decimal</option>
                      <option value={2}>2 decimals</option>
                      <option value={3}>3 decimals</option>
                      <option value={4}>4 decimals</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Icon
                    </label>
                    <input
                      type="text"
                      value={formData.displaySettings?.icon || ''}
                      onChange={(e) => handleDisplaySettingChange('icon', e.target.value)}
                      className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-blue-500 focus:border-blue-500"
                      placeholder="e.g., thermometer"
                    />
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Footer */}
          <div className="flex items-center justify-end px-6 py-4 bg-gray-50 border-t border-gray-200 space-x-3">
            <button
              onClick={onClose}
              className="px-4 py-2 text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50"
            >
              Cancel
            </button>
            <button
              onClick={handleSave}
              disabled={!formData.channelKey || !formData.displayLabel}
              className="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isNew ? 'Add Channel' : 'Save Changes'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export default ChannelEditorModal;
