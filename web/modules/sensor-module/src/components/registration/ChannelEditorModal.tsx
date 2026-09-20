import React, { useState, useEffect } from 'react';
import {
  Modal,
  colors as themeColors,
  Button,
  ColorInput,
  Input,
  Select,
  Textarea,
  useI18n,
  type SelectOption,
} from '@aquaculture/shared-ui';
import {
  DataChannelConfig,
  ChannelDataType,
  AlertThresholds,
  ChannelDisplaySettings,
} from '../../types/registration.types';
import { CircleAlert, TriangleAlert } from 'lucide-react';

interface ChannelEditorModalProps {
  channel?: DataChannelConfig;
  isOpen: boolean;
  onClose: () => void;
  onSave: (channel: DataChannelConfig) => void | Promise<void>;
}

const CHANNEL_DATA_TYPE_OPTIONS: readonly SelectOption[] = [
  { value: ChannelDataType.NUMBER, label: 'Number' },
  { value: ChannelDataType.BOOLEAN, label: 'Boolean' },
  { value: ChannelDataType.STRING, label: 'String' },
  { value: ChannelDataType.ENUM, label: 'Enum' },
];

/** Stored readings are rendered at a fixed number of decimals. */
const PRECISION_OPTIONS: readonly SelectOption[] = [
  { value: 0, label: '0 (Integer)' },
  { value: 1, label: '1 decimal' },
  { value: 2, label: '2 decimals' },
  { value: 3, label: '3 decimals' },
  { value: 4, label: '4 decimals' },
];

const UNIT_OPTIONS: readonly SelectOption[] = [
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
  themeColors.info[500], // blue
  themeColors.success[500], // green
  themeColors.warning[500], // amber
  themeColors.error[500], // red
  themeColors.primary[700], // purple
  themeColors.primary[400], // cyan
  themeColors.accent[500], // pink
  themeColors.gray[400], // gray
];

export function ChannelEditorModal({ channel, isOpen, onClose, onSave }: ChannelEditorModalProps) {
  const { t } = useI18n();
  // SENSOR-HIGH-063: a channel is new exactly when it has no persisted id. The
  // previous expression was `!channel?.id && !channel?.channelKey?.startsWith('channel_') === false`,
  // where `!` binds tighter than `===`, so it reduced to "no id AND the key starts
  // with channel_" — true only for an auto-discovered placeholder. Opening the
  // dialog from the Add button passes no channel at all, so it evaluated FALSE and
  // the create dialog titled itself "Edit Data Channel" over a "Save Changes"
  // button. Both callers that mean "new" (Add, and a discovered channel awaiting
  // its first save) are exactly the ones without an id.
  const isNew = !channel?.id;

  // A saved channel's key and data type are fixed: the contract's
  // UpdateDataChannelInput carries neither, because both decide how already-stored
  // readings were parsed. Disabling them keeps the form from offering an edit the
  // save path would silently drop.
  const isPersisted = !isNew;

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
  const [activeTab, setActiveTab] = useState<'basic' | 'calibration' | 'alerts' | 'display'>(
    'basic',
  );

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
      if (channel.unit && !UNIT_OPTIONS.find((u) => u.value === channel.unit)) {
        setCustomUnit(channel.unit);
      }
    }
  }, [channel]);

  // Handle form field changes
  const handleChange = (field: keyof DataChannelConfig, value: unknown) => {
    setFormData((prev) => ({ ...prev, [field]: value }));
  };

  // Handle nested object changes
  const handleAlertChange = (
    level: 'warning' | 'critical',
    bound: 'low' | 'high',
    value: string,
  ) => {
    const numValue = value === '' ? undefined : parseFloat(value);
    setFormData((prev) => ({
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
    setFormData((prev) => ({
      ...prev,
      displaySettings: {
        ...prev.displaySettings,
        [field]: value,
      },
    }));
  };

  // Handle save (L6: supports async onSave, doesn't close - parent controls close on success)
  const handleSave = async () => {
    // Apply custom unit if selected
    let finalUnit = formData.unit;
    if (formData.unit === 'custom') {
      finalUnit = customUnit;
    }

    await onSave({
      ...formData,
      unit: finalUnit,
    });
  };

  if (!isOpen) return null;

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      size="lg"
      className="max-h-[90vh] overflow-hidden"
      bodyClassName=""
      title={isNew ? 'Add Data Channel' : 'Edit Data Channel'}
    >
      {/* Tabs */}
      <div className="flex border-b border-gray-200 dark:border-gray-700">
        {(['basic', 'calibration', 'alerts', 'display'] as const).map((tab) => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={`flex-1 px-4 py-3 text-sm font-medium ${
              activeTab === tab
                ? 'text-info-600 dark:text-info-400 border-b-2 border-info-600 bg-info-50 dark:bg-info-900/20'
                : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-100 hover:bg-gray-50 dark:hover:bg-gray-800'
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
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                Channel Key <span className="text-error-500">*</span>
              </label>
              <Input
                fullWidth
                type="text"
                value={formData.channelKey}
                onChange={(e) =>
                  handleChange(
                    'channelKey',
                    e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '_'),
                  )
                }
                placeholder="e.g., temperature, ph_level"
                disabled={isPersisted}
              />
              <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                {isPersisted
                  ? 'Fixed after creation — stored readings are keyed by it.'
                  : 'Internal identifier. Lowercase letters, numbers, and underscores only.'}
              </p>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                Display Label <span className="text-error-500">*</span>
              </label>
              <Input
                fullWidth
                type="text"
                value={formData.displayLabel}
                onChange={(e) => handleChange('displayLabel', e.target.value)}
                placeholder="e.g., Water Temperature"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                Description
              </label>
              <Textarea
                fullWidth
                value={formData.description || ''}
                onChange={(e) => handleChange('description', e.target.value)}
                rows={2}
                placeholder="Optional description for this channel"
              />
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <Select
                id="channel-editor-data-type"
                label="Data Type"
                value={formData.dataType}
                onChange={(e) => handleChange('dataType', e.target.value)}
                disabled={isPersisted}
                helperText={
                  isPersisted
                    ? 'Fixed after creation — stored readings were parsed as this type.'
                    : undefined
                }
                options={[...CHANNEL_DATA_TYPE_OPTIONS]}
              />

              <div>
                <Select
                  id="channel-editor-unit"
                  label="Unit"
                  value={
                    UNIT_OPTIONS.find((u) => u.value === formData.unit) ? formData.unit : 'custom'
                  }
                  onChange={(e) => handleChange('unit', e.target.value)}
                  options={[...UNIT_OPTIONS]}
                />
                {(formData.unit === 'custom' ||
                  (formData.unit && !UNIT_OPTIONS.find((u) => u.value === formData.unit))) && (
                  <Input
                    fullWidth
                    type="text"
                    value={customUnit || formData.unit || ''}
                    onChange={(e) => setCustomUnit(e.target.value)}
                    placeholder="Enter custom unit"
                  />
                )}
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                  Min Value
                </label>
                <Input
                  fullWidth
                  type="number"
                  step="any"
                  value={formData.minValue ?? ''}
                  onChange={(e) =>
                    handleChange(
                      'minValue',
                      e.target.value === '' ? undefined : parseFloat(e.target.value),
                    )
                  }
                  placeholder="Optional"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                  Max Value
                </label>
                <Input
                  fullWidth
                  type="number"
                  step="any"
                  value={formData.maxValue ?? ''}
                  onChange={(e) =>
                    handleChange(
                      'maxValue',
                      e.target.value === '' ? undefined : parseFloat(e.target.value),
                    )
                  }
                  placeholder="Optional"
                />
              </div>
            </div>

            {formData.sampleValue !== undefined && (
              <div className="bg-gray-50 dark:bg-gray-800 rounded-lg p-3">
                <span className="text-sm text-gray-600 dark:text-gray-400">Sample Value: </span>
                <span className="text-sm font-medium text-gray-900 dark:text-gray-100">
                  {String(formData.sampleValue)} {formData.unit}
                </span>
              </div>
            )}
          </div>
        )}

        {/* Calibration Tab — read-only (SENSOR-HIGH-083).
                Calibration coefficients are owned by the calibration aggregate:
                they can only be changed on the Calibration page via
                recordCalibration, which stamps lastCalibratedAt / nextCalibrationDue
                so the calibration status stays truthful. Editing them here (a
                channel-config surface that never stamped those dates) is exactly
                the write path that made every channel read "never calibrated". */}
        {activeTab === 'calibration' && (
          <div className="space-y-4">
            <div className="bg-info-50 dark:bg-info-900/20 border border-info-200 dark:border-info-800 rounded-lg p-4">
              <p className="text-sm font-medium text-info-900 dark:text-info-100">
                Kalibrasyon, Kalibrasyon sayfasından yönetilir
              </p>
              <p className="text-sm text-info-700 dark:text-info-300 mt-1">
                Kalibrasyon katsayıları (çarpan/ofset) yalnızca Kalibrasyon sayfasında; son
                kalibrasyon tarihi ve sonraki kalibrasyon zamanı damgalanarak kaydedilir. Bu kanalın
                mevcut değerleri aşağıda salt-okunur gösterilir.
              </p>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="bg-gray-50 dark:bg-gray-800 rounded-lg p-3">
                <span className="block text-xs text-gray-500 dark:text-gray-400">Durum</span>
                <span className="text-sm font-medium text-gray-900 dark:text-gray-100">
                  {formData.calibrationEnabled ? 'Aktif' : 'Pasif'}
                </span>
              </div>
              <div className="bg-gray-50 dark:bg-gray-800 rounded-lg p-3">
                <span className="block text-xs text-gray-500 dark:text-gray-400">Formül</span>
                <span className="text-sm font-mono text-gray-900 dark:text-gray-100">
                  (ham × {formData.calibrationMultiplier}) + {formData.calibrationOffset}
                </span>
              </div>
            </div>
          </div>
        )}

        {/* Alerts Tab */}
        {activeTab === 'alerts' && (
          <div className="space-y-6">
            <p className="text-sm text-gray-500 dark:text-gray-400">
              Configure alert thresholds for this channel. Alerts will trigger when values exceed
              these bounds.
            </p>

            {/* Warning Thresholds */}
            <div className="border border-warning-200 dark:border-warning-800 rounded-lg p-4 bg-warning-50 dark:bg-warning-900/20">
              <h4 className="text-sm font-medium text-warning-800 dark:text-warning-200 mb-3 flex items-center">
                <TriangleAlert className="w-5 h-5 mr-2" aria-hidden="true" />
                Warning Thresholds
              </h4>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-medium text-warning-700 dark:text-warning-300 mb-1">
                    Low Warning
                  </label>
                  <Input
                    fullWidth
                    type="number"
                    step="any"
                    value={formData.alertThresholds?.warning?.low ?? ''}
                    onChange={(e) => handleAlertChange('warning', 'low', e.target.value)}
                    placeholder="Below this = warning"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-warning-700 dark:text-warning-300 mb-1">
                    High Warning
                  </label>
                  <Input
                    fullWidth
                    type="number"
                    step="any"
                    value={formData.alertThresholds?.warning?.high ?? ''}
                    onChange={(e) => handleAlertChange('warning', 'high', e.target.value)}
                    placeholder="Above this = warning"
                  />
                </div>
              </div>
            </div>

            {/* Critical Thresholds */}
            <div className="border border-error-200 dark:border-error-800 rounded-lg p-4 bg-error-50 dark:bg-error-900/20">
              <h4 className="text-sm font-medium text-error-800 dark:text-error-200 mb-3 flex items-center">
                <CircleAlert className="w-5 h-5 mr-2" aria-hidden="true" />
                Critical Thresholds
              </h4>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-medium text-error-700 dark:text-error-300 mb-1">
                    Low Critical
                  </label>
                  <Input
                    fullWidth
                    type="number"
                    step="any"
                    value={formData.alertThresholds?.critical?.low ?? ''}
                    onChange={(e) => handleAlertChange('critical', 'low', e.target.value)}
                    placeholder="Below this = critical"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-error-700 dark:text-error-300 mb-1">
                    High Critical
                  </label>
                  <Input
                    fullWidth
                    type="number"
                    step="any"
                    value={formData.alertThresholds?.critical?.high ?? ''}
                    onChange={(e) => handleAlertChange('critical', 'high', e.target.value)}
                    placeholder="Above this = critical"
                  />
                </div>
              </div>
            </div>

            {/* Hysteresis */}
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                Hysteresis
              </label>
              <Input
                fullWidth
                type="number"
                step="0.1"
                value={formData.alertThresholds?.hysteresis ?? ''}
                onChange={(e) =>
                  setFormData((prev) => ({
                    ...prev,
                    alertThresholds: {
                      ...prev.alertThresholds,
                      hysteresis: e.target.value === '' ? undefined : parseFloat(e.target.value),
                    },
                  }))
                }
                placeholder="Optional - prevents alert flapping"
              />
              <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                Value must exceed threshold by this amount to trigger alert, and drop below by this
                amount to clear.
              </p>
            </div>
          </div>
        )}

        {/* Display Tab */}
        {activeTab === 'display' && (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <h4 className="text-sm font-medium text-gray-900 dark:text-gray-100">
                  Show on Dashboard
                </h4>
                <p className="text-sm text-gray-500 dark:text-gray-400">
                  Display this channel on the main dashboard
                </p>
              </div>
              <button
                onClick={() =>
                  handleDisplaySettingChange(
                    'showOnDashboard',
                    !formData.displaySettings?.showOnDashboard,
                  )
                }
                className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                  formData.displaySettings?.showOnDashboard ? 'bg-info-600' : 'bg-gray-300'
                }`}
              >
                <span
                  className={`inline-block h-4 w-4 transform rounded-full bg-white dark:bg-gray-900 transition-transform ${
                    formData.displaySettings?.showOnDashboard ? 'translate-x-6' : 'translate-x-1'
                  }`}
                />
              </button>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                Widget Type
              </label>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {WIDGET_TYPE_OPTIONS.map((opt) => (
                  <button
                    key={opt.value}
                    onClick={() => handleDisplaySettingChange('widgetType', opt.value)}
                    className={`p-3 text-left border rounded-lg transition-colors ${
                      formData.displaySettings?.widgetType === opt.value
                        ? 'border-info-500 bg-info-50 dark:bg-info-900/20'
                        : 'border-gray-200 dark:border-gray-700 hover:border-gray-300 dark:hover:border-gray-500'
                    }`}
                  >
                    <span className="text-sm font-medium text-gray-900 dark:text-gray-100">
                      {opt.label}
                    </span>
                    <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                      {opt.description}
                    </p>
                  </button>
                ))}
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                Color
              </label>
              <div className="flex items-center space-x-2">
                {COLOR_PRESETS.map((color) => (
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
                <ColorInput
                  variant="swatch"
                  aria-label={t('channel.color.custom')}
                  value={formData.displaySettings?.color || themeColors.info[500]}
                  onChange={(e) => handleDisplaySettingChange('color', e.target.value)}
                />
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <Select
                id="channel-editor-precision"
                label="Decimal Precision"
                value={formData.displaySettings?.precision ?? 2}
                onChange={(e) => handleDisplaySettingChange('precision', parseInt(e.target.value))}
                options={[...PRECISION_OPTIONS]}
              />
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                  Icon
                </label>
                <Input
                  fullWidth
                  type="text"
                  value={formData.displaySettings?.icon || ''}
                  onChange={(e) => handleDisplaySettingChange('icon', e.target.value)}
                  placeholder="e.g., thermometer"
                />
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="flex items-center justify-end px-6 py-4 bg-gray-50 dark:bg-gray-800 border-t border-gray-200 dark:border-gray-700 space-x-3">
        <Button variant="secondary" onClick={onClose}>
          Cancel
        </Button>
        <Button
          variant="primary"
          onClick={handleSave}
          disabled={!formData.channelKey || !formData.displayLabel}
        >
          {isNew ? 'Add Channel' : 'Save Changes'}
        </Button>
      </div>
    </Modal>
  );
}

export default ChannelEditorModal;
