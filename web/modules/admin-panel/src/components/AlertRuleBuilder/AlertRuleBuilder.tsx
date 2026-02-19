/**
 * Alert Rule Builder Component
 *
 * A comprehensive UI for creating and editing alert rules.
 * Supports complex conditions, severity configuration, and notification settings.
 */

import React, { useState, useCallback, useMemo } from 'react';

// ============================================================================
// Type Definitions
// ============================================================================

export type AlertSeverity = 'critical' | 'high' | 'medium' | 'low' | 'info';
export type ConditionOperator = 'gt' | 'gte' | 'lt' | 'lte' | 'eq' | 'ne' | 'between' | 'outside';
export type LogicalOperator = 'and' | 'or';
export type TimeUnit = 'seconds' | 'minutes' | 'hours' | 'days';
export type SensorType =
  | 'temperature'
  | 'ph'
  | 'dissolved_oxygen'
  | 'turbidity'
  | 'ammonia'
  | 'nitrite'
  | 'nitrate'
  | 'salinity'
  | 'water_level'
  | 'multi_parameter'
  | 'flow_rate'
  | 'conductivity'
  | 'orp'
  | 'chlorine'
  | 'co2';

export interface RuleCondition {
  id: string;
  sensorType: SensorType;
  operator: ConditionOperator;
  value: number;
  secondValue?: number; // For 'between' and 'outside' operators
  duration?: number;
  durationUnit?: TimeUnit;
}

export interface ConditionGroup {
  id: string;
  logicalOperator: LogicalOperator;
  conditions: RuleCondition[];
}

export interface NotificationChannel {
  type: 'email' | 'sms' | 'slack' | 'webhook' | 'push';
  enabled: boolean;
  config?: Record<string, unknown>;
}

export interface AlertRule {
  id?: string;
  name: string;
  description: string;
  enabled: boolean;
  severity: AlertSeverity;
  conditionGroups: ConditionGroup[];
  groupOperator: LogicalOperator;
  cooldownMinutes: number;
  notificationChannels: NotificationChannel[];
  escalationPolicyId?: string;
  farmIds?: string[];
  pondIds?: string[];
  metadata?: Record<string, unknown>;
}

export interface ValidationError {
  field: string;
  message: string;
}

export interface AlertRuleBuilderProps {
  /** Initial rule data for editing */
  initialRule?: Partial<AlertRule>;
  /** Available sensor types */
  availableSensorTypes?: SensorType[];
  /** Available farms for selection */
  farms?: Array<{ id: string; name: string }>;
  /** Available ponds for selection */
  ponds?: Array<{ id: string; name: string; farmId: string }>;
  /** Available escalation policies */
  escalationPolicies?: Array<{ id: string; name: string }>;
  /** Callback when rule is saved */
  onSave?: (rule: AlertRule) => Promise<void>;
  /** Callback when cancelled */
  onCancel?: () => void;
  /** Loading state */
  isLoading?: boolean;
  /** Disable editing */
  disabled?: boolean;
  /** Custom class name */
  className?: string;
}

// ============================================================================
// Constants
// ============================================================================

export const SEVERITY_OPTIONS: Array<{ value: AlertSeverity; label: string; color: string }> = [
  { value: 'critical', label: 'Kritik', color: 'red' },
  { value: 'high', label: 'Yüksek', color: 'orange' },
  { value: 'medium', label: 'Orta', color: 'yellow' },
  { value: 'low', label: 'Düşük', color: 'blue' },
  { value: 'info', label: 'Bilgi', color: 'gray' },
];

export const OPERATOR_OPTIONS: Array<{ value: ConditionOperator; label: string; symbol: string }> = [
  { value: 'gt', label: 'Büyük', symbol: '>' },
  { value: 'gte', label: 'Büyük veya Eşit', symbol: '>=' },
  { value: 'lt', label: 'Küçük', symbol: '<' },
  { value: 'lte', label: 'Küçük veya Eşit', symbol: '<=' },
  { value: 'eq', label: 'Eşit', symbol: '=' },
  { value: 'ne', label: 'Eşit Değil', symbol: '!=' },
  { value: 'between', label: 'Arasında', symbol: '↔' },
  { value: 'outside', label: 'Dışında', symbol: '↮' },
];

export const SENSOR_TYPE_OPTIONS: Array<{ value: SensorType; label: string; unit: string }> = [
  { value: 'temperature', label: 'Sıcaklık', unit: '°C' },
  { value: 'ph', label: 'pH', unit: 'pH' },
  { value: 'dissolved_oxygen', label: 'Çözünmüş Oksijen', unit: 'mg/L' },
  { value: 'turbidity', label: 'Bulanıklık', unit: 'NTU' },
  { value: 'ammonia', label: 'Amonyak', unit: 'mg/L' },
  { value: 'nitrite', label: 'Nitrit', unit: 'mg/L' },
  { value: 'nitrate', label: 'Nitrat', unit: 'mg/L' },
  { value: 'salinity', label: 'Tuzluluk', unit: 'ppt' },
  { value: 'water_level', label: 'Su Seviyesi', unit: 'cm' },
  { value: 'multi_parameter', label: 'Çoklu Parametre', unit: '-' },
  { value: 'flow_rate', label: 'Akış Hızı', unit: 'L/dk' },
  { value: 'conductivity', label: 'İletkenlik', unit: 'μS/cm' },
  { value: 'orp', label: 'ORP', unit: 'mV' },
  { value: 'chlorine', label: 'Klor', unit: 'mg/L' },
  { value: 'co2', label: 'CO₂', unit: 'mg/L' },
];

export const TIME_UNIT_OPTIONS: Array<{ value: TimeUnit; label: string }> = [
  { value: 'seconds', label: 'Saniye' },
  { value: 'minutes', label: 'Dakika' },
  { value: 'hours', label: 'Saat' },
  { value: 'days', label: 'Gün' },
];

export const NOTIFICATION_CHANNEL_OPTIONS: Array<{ type: NotificationChannel['type']; label: string; icon: string }> = [
  { type: 'email', label: 'E-posta', icon: '📧' },
  { type: 'sms', label: 'SMS', icon: '📱' },
  { type: 'slack', label: 'Slack', icon: '💬' },
  { type: 'webhook', label: 'Webhook', icon: '🔗' },
  { type: 'push', label: 'Push Bildirimi', icon: '🔔' },
];

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Generate a unique ID
 */
export function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

/**
 * Create a new condition with defaults
 */
export function createCondition(overrides: Partial<RuleCondition> = {}): RuleCondition {
  return {
    id: generateId(),
    sensorType: 'temperature',
    operator: 'gt',
    value: 0,
    ...overrides,
  };
}

/**
 * Create a new condition group with defaults
 */
export function createConditionGroup(overrides: Partial<ConditionGroup> = {}): ConditionGroup {
  return {
    id: generateId(),
    logicalOperator: 'and',
    conditions: [createCondition()],
    ...overrides,
  };
}

/**
 * Create a default alert rule
 */
export function createDefaultRule(overrides: Partial<AlertRule> = {}): AlertRule {
  return {
    name: '',
    description: '',
    enabled: true,
    severity: 'medium',
    conditionGroups: [createConditionGroup()],
    groupOperator: 'and',
    cooldownMinutes: 5,
    notificationChannels: [
      { type: 'email', enabled: true },
    ],
    ...overrides,
  };
}

/**
 * Validate a rule and return errors
 */
export function validateRule(rule: AlertRule): ValidationError[] {
  const errors: ValidationError[] = [];

  // Name validation
  if (!rule.name.trim()) {
    errors.push({ field: 'name', message: 'Rule name is required' });
  } else if (rule.name.length < 3) {
    errors.push({ field: 'name', message: 'Rule name must be at least 3 characters' });
  } else if (rule.name.length > 100) {
    errors.push({ field: 'name', message: 'Rule name cannot exceed 100 characters' });
  }

  // Description validation
  if (rule.description && rule.description.length > 500) {
    errors.push({ field: 'description', message: 'Description cannot exceed 500 characters' });
  }

  // Condition groups validation
  if (rule.conditionGroups.length === 0) {
    errors.push({ field: 'conditionGroups', message: 'At least one condition group is required' });
  }

  rule.conditionGroups.forEach((group, groupIndex) => {
    if (group.conditions.length === 0) {
      errors.push({
        field: `conditionGroups.${groupIndex}.conditions`,
        message: `Group ${groupIndex + 1} must contain at least one condition`,
      });
    }

    group.conditions.forEach((condition, condIndex) => {
      if (condition.value === undefined || condition.value === null) {
        errors.push({
          field: `conditionGroups.${groupIndex}.conditions.${condIndex}.value`,
          message: `Condition value is required`,
        });
      }

      if (['between', 'outside'].includes(condition.operator)) {
        if (condition.secondValue === undefined || condition.secondValue === null) {
          errors.push({
            field: `conditionGroups.${groupIndex}.conditions.${condIndex}.secondValue`,
            message: `Second value is required`,
          });
        } else if (condition.secondValue <= condition.value) {
          errors.push({
            field: `conditionGroups.${groupIndex}.conditions.${condIndex}.secondValue`,
            message: `Second value must be greater than first value`,
          });
        }
      }

      if (condition.duration !== undefined && condition.duration < 0) {
        errors.push({
          field: `conditionGroups.${groupIndex}.conditions.${condIndex}.duration`,
          message: `Duration cannot be negative`,
        });
      }
    });
  });

  // Cooldown validation
  if (rule.cooldownMinutes < 0) {
    errors.push({ field: 'cooldownMinutes', message: 'Cooldown period cannot be negative' });
  } else if (rule.cooldownMinutes > 1440) {
    errors.push({ field: 'cooldownMinutes', message: 'Cooldown period cannot exceed 24 hours' });
  }

  // Notification channels validation
  const hasEnabledChannel = rule.notificationChannels.some(ch => ch.enabled);
  if (!hasEnabledChannel) {
    errors.push({ field: 'notificationChannels', message: 'At least one notification channel must be active' });
  }

  return errors;
}

/**
 * Get sensor unit by type
 */
export function getSensorUnit(sensorType: SensorType): string {
  const sensor = SENSOR_TYPE_OPTIONS.find(s => s.value === sensorType);
  return sensor?.unit || '';
}

/**
 * Format condition as readable string
 */
export function formatCondition(condition: RuleCondition): string {
  const sensor = SENSOR_TYPE_OPTIONS.find(s => s.value === condition.sensorType);
  const operator = OPERATOR_OPTIONS.find(o => o.value === condition.operator);
  const unit = sensor?.unit || '';

  if (['between', 'outside'].includes(condition.operator)) {
    const action = condition.operator === 'between' ? 'between' : 'outside';
    return `${sensor?.label} ${condition.value}${unit} - ${condition.secondValue}${unit} ${action}`;
  }

  return `${sensor?.label} ${operator?.symbol} ${condition.value}${unit}`;
}

// ============================================================================
// Sub-Components
// ============================================================================

interface ConditionEditorProps {
  condition: RuleCondition;
  onChange: (condition: RuleCondition) => void;
  onRemove: () => void;
  disabled?: boolean;
  showRemove?: boolean;
  availableSensorTypes?: SensorType[];
}

export const ConditionEditor: React.FC<ConditionEditorProps> = ({
  condition,
  onChange,
  onRemove,
  disabled = false,
  showRemove = true,
  availableSensorTypes,
}) => {
  const sensorTypes = availableSensorTypes || SENSOR_TYPE_OPTIONS.map(s => s.value);
  const filteredSensorOptions = SENSOR_TYPE_OPTIONS.filter(s => sensorTypes.includes(s.value));
  const needsSecondValue = ['between', 'outside'].includes(condition.operator);
  const unit = getSensorUnit(condition.sensorType);

  return (
    <div
      className="flex flex-wrap items-center gap-2 p-3 bg-gray-50 rounded-lg"
      data-testid={`condition-${condition.id}`}
    >
      {/* Sensor Type Select */}
      <select
        value={condition.sensorType}
        onChange={(e) => onChange({ ...condition, sensorType: e.target.value as SensorType })}
        disabled={disabled}
        className="px-3 py-2 border rounded-md text-sm"
        data-testid={`sensor-select-${condition.id}`}
        aria-label="Sensör tipi"
      >
        {filteredSensorOptions.map(sensor => (
          <option key={sensor.value} value={sensor.value}>
            {sensor.label}
          </option>
        ))}
      </select>

      {/* Operator Select */}
      <select
        value={condition.operator}
        onChange={(e) => onChange({ ...condition, operator: e.target.value as ConditionOperator })}
        disabled={disabled}
        className="px-3 py-2 border rounded-md text-sm"
        data-testid={`operator-select-${condition.id}`}
        aria-label="Operatör"
      >
        {OPERATOR_OPTIONS.map(op => (
          <option key={op.value} value={op.value}>
            {op.symbol} {op.label}
          </option>
        ))}
      </select>

      {/* Value Input */}
      <div className="flex items-center gap-1">
        <input
          type="number"
          value={condition.value}
          onChange={(e) => onChange({ ...condition, value: parseFloat(e.target.value) || 0 })}
          disabled={disabled}
          className="w-20 px-3 py-2 border rounded-md text-sm"
          data-testid={`value-input-${condition.id}`}
          aria-label="Değer"
        />
        <span className="text-sm text-gray-500">{unit}</span>
      </div>

      {/* Second Value Input (for between/outside) */}
      {needsSecondValue && (
        <>
          <span className="text-sm text-gray-500">-</span>
          <div className="flex items-center gap-1">
            <input
              type="number"
              value={condition.secondValue || 0}
              onChange={(e) => onChange({ ...condition, secondValue: parseFloat(e.target.value) || 0 })}
              disabled={disabled}
              className="w-20 px-3 py-2 border rounded-md text-sm"
              data-testid={`second-value-input-${condition.id}`}
              aria-label="İkinci değer"
            />
            <span className="text-sm text-gray-500">{unit}</span>
          </div>
        </>
      )}

      {/* Duration Input (optional) */}
      <div className="flex items-center gap-1 ml-2">
        <span className="text-sm text-gray-500">Süre:</span>
        <input
          type="number"
          value={condition.duration || 0}
          onChange={(e) => onChange({ ...condition, duration: parseInt(e.target.value) || 0 })}
          disabled={disabled}
          className="w-16 px-2 py-2 border rounded-md text-sm"
          data-testid={`duration-input-${condition.id}`}
          aria-label="Süre"
          min="0"
        />
        <select
          value={condition.durationUnit || 'minutes'}
          onChange={(e) => onChange({ ...condition, durationUnit: e.target.value as TimeUnit })}
          disabled={disabled}
          className="px-2 py-2 border rounded-md text-sm"
          data-testid={`duration-unit-${condition.id}`}
          aria-label="Süre birimi"
        >
          {TIME_UNIT_OPTIONS.map(unit => (
            <option key={unit.value} value={unit.value}>
              {unit.label}
            </option>
          ))}
        </select>
      </div>

      {/* Remove Button */}
      {showRemove && !disabled && (
        <button
          type="button"
          onClick={onRemove}
          className="ml-auto p-2 text-red-500 hover:text-red-700 hover:bg-red-50 rounded"
          data-testid={`remove-condition-${condition.id}`}
          aria-label="Koşulu kaldır"
        >
          ✕
        </button>
      )}
    </div>
  );
};

interface ConditionGroupEditorProps {
  group: ConditionGroup;
  groupIndex: number;
  onChange: (group: ConditionGroup) => void;
  onRemove: () => void;
  disabled?: boolean;
  showRemove?: boolean;
  availableSensorTypes?: SensorType[];
}

export const ConditionGroupEditor: React.FC<ConditionGroupEditorProps> = ({
  group,
  groupIndex,
  onChange,
  onRemove,
  disabled = false,
  showRemove = true,
  availableSensorTypes,
}) => {
  const handleConditionChange = (index: number, condition: RuleCondition) => {
    const newConditions = [...group.conditions];
    newConditions[index] = condition;
    onChange({ ...group, conditions: newConditions });
  };

  const handleConditionRemove = (index: number) => {
    const newConditions = group.conditions.filter((_, i) => i !== index);
    onChange({ ...group, conditions: newConditions });
  };

  const handleAddCondition = () => {
    onChange({
      ...group,
      conditions: [...group.conditions, createCondition()],
    });
  };

  return (
    <div
      className="border rounded-lg p-4 bg-white"
      data-testid={`condition-group-${group.id}`}
    >
      {/* Group Header */}
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-gray-700">Grup {groupIndex + 1}</span>
          <select
            value={group.logicalOperator}
            onChange={(e) => onChange({ ...group, logicalOperator: e.target.value as LogicalOperator })}
            disabled={disabled}
            className="px-2 py-1 text-sm border rounded"
            data-testid={`group-operator-${group.id}`}
            aria-label="Mantıksal operatör"
          >
            <option value="and">VE (Tümü)</option>
            <option value="or">VEYA (Herhangi biri)</option>
          </select>
        </div>

        {showRemove && !disabled && (
          <button
            type="button"
            onClick={onRemove}
            className="p-1 text-red-500 hover:text-red-700 hover:bg-red-50 rounded"
            data-testid={`remove-group-${group.id}`}
            aria-label="Grubu kaldır"
          >
            🗑️ Grubu Sil
          </button>
        )}
      </div>

      {/* Conditions */}
      <div className="space-y-2">
        {group.conditions.map((condition, index) => (
          <React.Fragment key={condition.id}>
            {index > 0 && (
              <div className="text-center text-sm text-gray-500 py-1">
                {group.logicalOperator === 'and' ? 'VE' : 'VEYA'}
              </div>
            )}
            <ConditionEditor
              condition={condition}
              onChange={(updated) => handleConditionChange(index, updated)}
              onRemove={() => handleConditionRemove(index)}
              disabled={disabled}
              showRemove={group.conditions.length > 1}
              availableSensorTypes={availableSensorTypes}
            />
          </React.Fragment>
        ))}
      </div>

      {/* Add Condition Button */}
      {!disabled && (
        <button
          type="button"
          onClick={handleAddCondition}
          className="mt-3 w-full py-2 border-2 border-dashed border-gray-300 rounded-lg text-sm text-gray-500 hover:border-blue-400 hover:text-blue-500 transition-colors"
          data-testid={`add-condition-${group.id}`}
        >
          + Koşul Ekle
        </button>
      )}
    </div>
  );
};

interface NotificationChannelEditorProps {
  channels: NotificationChannel[];
  onChange: (channels: NotificationChannel[]) => void;
  disabled?: boolean;
}

export const NotificationChannelEditor: React.FC<NotificationChannelEditorProps> = ({
  channels,
  onChange,
  disabled = false,
}) => {
  const toggleChannel = (type: NotificationChannel['type']) => {
    const existing = channels.find(ch => ch.type === type);
    if (existing) {
      onChange(
        channels.map(ch =>
          ch.type === type ? { ...ch, enabled: !ch.enabled } : ch
        )
      );
    } else {
      onChange([...channels, { type, enabled: true }]);
    }
  };

  const isEnabled = (type: NotificationChannel['type']): boolean => {
    const channel = channels.find(ch => ch.type === type);
    return channel?.enabled ?? false;
  };

  return (
    <div className="space-y-2" data-testid="notification-channels">
      <label className="block text-sm font-medium text-gray-700">
        Bildirim Kanalları
      </label>
      <div className="flex flex-wrap gap-2">
        {NOTIFICATION_CHANNEL_OPTIONS.map(option => (
          <button
            key={option.type}
            type="button"
            onClick={() => toggleChannel(option.type)}
            disabled={disabled}
            className={`
              flex items-center gap-2 px-4 py-2 rounded-lg border transition-colors
              ${isEnabled(option.type)
                ? 'bg-blue-50 border-blue-300 text-blue-700'
                : 'bg-gray-50 border-gray-200 text-gray-500'}
              ${disabled ? 'opacity-50 cursor-not-allowed' : 'hover:bg-blue-100'}
            `}
            data-testid={`channel-${option.type}`}
            aria-pressed={isEnabled(option.type)}
          >
            <span>{option.icon}</span>
            <span className="text-sm">{option.label}</span>
          </button>
        ))}
      </div>
    </div>
  );
};

interface SeveritySelectorProps {
  value: AlertSeverity;
  onChange: (severity: AlertSeverity) => void;
  disabled?: boolean;
}

export const SeveritySelector: React.FC<SeveritySelectorProps> = ({
  value,
  onChange,
  disabled = false,
}) => {
  return (
    <div className="space-y-2" data-testid="severity-selector">
      <label className="block text-sm font-medium text-gray-700">
        Önem Derecesi
      </label>
      <div className="flex gap-2">
        {SEVERITY_OPTIONS.map(option => (
          <button
            key={option.value}
            type="button"
            onClick={() => onChange(option.value)}
            disabled={disabled}
            className={`
              flex-1 py-2 px-3 rounded-lg border text-sm font-medium transition-colors
              ${value === option.value
                ? `bg-${option.color}-100 border-${option.color}-300 text-${option.color}-700`
                : 'bg-gray-50 border-gray-200 text-gray-500'}
              ${disabled ? 'opacity-50 cursor-not-allowed' : 'hover:opacity-80'}
            `}
            data-testid={`severity-${option.value}`}
            aria-pressed={value === option.value}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  );
};

// ============================================================================
// Main Component
// ============================================================================

export const AlertRuleBuilder: React.FC<AlertRuleBuilderProps> = ({
  initialRule,
  availableSensorTypes,
  farms = [],
  ponds = [],
  escalationPolicies = [],
  onSave,
  onCancel,
  isLoading = false,
  disabled = false,
  className = '',
}) => {
  // State
  const [rule, setRule] = useState<AlertRule>(() =>
    createDefaultRule(initialRule)
  );
  const [errors, setErrors] = useState<ValidationError[]>([]);
  const [isSaving, setIsSaving] = useState(false);

  // Derived state
  const isEditing = !!initialRule?.id;
  const isDisabled = disabled || isLoading || isSaving;

  // Validation
  const validate = useCallback((): boolean => {
    const validationErrors = validateRule(rule);
    setErrors(validationErrors);
    return validationErrors.length === 0;
  }, [rule]);

  // Get error for field
  const getError = useCallback((field: string): string | undefined => {
    return errors.find(e => e.field === field)?.message;
  }, [errors]);

  // Handlers
  const handleFieldChange = useCallback((field: keyof AlertRule, value: unknown) => {
    setRule(prev => ({ ...prev, [field]: value }));
    // Clear error for this field
    setErrors(prev => prev.filter(e => !e.field.startsWith(field)));
  }, []);

  const handleConditionGroupChange = useCallback((index: number, group: ConditionGroup) => {
    setRule(prev => {
      const newGroups = [...prev.conditionGroups];
      newGroups[index] = group;
      return { ...prev, conditionGroups: newGroups };
    });
  }, []);

  const handleConditionGroupRemove = useCallback((index: number) => {
    setRule(prev => ({
      ...prev,
      conditionGroups: prev.conditionGroups.filter((_, i) => i !== index),
    }));
  }, []);

  const handleAddConditionGroup = useCallback(() => {
    setRule(prev => ({
      ...prev,
      conditionGroups: [...prev.conditionGroups, createConditionGroup()],
    }));
  }, []);

  const handleSave = useCallback(async () => {
    if (!validate()) return;
    if (!onSave) return;

    setIsSaving(true);
    try {
      await onSave(rule);
    } catch (error) {
      console.error('Failed to save rule:', error);
    } finally {
      setIsSaving(false);
    }
  }, [validate, onSave, rule]);

  // Filter ponds by selected farms
  const availablePonds = useMemo(() => {
    if (!rule.farmIds?.length) return ponds;
    return ponds.filter(pond => rule.farmIds?.includes(pond.farmId));
  }, [ponds, rule.farmIds]);

  return (
    <div
      className={`bg-white rounded-lg shadow-sm ${className}`}
      data-testid="alert-rule-builder"
    >
      {/* Header */}
      <div className="px-6 py-4 border-b">
        <h2 className="text-xl font-semibold text-gray-900">
          {isEditing ? 'Kuralı Düzenle' : 'Yeni Kural Oluştur'}
        </h2>
        <p className="text-sm text-gray-500 mt-1">
          Sensör verilerine göre uyarı tetiklemek için kural yapılandırın
        </p>
      </div>

      {/* Content */}
      <div className="p-6 space-y-6">
        {/* Basic Info */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {/* Name */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Kural Adı *
            </label>
            <input
              type="text"
              value={rule.name}
              onChange={(e) => handleFieldChange('name', e.target.value)}
              disabled={isDisabled}
              placeholder="örn: Yüksek Sıcaklık Uyarısı"
              className={`
                w-full px-4 py-2 border rounded-lg
                ${getError('name') ? 'border-red-300' : 'border-gray-300'}
              `}
              data-testid="rule-name-input"
              aria-invalid={!!getError('name')}
            />
            {getError('name') && (
              <p className="mt-1 text-sm text-red-500" data-testid="name-error">
                {getError('name')}
              </p>
            )}
          </div>

          {/* Enabled Toggle */}
          <div className="flex items-center">
            <label className="flex items-center cursor-pointer">
              <input
                type="checkbox"
                checked={rule.enabled}
                onChange={(e) => handleFieldChange('enabled', e.target.checked)}
                disabled={isDisabled}
                className="w-4 h-4 text-blue-600 rounded"
                data-testid="rule-enabled-toggle"
              />
              <span className="ml-2 text-sm text-gray-700">Kural Aktif</span>
            </label>
          </div>
        </div>

        {/* Description */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            Açıklama
          </label>
          <textarea
            value={rule.description}
            onChange={(e) => handleFieldChange('description', e.target.value)}
            disabled={isDisabled}
            placeholder="Kural hakkında açıklama..."
            rows={2}
            className={`
              w-full px-4 py-2 border rounded-lg resize-none
              ${getError('description') ? 'border-red-300' : 'border-gray-300'}
            `}
            data-testid="rule-description-input"
          />
          {getError('description') && (
            <p className="mt-1 text-sm text-red-500">
              {getError('description')}
            </p>
          )}
        </div>

        {/* Severity */}
        <SeveritySelector
          value={rule.severity}
          onChange={(severity) => handleFieldChange('severity', severity)}
          disabled={isDisabled}
        />

        {/* Condition Groups */}
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <label className="block text-sm font-medium text-gray-700">
              Koşullar *
            </label>
            {rule.conditionGroups.length > 1 && (
              <select
                value={rule.groupOperator}
                onChange={(e) => handleFieldChange('groupOperator', e.target.value)}
                disabled={isDisabled}
                className="px-2 py-1 text-sm border rounded"
                data-testid="group-operator-select"
                aria-label="Gruplar arası operatör"
              >
                <option value="and">Tüm gruplar eşleşmeli (VE)</option>
                <option value="or">Herhangi bir grup eşleşmeli (VEYA)</option>
              </select>
            )}
          </div>

          {getError('conditionGroups') && (
            <p className="text-sm text-red-500">{getError('conditionGroups')}</p>
          )}

          <div className="space-y-4">
            {rule.conditionGroups.map((group, index) => (
              <React.Fragment key={group.id}>
                {index > 0 && (
                  <div className="text-center text-sm font-medium text-gray-500 py-2">
                    {rule.groupOperator === 'and' ? '— VE —' : '— VEYA —'}
                  </div>
                )}
                <ConditionGroupEditor
                  group={group}
                  groupIndex={index}
                  onChange={(updated) => handleConditionGroupChange(index, updated)}
                  onRemove={() => handleConditionGroupRemove(index)}
                  disabled={isDisabled}
                  showRemove={rule.conditionGroups.length > 1}
                  availableSensorTypes={availableSensorTypes}
                />
              </React.Fragment>
            ))}
          </div>

          {!isDisabled && (
            <button
              type="button"
              onClick={handleAddConditionGroup}
              className="w-full py-3 border-2 border-dashed border-gray-300 rounded-lg text-gray-500 hover:border-blue-400 hover:text-blue-500 transition-colors"
              data-testid="add-condition-group"
            >
              + Yeni Koşul Grubu Ekle
            </button>
          )}
        </div>

        {/* Cooldown */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            Tekrar Bekleme Süresi (dakika)
          </label>
          <input
            type="number"
            value={rule.cooldownMinutes}
            onChange={(e) => handleFieldChange('cooldownMinutes', parseInt(e.target.value) || 0)}
            disabled={isDisabled}
            min="0"
            max="1440"
            className={`
              w-32 px-4 py-2 border rounded-lg
              ${getError('cooldownMinutes') ? 'border-red-300' : 'border-gray-300'}
            `}
            data-testid="cooldown-input"
          />
          <p className="mt-1 text-xs text-gray-500">
            Aynı uyarının tekrar tetiklenmesi için beklenmesi gereken süre
          </p>
          {getError('cooldownMinutes') && (
            <p className="mt-1 text-sm text-red-500">
              {getError('cooldownMinutes')}
            </p>
          )}
        </div>

        {/* Notification Channels */}
        <NotificationChannelEditor
          channels={rule.notificationChannels}
          onChange={(channels) => handleFieldChange('notificationChannels', channels)}
          disabled={isDisabled}
        />
        {getError('notificationChannels') && (
          <p className="text-sm text-red-500">{getError('notificationChannels')}</p>
        )}

        {/* Farm/Pond Selection (if available) */}
        {farms.length > 0 && (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Çiftlikler (opsiyonel)
              </label>
              <select
                multiple
                value={rule.farmIds || []}
                onChange={(e) => {
                  const selected = Array.from(e.target.selectedOptions, opt => opt.value);
                  handleFieldChange('farmIds', selected);
                }}
                disabled={isDisabled}
                className="w-full px-4 py-2 border border-gray-300 rounded-lg"
                data-testid="farm-select"
              >
                {farms.map(farm => (
                  <option key={farm.id} value={farm.id}>
                    {farm.name}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Havuzlar (opsiyonel)
              </label>
              <select
                multiple
                value={rule.pondIds || []}
                onChange={(e) => {
                  const selected = Array.from(e.target.selectedOptions, opt => opt.value);
                  handleFieldChange('pondIds', selected);
                }}
                disabled={isDisabled}
                className="w-full px-4 py-2 border border-gray-300 rounded-lg"
                data-testid="pond-select"
              >
                {availablePonds.map(pond => (
                  <option key={pond.id} value={pond.id}>
                    {pond.name}
                  </option>
                ))}
              </select>
            </div>
          </div>
        )}

        {/* Escalation Policy */}
        {escalationPolicies.length > 0 && (
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Eskalasyon Politikası
            </label>
            <select
              value={rule.escalationPolicyId || ''}
              onChange={(e) => handleFieldChange('escalationPolicyId', e.target.value || undefined)}
              disabled={isDisabled}
              className="w-full px-4 py-2 border border-gray-300 rounded-lg"
              data-testid="escalation-policy-select"
            >
              <option value="">Seçiniz...</option>
              {escalationPolicies.map(policy => (
                <option key={policy.id} value={policy.id}>
                  {policy.name}
                </option>
              ))}
            </select>
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="px-6 py-4 border-t bg-gray-50 flex justify-end gap-3">
        {onCancel && (
          <button
            type="button"
            onClick={onCancel}
            disabled={isSaving}
            className="px-4 py-2 border border-gray-300 rounded-lg text-gray-700 hover:bg-gray-100 transition-colors"
            data-testid="cancel-button"
          >
            İptal
          </button>
        )}
        <button
          type="button"
          onClick={handleSave}
          disabled={isDisabled || isSaving}
          className={`
            px-6 py-2 rounded-lg text-white font-medium transition-colors
            ${isDisabled || isSaving
              ? 'bg-gray-400 cursor-not-allowed'
              : 'bg-blue-600 hover:bg-blue-700'}
          `}
          data-testid="save-button"
        >
          {isSaving ? 'Kaydediliyor...' : isEditing ? 'Güncelle' : 'Oluştur'}
        </button>
      </div>
    </div>
  );
};

export default AlertRuleBuilder;
