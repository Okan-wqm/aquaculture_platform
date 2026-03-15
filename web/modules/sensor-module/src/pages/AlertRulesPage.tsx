/**
 * Alert Rules Page
 *
 * CRUD interface for managing alert rules.
 * Features:
 * - List view with farmId/isActive filters
 * - Create/Edit form with conditions, severity, channels, recipients, cooldown
 * - Delete confirmation dialog
 * - Toggle active/inactive
 * - Turkish labels following existing AlertsPage pattern
 */

import React, { useState, useCallback } from 'react';
import {
  Plus,
  Edit3,
  Trash2,
  Loader2,
  XCircle,
  RefreshCw,
  AlertTriangle,
  Bell,
  BellOff,
  ChevronDown,
  ChevronUp,
  X,
  Check,
  Shield,
  Filter,
} from 'lucide-react';
import {
  useAlertRules,
  useCreateAlertRule,
  useUpdateAlertRule,
  useDeleteAlertRule,
  useToggleAlertRule,
  AlertRule,
  AlertCondition,
  AlertSeverity,
  AlertOperator,
  CreateAlertRuleInput,
  UpdateAlertRuleInput,
} from '../hooks/useAlertRules';

// ============================================================================
// Constants
// ============================================================================

const SEVERITY_OPTIONS: { value: AlertSeverity; label: string; className: string }[] = [
  { value: 'critical', label: 'Kritik', className: 'bg-red-100 text-red-800 border-red-200' },
  { value: 'high', label: 'Yuksek', className: 'bg-orange-100 text-orange-800 border-orange-200' },
  { value: 'warning', label: 'Uyari', className: 'bg-yellow-100 text-yellow-800 border-yellow-200' },
  { value: 'medium', label: 'Orta', className: 'bg-amber-100 text-amber-800 border-amber-200' },
  { value: 'low', label: 'Dusuk', className: 'bg-blue-100 text-blue-800 border-blue-200' },
  { value: 'info', label: 'Bilgi', className: 'bg-gray-100 text-gray-800 border-gray-200' },
];

const OPERATOR_OPTIONS: { value: AlertOperator; label: string; symbol: string }[] = [
  { value: 'gt', label: 'Buyuktur', symbol: '>' },
  { value: 'gte', label: 'Buyuk Esit', symbol: '>=' },
  { value: 'lt', label: 'Kucuktur', symbol: '<' },
  { value: 'lte', label: 'Kucuk Esit', symbol: '<=' },
  { value: 'eq', label: 'Esit', symbol: '=' },
];

const CHANNEL_OPTIONS = [
  { value: 'email', label: 'E-posta' },
  { value: 'sms', label: 'SMS' },
  { value: 'push', label: 'Push Bildirim' },
];

const PARAMETER_OPTIONS = [
  { value: 'temperature', label: 'Sicaklik' },
  { value: 'ph', label: 'pH' },
  { value: 'dissolvedOxygen', label: 'Cozunmus Oksijen' },
  { value: 'salinity', label: 'Tuzluluk' },
  { value: 'turbidity', label: 'Bulaniklik' },
  { value: 'ammonia', label: 'Amonyak' },
  { value: 'nitrite', label: 'Nitrit' },
  { value: 'nitrate', label: 'Nitrat' },
  { value: 'conductivity', label: 'Iletkenlik' },
  { value: 'orp', label: 'ORP' },
  { value: 'waterLevel', label: 'Su Seviyesi' },
  { value: 'flowRate', label: 'Akis Hizi' },
];

// ============================================================================
// Types
// ============================================================================

type FormMode = 'closed' | 'create' | 'edit';

interface RuleFormData {
  name: string;
  description: string;
  farmId: string;
  pondId: string;
  sensorId: string;
  conditions: AlertCondition[];
  notificationChannels: string[];
  recipients: string;
  cooldownMinutes: number;
}

const EMPTY_CONDITION: AlertCondition = {
  parameter: 'temperature',
  operator: 'gt',
  threshold: 0,
  severity: 'medium',
};

const EMPTY_FORM: RuleFormData = {
  name: '',
  description: '',
  farmId: '',
  pondId: '',
  sensorId: '',
  conditions: [{ ...EMPTY_CONDITION }],
  notificationChannels: ['email'],
  recipients: '',
  cooldownMinutes: 5,
};

// ============================================================================
// Helper Components
// ============================================================================

const SeverityBadge: React.FC<{ severity: AlertSeverity }> = ({ severity }) => {
  const config = SEVERITY_OPTIONS.find((s) => s.value === severity) || SEVERITY_OPTIONS[3];
  return (
    <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium border ${config.className}`}>
      {config.label}
    </span>
  );
};

const OperatorLabel: React.FC<{ operator: AlertOperator }> = ({ operator }) => {
  const op = OPERATOR_OPTIONS.find((o) => o.value === operator);
  return <span className="font-mono text-sm">{op?.symbol || operator}</span>;
};

// ============================================================================
// Condition Editor Component
// ============================================================================

const ConditionEditor: React.FC<{
  conditions: AlertCondition[];
  onChange: (conditions: AlertCondition[]) => void;
}> = ({ conditions, onChange }) => {
  const updateCondition = (index: number, field: keyof AlertCondition, value: unknown) => {
    const updated = conditions.map((c, i) =>
      i === index ? { ...c, [field]: value } : c,
    );
    onChange(updated);
  };

  const addCondition = () => {
    onChange([...conditions, { ...EMPTY_CONDITION }]);
  };

  const removeCondition = (index: number) => {
    if (conditions.length <= 1) return;
    onChange(conditions.filter((_, i) => i !== index));
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <label className="block text-sm font-medium text-gray-700">
          Kosullar <span className="text-red-500">*</span>
        </label>
        <button
          type="button"
          onClick={addCondition}
          className="flex items-center gap-1 text-sm text-cyan-600 hover:text-cyan-700"
        >
          <Plus className="w-4 h-4" />
          Kosul Ekle
        </button>
      </div>

      {conditions.map((condition, index) => (
        <div
          key={index}
          className="bg-gray-50 border border-gray-200 rounded-lg p-4 space-y-3"
        >
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-gray-500">Kosul #{index + 1}</span>
            {conditions.length > 1 && (
              <button
                type="button"
                onClick={() => removeCondition(index)}
                className="text-red-400 hover:text-red-600"
              >
                <X className="w-4 h-4" />
              </button>
            )}
          </div>

          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            {/* Parameter */}
            <div>
              <label className="block text-xs text-gray-500 mb-1">Parametre</label>
              <select
                value={condition.parameter}
                onChange={(e) => updateCondition(index, 'parameter', e.target.value)}
                className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-cyan-500"
              >
                {PARAMETER_OPTIONS.map((p) => (
                  <option key={p.value} value={p.value}>
                    {p.label}
                  </option>
                ))}
              </select>
            </div>

            {/* Operator */}
            <div>
              <label className="block text-xs text-gray-500 mb-1">Operator</label>
              <select
                value={condition.operator}
                onChange={(e) => updateCondition(index, 'operator', e.target.value as AlertOperator)}
                className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-cyan-500"
              >
                {OPERATOR_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.symbol} {o.label}
                  </option>
                ))}
              </select>
            </div>

            {/* Threshold */}
            <div>
              <label className="block text-xs text-gray-500 mb-1">Esik Deger</label>
              <input
                type="number"
                step="any"
                value={condition.threshold}
                onChange={(e) => updateCondition(index, 'threshold', parseFloat(e.target.value) || 0)}
                className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-cyan-500"
              />
            </div>

            {/* Severity */}
            <div>
              <label className="block text-xs text-gray-500 mb-1">Onem Derecesi</label>
              <select
                value={condition.severity}
                onChange={(e) => updateCondition(index, 'severity', e.target.value as AlertSeverity)}
                className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-cyan-500"
              >
                {SEVERITY_OPTIONS.map((s) => (
                  <option key={s.value} value={s.value}>
                    {s.label}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
};

// ============================================================================
// Rule Form Component
// ============================================================================

const RuleForm: React.FC<{
  mode: 'create' | 'edit';
  initialData?: RuleFormData;
  editRuleId?: string;
  onSubmit: (data: RuleFormData) => void;
  onCancel: () => void;
  isPending: boolean;
}> = ({ mode, initialData, editRuleId, onSubmit, onCancel, isPending }) => {
  const [form, setForm] = useState<RuleFormData>(initialData || { ...EMPTY_FORM });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.name.trim() || form.conditions.length === 0) return;
    onSubmit(form);
  };

  const updateField = <K extends keyof RuleFormData>(field: K, value: RuleFormData[K]) => {
    setForm((prev) => ({ ...prev, [field]: value }));
  };

  const toggleChannel = (channel: string) => {
    setForm((prev) => ({
      ...prev,
      notificationChannels: prev.notificationChannels.includes(channel)
        ? prev.notificationChannels.filter((c) => c !== channel)
        : [...prev.notificationChannels, channel],
    }));
  };

  return (
    <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-lg font-semibold text-gray-900">
          {mode === 'create' ? 'Yeni Alarm Kurali' : 'Alarm Kuralini Duzenle'}
        </h2>
        <button onClick={onCancel} className="text-gray-400 hover:text-gray-600">
          <X className="w-5 h-5" />
        </button>
      </div>

      <form onSubmit={handleSubmit} className="space-y-5">
        {/* Name & Description */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Kural Adi <span className="text-red-500">*</span>
            </label>
            <input
              type="text"
              value={form.name}
              onChange={(e) => updateField('name', e.target.value)}
              placeholder="Ornegin: Yuksek Sicaklik Alarmi"
              maxLength={100}
              required
              className="w-full px-3 py-2 border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-cyan-500 text-sm"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Aciklama</label>
            <input
              type="text"
              value={form.description}
              onChange={(e) => updateField('description', e.target.value)}
              placeholder="Kuralın kisa aciklamasi"
              maxLength={500}
              className="w-full px-3 py-2 border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-cyan-500 text-sm"
            />
          </div>
        </div>

        {/* Farm, Pond, Sensor IDs */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Farm ID</label>
            <input
              type="text"
              value={form.farmId}
              onChange={(e) => updateField('farmId', e.target.value)}
              placeholder="Opsiyonel"
              className="w-full px-3 py-2 border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-cyan-500 text-sm"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Havuz ID</label>
            <input
              type="text"
              value={form.pondId}
              onChange={(e) => updateField('pondId', e.target.value)}
              placeholder="Opsiyonel"
              className="w-full px-3 py-2 border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-cyan-500 text-sm"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Sensor ID</label>
            <input
              type="text"
              value={form.sensorId}
              onChange={(e) => updateField('sensorId', e.target.value)}
              placeholder="Opsiyonel"
              className="w-full px-3 py-2 border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-cyan-500 text-sm"
            />
          </div>
        </div>

        {/* Conditions */}
        <ConditionEditor
          conditions={form.conditions}
          onChange={(conditions) => updateField('conditions', conditions)}
        />

        {/* Notification Channels */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">Bildirim Kanallari</label>
          <div className="flex flex-wrap gap-2">
            {CHANNEL_OPTIONS.map((ch) => (
              <button
                key={ch.value}
                type="button"
                onClick={() => toggleChannel(ch.value)}
                className={`px-4 py-2 rounded-lg text-sm font-medium border transition-colors ${
                  form.notificationChannels.includes(ch.value)
                    ? 'bg-cyan-50 text-cyan-700 border-cyan-200'
                    : 'bg-white text-gray-600 border-gray-200 hover:bg-gray-50'
                }`}
              >
                {form.notificationChannels.includes(ch.value) && (
                  <Check className="w-3.5 h-3.5 inline mr-1" />
                )}
                {ch.label}
              </button>
            ))}
          </div>
        </div>

        {/* Recipients */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            Alicilar
          </label>
          <input
            type="text"
            value={form.recipients}
            onChange={(e) => updateField('recipients', e.target.value)}
            placeholder="Virgul ile ayrilmis e-posta adresleri veya kullanici ID'leri"
            className="w-full px-3 py-2 border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-cyan-500 text-sm"
          />
          <p className="text-xs text-gray-400 mt-1">Birden fazla alici icin virgul kullanin</p>
        </div>

        {/* Cooldown */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            Bekleme Suresi (dakika)
          </label>
          <input
            type="number"
            min={1}
            value={form.cooldownMinutes}
            onChange={(e) => updateField('cooldownMinutes', parseInt(e.target.value, 10) || 5)}
            className="w-32 px-3 py-2 border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-cyan-500 text-sm"
          />
          <p className="text-xs text-gray-400 mt-1">
            Ayni kural icin tekrar alarm gondermeden onceki minimum bekleme suresi
          </p>
        </div>

        {/* Actions */}
        <div className="flex items-center justify-end gap-3 pt-4 border-t border-gray-100">
          <button
            type="button"
            onClick={onCancel}
            disabled={isPending}
            className="px-5 py-2 text-sm font-medium text-gray-700 bg-gray-100 rounded-lg hover:bg-gray-200 transition-colors disabled:opacity-50"
          >
            Iptal
          </button>
          <button
            type="submit"
            disabled={isPending || !form.name.trim()}
            className="flex items-center gap-2 px-5 py-2 text-sm font-medium text-white bg-cyan-600 rounded-lg hover:bg-cyan-700 transition-colors disabled:opacity-50"
          >
            {isPending && <Loader2 className="w-4 h-4 animate-spin" />}
            {mode === 'create' ? 'Olustur' : 'Kaydet'}
          </button>
        </div>
      </form>
    </div>
  );
};

// ============================================================================
// Delete Confirmation Dialog
// ============================================================================

const DeleteDialog: React.FC<{
  ruleName: string;
  onConfirm: () => void;
  onCancel: () => void;
  isPending: boolean;
}> = ({ ruleName, onConfirm, onCancel, isPending }) => {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="bg-white rounded-xl shadow-xl p-6 max-w-md w-full mx-4">
        <div className="flex items-center gap-3 mb-4">
          <div className="flex items-center justify-center w-10 h-10 bg-red-100 rounded-full">
            <AlertTriangle className="w-5 h-5 text-red-600" />
          </div>
          <h3 className="text-lg font-semibold text-gray-900">Kurali Sil</h3>
        </div>
        <p className="text-gray-600 mb-6">
          <strong>"{ruleName}"</strong> alarm kuralini silmek istediginizden emin misiniz?
          Bu islem geri alinamaz.
        </p>
        <div className="flex items-center justify-end gap-3">
          <button
            onClick={onCancel}
            disabled={isPending}
            className="px-4 py-2 text-sm font-medium text-gray-700 bg-gray-100 rounded-lg hover:bg-gray-200 transition-colors disabled:opacity-50"
          >
            Iptal
          </button>
          <button
            onClick={onConfirm}
            disabled={isPending}
            className="flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-red-600 rounded-lg hover:bg-red-700 transition-colors disabled:opacity-50"
          >
            {isPending && <Loader2 className="w-4 h-4 animate-spin" />}
            Evet, Sil
          </button>
        </div>
      </div>
    </div>
  );
};

// ============================================================================
// Rule Card Component
// ============================================================================

const RuleCard: React.FC<{
  rule: AlertRule;
  onEdit: (rule: AlertRule) => void;
  onDelete: (rule: AlertRule) => void;
  onToggle: (rule: AlertRule) => void;
  isToggling: boolean;
}> = ({ rule, onEdit, onDelete, onToggle, isToggling }) => {
  const [expanded, setExpanded] = useState(false);

  // Get the highest severity from conditions
  const maxSeverity = rule.conditions.reduce<AlertSeverity>((max, c) => {
    const order: AlertSeverity[] = ['info', 'low', 'warning', 'medium', 'high', 'critical'];
    return order.indexOf(c.severity) > order.indexOf(max) ? c.severity : max;
  }, 'info');

  const parameterLabel = (param: string) =>
    PARAMETER_OPTIONS.find((p) => p.value === param)?.label || param;

  return (
    <div
      className={`bg-white rounded-xl shadow-sm border border-gray-100 p-5 transition-all ${
        !rule.isActive ? 'opacity-60' : ''
      }`}
    >
      {/* Header */}
      <div className="flex items-start justify-between">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1 flex-wrap">
            <h3 className="font-semibold text-gray-900 truncate">{rule.name}</h3>
            <SeverityBadge severity={rule.severity || maxSeverity} />
            <span
              className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${
                rule.isActive
                  ? 'bg-green-100 text-green-700 border border-green-200'
                  : 'bg-gray-100 text-gray-500 border border-gray-200'
              }`}
            >
              {rule.isActive ? 'Aktif' : 'Pasif'}
            </span>
          </div>
          {rule.description && (
            <p className="text-sm text-gray-500 mb-2">{rule.description}</p>
          )}

          {/* Summary row */}
          <div className="flex items-center gap-4 text-sm text-gray-500 flex-wrap">
            <span>{rule.conditions.length} kosul</span>
            {rule.cooldownMinutes > 0 && <span>Bekleme: {rule.cooldownMinutes} dk</span>}
            {rule.notificationChannels && rule.notificationChannels.length > 0 && (
              <span>
                Kanallar: {rule.notificationChannels.join(', ')}
              </span>
            )}
            {rule.farmId && (
              <span className="text-xs font-mono">Farm: {rule.farmId.slice(0, 8)}...</span>
            )}
          </div>
        </div>

        {/* Actions */}
        <div className="flex items-center gap-1.5 ml-4 shrink-0">
          <button
            onClick={() => onToggle(rule)}
            disabled={isToggling}
            title={rule.isActive ? 'Pasif yap' : 'Aktif yap'}
            className={`p-2 rounded-lg transition-colors ${
              rule.isActive
                ? 'text-green-600 hover:bg-green-50'
                : 'text-gray-400 hover:bg-gray-100'
            } disabled:opacity-50`}
          >
            {isToggling ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : rule.isActive ? (
              <Bell className="w-4 h-4" />
            ) : (
              <BellOff className="w-4 h-4" />
            )}
          </button>
          <button
            onClick={() => onEdit(rule)}
            title="Duzenle"
            className="p-2 rounded-lg text-gray-400 hover:text-cyan-600 hover:bg-cyan-50 transition-colors"
          >
            <Edit3 className="w-4 h-4" />
          </button>
          <button
            onClick={() => onDelete(rule)}
            title="Sil"
            className="p-2 rounded-lg text-gray-400 hover:text-red-600 hover:bg-red-50 transition-colors"
          >
            <Trash2 className="w-4 h-4" />
          </button>
          <button
            onClick={() => setExpanded(!expanded)}
            title={expanded ? 'Daralt' : 'Genislet'}
            className="p-2 rounded-lg text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition-colors"
          >
            {expanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
          </button>
        </div>
      </div>

      {/* Expanded Conditions Detail */}
      {expanded && (
        <div className="mt-4 pt-4 border-t border-gray-100 space-y-3">
          <h4 className="text-sm font-medium text-gray-700">Kosul Detaylari</h4>
          <div className="space-y-2">
            {rule.conditions.map((condition, idx) => (
              <div
                key={idx}
                className="flex items-center gap-3 bg-gray-50 rounded-lg px-4 py-2.5 text-sm"
              >
                <span className="font-medium text-gray-700">
                  {parameterLabel(condition.parameter)}
                </span>
                <OperatorLabel operator={condition.operator} />
                <span className="font-semibold text-gray-900">{condition.threshold}</span>
                <SeverityBadge severity={condition.severity} />
              </div>
            ))}
          </div>

          {/* Recipients */}
          {rule.recipients && rule.recipients.length > 0 && (
            <div>
              <h4 className="text-sm font-medium text-gray-700 mb-1">Alicilar</h4>
              <div className="flex flex-wrap gap-1.5">
                {rule.recipients.map((r, i) => (
                  <span
                    key={i}
                    className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs bg-gray-100 text-gray-700"
                  >
                    {r}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Metadata */}
          <div className="text-xs text-gray-400 flex gap-4">
            <span>Olusturulma: {new Date(rule.createdAt).toLocaleString('tr-TR')}</span>
            <span>Guncelleme: {new Date(rule.updatedAt).toLocaleString('tr-TR')}</span>
          </div>
        </div>
      )}
    </div>
  );
};

// ============================================================================
// Alert Rules Page
// ============================================================================

const AlertRulesPage: React.FC = () => {
  // Filters
  const [filterFarmId, setFilterFarmId] = useState<string>('');
  const [filterIsActive, setFilterIsActive] = useState<string>('all'); // 'all' | 'true' | 'false'

  // Form state
  const [formMode, setFormMode] = useState<FormMode>('closed');
  const [editingRule, setEditingRule] = useState<AlertRule | null>(null);

  // Delete dialog state
  const [deletingRule, setDeletingRule] = useState<AlertRule | null>(null);

  // Toggling rule ID
  const [togglingId, setTogglingId] = useState<string | null>(null);

  // Build filter
  const filter = {
    farmId: filterFarmId || undefined,
    isActive: filterIsActive === 'all' ? undefined : filterIsActive === 'true',
  };

  // Hooks
  const { data: rules, isLoading, error, refetch } = useAlertRules(filter);
  const createMutation = useCreateAlertRule();
  const updateMutation = useUpdateAlertRule();
  const deleteMutation = useDeleteAlertRule();
  const toggleMutation = useToggleAlertRule();

  // Handlers
  const handleCreate = useCallback(
    async (formData: RuleFormData) => {
      const input: CreateAlertRuleInput = {
        name: formData.name.trim(),
        description: formData.description.trim() || undefined,
        farmId: formData.farmId.trim() || undefined,
        pondId: formData.pondId.trim() || undefined,
        sensorId: formData.sensorId.trim() || undefined,
        conditions: formData.conditions,
        notificationChannels:
          formData.notificationChannels.length > 0 ? formData.notificationChannels : undefined,
        recipients: formData.recipients.trim()
          ? formData.recipients.split(',').map((r) => r.trim()).filter(Boolean)
          : undefined,
        cooldownMinutes: formData.cooldownMinutes,
      };

      await createMutation.mutateAsync(input);
      setFormMode('closed');
    },
    [createMutation],
  );

  const handleUpdate = useCallback(
    async (formData: RuleFormData) => {
      if (!editingRule) return;

      const input: UpdateAlertRuleInput = {
        ruleId: editingRule.id,
        name: formData.name.trim(),
        description: formData.description.trim() || undefined,
        conditions: formData.conditions,
        notificationChannels:
          formData.notificationChannels.length > 0 ? formData.notificationChannels : undefined,
        recipients: formData.recipients.trim()
          ? formData.recipients.split(',').map((r) => r.trim()).filter(Boolean)
          : undefined,
        cooldownMinutes: formData.cooldownMinutes,
      };

      await updateMutation.mutateAsync(input);
      setFormMode('closed');
      setEditingRule(null);
    },
    [editingRule, updateMutation],
  );

  const handleEdit = useCallback((rule: AlertRule) => {
    setEditingRule(rule);
    setFormMode('edit');
  }, []);

  const handleDelete = useCallback(async () => {
    if (!deletingRule) return;
    await deleteMutation.mutateAsync(deletingRule.id);
    setDeletingRule(null);
  }, [deletingRule, deleteMutation]);

  const handleToggle = useCallback(
    async (rule: AlertRule) => {
      setTogglingId(rule.id);
      try {
        await toggleMutation.mutateAsync({ ruleId: rule.id, isActive: !rule.isActive });
      } finally {
        setTogglingId(null);
      }
    },
    [toggleMutation],
  );

  const ruleToFormData = (rule: AlertRule): RuleFormData => ({
    name: rule.name,
    description: rule.description || '',
    farmId: rule.farmId || '',
    pondId: rule.pondId || '',
    sensorId: rule.sensorId || '',
    conditions: rule.conditions.length > 0 ? rule.conditions : [{ ...EMPTY_CONDITION }],
    notificationChannels: rule.notificationChannels || [],
    recipients: (rule.recipients || []).join(', '),
    cooldownMinutes: rule.cooldownMinutes,
  });

  // Loading state
  if (isLoading && !rules) {
    return (
      <div className="p-6 flex items-center justify-center min-h-[400px]">
        <div className="text-center">
          <Loader2 className="w-8 h-8 text-cyan-500 animate-spin mx-auto mb-3" />
          <p className="text-gray-500">Alarm kurallari yukleniyor...</p>
        </div>
      </div>
    );
  }

  // Error state
  if (error && !rules) {
    return (
      <div className="p-6">
        <div className="bg-red-50 border border-red-100 rounded-xl p-6 text-center">
          <XCircle className="w-10 h-10 text-red-400 mx-auto mb-3" />
          <h3 className="font-semibold text-red-900 text-lg">Yukleme Hatasi</h3>
          <p className="text-sm text-red-600 mt-1">{(error as Error).message}</p>
          <button
            onClick={() => refetch()}
            className="mt-4 px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 transition-colors text-sm"
          >
            Tekrar Dene
          </button>
        </div>
      </div>
    );
  }

  const ruleList = rules || [];

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Alarm Kurallari</h1>
          <p className="text-gray-500 mt-1">
            {ruleList.length} kural tanimli
            {ruleList.filter((r) => r.isActive).length > 0 && (
              <span className="text-green-600 font-medium">
                {' '}({ruleList.filter((r) => r.isActive).length} aktif)
              </span>
            )}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => refetch()}
            disabled={isLoading}
            className="flex items-center gap-2 px-4 py-2 bg-gray-100 text-gray-700 rounded-lg hover:bg-gray-200 transition-colors"
          >
            <RefreshCw className={`w-4 h-4 ${isLoading ? 'animate-spin' : ''}`} />
            Yenile
          </button>
          <button
            onClick={() => {
              setEditingRule(null);
              setFormMode('create');
            }}
            className="flex items-center gap-2 px-4 py-2 bg-cyan-600 text-white rounded-lg hover:bg-cyan-700 transition-colors"
          >
            <Plus className="w-4 h-4" />
            Yeni Kural
          </button>
        </div>
      </div>

      {/* Filters */}
      <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-4">
        <div className="flex flex-col md:flex-row gap-4 items-start md:items-center">
          <div className="flex items-center gap-2">
            <Filter className="w-5 h-5 text-gray-500" />
            <span className="text-sm font-medium text-gray-700">Filtreler:</span>
          </div>

          {/* Active/Inactive Filter */}
          <div className="flex bg-gray-100 rounded-lg p-1">
            {[
              { value: 'all', label: 'Tumu' },
              { value: 'true', label: 'Aktif' },
              { value: 'false', label: 'Pasif' },
            ].map((tab) => (
              <button
                key={tab.value}
                onClick={() => setFilterIsActive(tab.value)}
                className={`px-4 py-1.5 text-sm font-medium rounded-md transition-colors ${
                  filterIsActive === tab.value
                    ? 'bg-white text-gray-900 shadow-sm'
                    : 'text-gray-600 hover:text-gray-900'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>

          {/* Farm ID Filter */}
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={filterFarmId}
              onChange={(e) => setFilterFarmId(e.target.value)}
              placeholder="Farm ID ile filtrele..."
              className="px-3 py-1.5 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-cyan-500 w-64"
            />
            {filterFarmId && (
              <button
                onClick={() => setFilterFarmId('')}
                className="text-gray-400 hover:text-gray-600"
              >
                <X className="w-4 h-4" />
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Error banner (non-blocking) */}
      {error && ruleList.length > 0 && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-3 flex items-center gap-2">
          <XCircle className="w-4 h-4 text-red-500 shrink-0" />
          <p className="text-sm text-red-700">{(error as Error).message}</p>
          <button onClick={() => refetch()} className="ml-auto text-sm text-red-600 hover:underline">
            Tekrar Dene
          </button>
        </div>
      )}

      {/* Mutation error banners */}
      {createMutation.error && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-3 flex items-center gap-2">
          <XCircle className="w-4 h-4 text-red-500 shrink-0" />
          <p className="text-sm text-red-700">Olusturma hatasi: {(createMutation.error as Error).message}</p>
        </div>
      )}
      {updateMutation.error && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-3 flex items-center gap-2">
          <XCircle className="w-4 h-4 text-red-500 shrink-0" />
          <p className="text-sm text-red-700">Guncelleme hatasi: {(updateMutation.error as Error).message}</p>
        </div>
      )}
      {deleteMutation.error && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-3 flex items-center gap-2">
          <XCircle className="w-4 h-4 text-red-500 shrink-0" />
          <p className="text-sm text-red-700">Silme hatasi: {(deleteMutation.error as Error).message}</p>
        </div>
      )}

      {/* Create/Edit Form */}
      {formMode === 'create' && (
        <RuleForm
          mode="create"
          onSubmit={handleCreate}
          onCancel={() => setFormMode('closed')}
          isPending={createMutation.isPending}
        />
      )}
      {formMode === 'edit' && editingRule && (
        <RuleForm
          mode="edit"
          initialData={ruleToFormData(editingRule)}
          editRuleId={editingRule.id}
          onSubmit={handleUpdate}
          onCancel={() => {
            setFormMode('closed');
            setEditingRule(null);
          }}
          isPending={updateMutation.isPending}
        />
      )}

      {/* Empty State */}
      {ruleList.length === 0 && !isLoading && formMode === 'closed' && (
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-12 text-center">
          <Shield className="w-12 h-12 text-gray-400 mx-auto mb-4" />
          <h3 className="text-lg font-medium text-gray-700 mb-2">Alarm Kurali Bulunamadi</h3>
          <p className="text-gray-500 text-sm mb-6">
            {filterFarmId || filterIsActive !== 'all'
              ? 'Secili filtrelerle eslesen alarm kurali bulunamadi. Filtreleri degistirmeyi deneyin.'
              : 'Henuz tanimlanmis alarm kurali bulunmuyor. Ilk kurali olusturun.'}
          </p>
          {!filterFarmId && filterIsActive === 'all' && (
            <button
              onClick={() => setFormMode('create')}
              className="inline-flex items-center gap-2 px-5 py-2.5 bg-cyan-600 text-white rounded-lg hover:bg-cyan-700 transition-colors"
            >
              <Plus className="w-4 h-4" />
              Ilk Kurali Olustur
            </button>
          )}
        </div>
      )}

      {/* Rules List */}
      <div className="space-y-4">
        {ruleList.map((rule) => (
          <RuleCard
            key={rule.id}
            rule={rule}
            onEdit={handleEdit}
            onDelete={setDeletingRule}
            onToggle={handleToggle}
            isToggling={togglingId === rule.id}
          />
        ))}
      </div>

      {/* Delete Confirmation Dialog */}
      {deletingRule && (
        <DeleteDialog
          ruleName={deletingRule.name}
          onConfirm={handleDelete}
          onCancel={() => setDeletingRule(null)}
          isPending={deleteMutation.isPending}
        />
      )}
    </div>
  );
};

export default AlertRulesPage;
