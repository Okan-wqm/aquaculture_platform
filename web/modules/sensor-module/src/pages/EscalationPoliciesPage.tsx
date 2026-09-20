/**
 * Escalation Policies Page
 *
 * Full CRUD interface for managing escalation policies.
 * Features:
 * - Policy list with status indicators (active/default/severity)
 * - Create/edit policy form (name, severity levels, escalation chain)
 * - Suppression windows management (maintenance windows)
 * - On-call schedule display
 * - Clone policy action
 * - Delete with confirmation
 * - Turkish labels following existing AlertRulesPage pattern
 */

import React, { useState, useCallback } from 'react';
import {
  Button,
  ConfirmModal,
  Input,
  Modal,
  PageHeader,
  severityClasses,
  Spinner,
  ToggleButton,
  useI18n,
} from '@aquaculture/shared-ui';
import {
  Plus,
  Edit3,
  Trash2,
  XCircle,
  RefreshCw,
  AlertTriangle,
  Shield,
  ShieldCheck,
  Copy,
  X,
  Check,
  ChevronDown,
  ChevronUp,
  Clock,
  Calendar,
  UserCheck,
  Bell,
  BellOff,
  Star,
  Layers,
  PauseCircle,
  Phone,
} from 'lucide-react';
import {
  useEscalationPolicies,
  useCreateEscalationPolicy,
  useUpdateEscalationPolicy,
  useDeleteEscalationPolicy,
  useCloneEscalationPolicy,
  useToggleEscalationPolicy,
  useAddSuppressionWindow,
  useRemoveSuppressionWindow,
  EscalationPolicy,
  EscalationLevel,
  OnCallSchedule,
  SuppressionWindow,
  AlertSeverity,
  EscalationActionType,
  NotificationChannel,
  CreateEscalationPolicyInput,
  UpdateEscalationPolicyInput,
  SuppressionWindowInput,
} from '../hooks/useEscalationPolicies';

// ============================================================================
// Constants
// ============================================================================

const SEVERITY_OPTIONS: { value: AlertSeverity; label: string; className: string }[] = [
  { value: 'critical', label: 'Kritik', className: severityClasses('critical') },
  { value: 'high', label: 'Yüksek', className: severityClasses('high') },
  { value: 'warning', label: 'Uyari', className: severityClasses('warning') },
  { value: 'medium', label: 'Orta', className: severityClasses('medium') },
  { value: 'low', label: 'Düşük', className: severityClasses('low') },
  { value: 'info', label: 'Bilgi', className: severityClasses('info') },
];

const ACTION_OPTIONS: { value: EscalationActionType; label: string }[] = [
  { value: 'NOTIFY', label: 'Bildirim Gonder' },
  { value: 'ASSIGN', label: 'Atama Yap' },
  { value: 'ESCALATE_TO_MANAGER', label: 'Yoneticiye Ilet' },
  { value: 'CREATE_TICKET', label: 'Bilet Oluştur' },
  { value: 'WEBHOOK', label: 'Webhook' },
  { value: 'AUTO_RESOLVE', label: 'Otomatik Cozumle' },
];

const CHANNEL_OPTIONS: { value: NotificationChannel; label: string }[] = [
  { value: 'EMAIL', label: 'E-posta' },
  { value: 'SMS', label: 'SMS' },
  { value: 'PUSH', label: 'Push' },
  { value: 'SLACK', label: 'Slack' },
  { value: 'TEAMS', label: 'Teams' },
  { value: 'WEBHOOK', label: 'Webhook' },
  { value: 'PAGERDUTY', label: 'PagerDuty' },
];

const DAY_NAMES = ['Pazar', 'Pazartesi', 'Sali', 'Carsamba', 'Persembe', 'Cuma', 'Cumartesi'];

// ============================================================================
// Types
// ============================================================================

type FormMode = 'closed' | 'create' | 'edit';

interface PolicyFormData {
  name: string;
  description: string;
  severity: AlertSeverity[];
  levels: EscalationLevel[];
  repeatIntervalMinutes: number;
  maxRepeats: number;
  isDefault: boolean;
  priority: number;
  timezone: string;
}

const EMPTY_LEVEL: EscalationLevel = {
  level: 1,
  name: '',
  timeoutMinutes: 15,
  notifyUserIds: [],
  channels: ['EMAIL'],
  action: 'NOTIFY',
};

const EMPTY_FORM: PolicyFormData = {
  name: '',
  description: '',
  severity: ['critical', 'high'],
  levels: [{ ...EMPTY_LEVEL }],
  repeatIntervalMinutes: 5,
  maxRepeats: 3,
  isDefault: false,
  priority: 0,
  timezone: '',
};

// ============================================================================
// Helper Components
// ============================================================================

const SeverityBadge: React.FC<{ severity: AlertSeverity }> = ({ severity }) => {
  const config = SEVERITY_OPTIONS.find((s) => s.value === severity) || SEVERITY_OPTIONS[5];
  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium border ${config.className}`}
    >
      {config.label}
    </span>
  );
};

// ============================================================================
// Escalation Level Editor
// ============================================================================

const LevelEditor: React.FC<{
  levels: EscalationLevel[];
  onChange: (levels: EscalationLevel[]) => void;
}> = ({ levels, onChange }) => {
  const updateLevel = (index: number, field: keyof EscalationLevel, value: unknown) => {
    const updated = levels.map((l, i) => (i === index ? { ...l, [field]: value } : l));
    onChange(updated);
  };

  const addLevel = () => {
    const nextNum = levels.length + 1;
    onChange([...levels, { ...EMPTY_LEVEL, level: nextNum, name: `Seviye ${nextNum}` }]);
  };

  const removeLevel = (index: number) => {
    if (levels.length <= 1) return;
    const updated = levels.filter((_, i) => i !== index).map((l, i) => ({ ...l, level: i + 1 }));
    onChange(updated);
  };

  const toggleChannel = (index: number, channel: NotificationChannel) => {
    const level = levels[index];
    const channels = level.channels.includes(channel)
      ? level.channels.filter((c) => c !== channel)
      : [...level.channels, channel];
    updateLevel(index, 'channels', channels);
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
          Eskalasyon Seviyeleri <span className="text-error-500">*</span>
        </label>
        <Button
          variant="ghost"
          leftIcon={<Plus className="w-4 h-4" />}
          type="button"
          onClick={addLevel}
        >
          Seviye Ekle
        </Button>
      </div>

      {levels.map((level, index) => (
        <div
          key={index}
          className="bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg p-4 space-y-3"
        >
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Layers className="w-4 h-4 text-gray-400 dark:text-gray-500" />
              <span className="text-sm font-semibold text-gray-700 dark:text-gray-300">
                Seviye {level.level}
              </span>
            </div>
            {levels.length > 1 && (
              <Button
                variant="ghost"
                iconOnly
                aria-label="Close"
                type="button"
                onClick={() => removeLevel(index)}
              >
                <X className="w-4 h-4" />
              </Button>
            )}
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            {/* Name */}
            <Input
              label="Seviye Adi"
              fullWidth
              type="text"
              value={level.name}
              onChange={(e) => updateLevel(index, 'name', e.target.value)}
              placeholder="Ornegin: Ilk Bildirim"
            />

            {/* Timeout */}
            <Input
              label="Bekleme Suresi (dk)"
              fullWidth
              type="number"
              min={0}
              value={level.timeoutMinutes}
              onChange={(e) =>
                updateLevel(index, 'timeoutMinutes', parseInt(e.target.value, 10) || 0)
              }
            />

            {/* Action */}
            <div>
              <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">Aksiyon</label>
              <select
                value={level.action}
                onChange={(e) => updateLevel(index, 'action', e.target.value)}
                className="w-full px-3 py-2 border border-gray-200 dark:border-gray-700 rounded-lg text-sm focus:outline-hidden focus:ring-2 focus:ring-info-500"
              >
                {ACTION_OPTIONS.map((a) => (
                  <option key={a.value} value={a.value}>
                    {a.label}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {/* Notify User IDs */}
          <Input
            label="Bildirilecek Kullanicilar (virgul ile)"
            fullWidth
            type="text"
            value={level.notifyUserIds.join(', ')}
            onChange={(e) =>
              updateLevel(
                index,
                'notifyUserIds',
                e.target.value
                  .split(',')
                  .map((s) => s.trim())
                  .filter(Boolean),
              )
            }
            placeholder="Kullanici ID'leri"
          />

          {/* Channels */}
          <div>
            <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">
              Bildirim Kanallari
            </label>
            <div className="flex flex-wrap gap-1.5">
              {CHANNEL_OPTIONS.map((ch) => (
                <ToggleButton
                  key={ch.value}
                  type="button"
                  onClick={() => toggleChannel(index, ch.value)}
                  pressed={level.channels.includes(ch.value)}
                  className="px-3 py-1 rounded-md text-xs font-medium border transition-colors"
                  pressedClassName="bg-info-50 dark:bg-info-900/20 text-info-700 dark:text-info-300 border-info-200 dark:border-info-800"
                  idleClassName="bg-white dark:bg-gray-900 text-gray-500 dark:text-gray-400 border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-800"
                >
                  {level.channels.includes(ch.value) && <Check className="w-3 h-3 inline mr-1" />}
                  {ch.label}
                </ToggleButton>
              ))}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
};

// ============================================================================
// Policy Form Component
// ============================================================================

const PolicyForm: React.FC<{
  mode: 'create' | 'edit';
  initialData?: PolicyFormData;
  onSubmit: (data: PolicyFormData) => void;
  onCancel: () => void;
  isPending: boolean;
}> = ({ mode, initialData, onSubmit, onCancel, isPending }) => {
  const [form, setForm] = useState<PolicyFormData>(initialData || { ...EMPTY_FORM });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.name.trim() || form.levels.length === 0 || form.severity.length === 0) return;
    onSubmit(form);
  };

  const updateField = <K extends keyof PolicyFormData>(field: K, value: PolicyFormData[K]) => {
    setForm((prev) => ({ ...prev, [field]: value }));
  };

  const toggleSeverity = (sev: AlertSeverity) => {
    setForm((prev) => ({
      ...prev,
      severity: prev.severity.includes(sev)
        ? prev.severity.filter((s) => s !== sev)
        : [...prev.severity, sev],
    }));
  };

  return (
    <div className="bg-white dark:bg-gray-900 rounded-xl shadow-sm border border-gray-100 dark:border-gray-700 p-6">
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
          {mode === 'create' ? 'Yeni Eskalasyon Politikasi' : 'Politikayi Düzenle'}
        </h2>
        <Button variant="ghost" iconOnly aria-label="Close" onClick={onCancel}>
          <X className="w-5 h-5" />
        </Button>
      </div>

      <form onSubmit={handleSubmit} className="space-y-5">
        {/* Name & Description */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              Politika Adi <span className="text-error-500">*</span>
            </label>
            <Input
              fullWidth
              type="text"
              value={form.name}
              onChange={(e) => updateField('name', e.target.value)}
              placeholder="Ornegin: Kritik Alarm Eskalasyonu"
              maxLength={200}
              required
            />
          </div>
          <Input
            label="Açıklama"
            fullWidth
            type="text"
            value={form.description}
            onChange={(e) => updateField('description', e.target.value)}
            placeholder="Politikanin kisa aciklamasi"
            maxLength={1000}
          />
        </div>

        {/* Severity Selection */}
        <div>
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
            Onem Seviyeleri <span className="text-error-500">*</span>
          </label>
          <div className="flex flex-wrap gap-2">
            {SEVERITY_OPTIONS.map((sev) => (
              <ToggleButton
                key={sev.value}
                type="button"
                onClick={() => toggleSeverity(sev.value)}
                pressed={form.severity.includes(sev.value)}
                className="px-4 py-2 rounded-lg text-sm font-medium border transition-colors"
                pressedClassName={sev.className}
                idleClassName="bg-white dark:bg-gray-900 text-gray-500 dark:text-gray-400 border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-800"
              >
                {form.severity.includes(sev.value) && <Check className="w-3.5 h-3.5 inline mr-1" />}
                {sev.label}
              </ToggleButton>
            ))}
          </div>
        </div>

        {/* Escalation Levels */}
        <LevelEditor levels={form.levels} onChange={(levels) => updateField('levels', levels)} />

        {/* Configuration Row */}
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          <Input
            label="Tekrar Araligi (dk)"
            fullWidth
            type="number"
            min={1}
            value={form.repeatIntervalMinutes}
            onChange={(e) =>
              updateField('repeatIntervalMinutes', parseInt(e.target.value, 10) || 5)
            }
          />
          <Input
            label="Maks Tekrar"
            fullWidth
            type="number"
            min={0}
            value={form.maxRepeats}
            onChange={(e) => updateField('maxRepeats', parseInt(e.target.value, 10) || 0)}
          />
          <Input
            label="Oncelik"
            fullWidth
            type="number"
            min={0}
            value={form.priority}
            onChange={(e) => updateField('priority', parseInt(e.target.value, 10) || 0)}
          />
          <Input
            label="Saat Dilimi"
            fullWidth
            type="text"
            value={form.timezone}
            onChange={(e) => updateField('timezone', e.target.value)}
            placeholder="Europe/Istanbul"
          />
        </div>

        {/* Default Policy Toggle */}
        <div className="flex items-center gap-3">
          <label className="relative inline-flex items-center cursor-pointer">
            <input
              type="checkbox"
              checked={form.isDefault}
              onChange={(e) => updateField('isDefault', e.target.checked)}
              className="sr-only peer"
            />
            <div className="w-9 h-5 bg-gray-200 dark:bg-gray-700 peer-focus:outline-hidden peer-focus:ring-2 peer-focus:ring-info-500 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-info-600" />
          </label>
          <span className="text-sm text-gray-700 dark:text-gray-300">
            Varsayilan politika olarak ayarla
          </span>
        </div>

        {/* Actions */}
        <div className="flex items-center justify-end gap-3 pt-4 border-t border-gray-100 dark:border-gray-700">
          <button
            type="button"
            onClick={onCancel}
            disabled={isPending}
            className="px-5 py-2 text-sm font-medium text-gray-700 dark:text-gray-300 bg-gray-100 dark:bg-gray-800 rounded-lg hover:bg-gray-200 dark:hover:bg-gray-600 transition-colors disabled:opacity-50"
          >
            İptal
          </button>
          <Button
            variant="primary"
            size="lg"
            type="submit"
            disabled={isPending || !form.name.trim() || form.severity.length === 0}
          >
            {isPending && <Spinner size="sm" color="inherit" />}
            {mode === 'create' ? 'Oluştur' : 'Kaydet'}
          </Button>
        </div>
      </form>
    </div>
  );
};

// ============================================================================
// Suppression Window Manager
// ============================================================================

const SuppressionWindowManager: React.FC<{
  policy: EscalationPolicy;
  onAdd: (input: SuppressionWindowInput) => void;
  onRemove: (windowId: string) => void;
  isAdding: boolean;
  isRemoving: boolean;
}> = ({ policy, onAdd, onRemove, isAdding, isRemoving }) => {
  const [showForm, setShowForm] = useState(false);
  const [windowForm, setWindowForm] = useState<SuppressionWindowInput>({
    name: '',
    startTime: '',
    endTime: '',
    reason: '',
    isRecurring: false,
    recurringPattern: '',
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!windowForm.name || !windowForm.startTime || !windowForm.endTime) return;
    onAdd(windowForm);
    setWindowForm({
      name: '',
      startTime: '',
      endTime: '',
      reason: '',
      isRecurring: false,
      recurringPattern: '',
    });
    setShowForm(false);
  };

  const windows = policy.suppressionWindows || [];
  const now = new Date();

  return (
    <div className="bg-white dark:bg-gray-900 rounded-xl shadow-sm border border-gray-100 dark:border-gray-700 p-5">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <PauseCircle className="w-5 h-5 text-warning-500" />
          <h3 className="font-semibold text-gray-900 dark:text-gray-100">Baskim Pencereleri</h3>
          <span className="text-xs text-gray-400 dark:text-gray-500">({windows.length})</span>
        </div>
        <Button
          variant="ghost"
          leftIcon={<Plus className="w-4 h-4" />}
          onClick={() => setShowForm(!showForm)}
        >
          Pencere Ekle
        </Button>
      </div>

      {/* Add Form */}
      {showForm && (
        <form
          onSubmit={handleSubmit}
          className="bg-gray-50 dark:bg-gray-800 rounded-lg p-4 mb-4 space-y-3"
        >
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <Input
              label="Ad"
              fullWidth
              type="text"
              value={windowForm.name}
              onChange={(e) => setWindowForm((f) => ({ ...f, name: e.target.value }))}
              placeholder="Ornegin: Planli Bakim"
              required
            />
            <Input
              label="Sebep"
              fullWidth
              type="text"
              value={windowForm.reason}
              onChange={(e) => setWindowForm((f) => ({ ...f, reason: e.target.value }))}
              placeholder="Opsiyonel"
            />
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <Input
              label="Baslangic"
              fullWidth
              type="datetime-local"
              value={windowForm.startTime}
              onChange={(e) =>
                setWindowForm((f) => ({
                  ...f,
                  startTime: e.target.value ? new Date(e.target.value).toISOString() : '',
                }))
              }
              required
            />
            <Input
              label="Bitis"
              fullWidth
              type="datetime-local"
              value={windowForm.endTime}
              onChange={(e) =>
                setWindowForm((f) => ({
                  ...f,
                  endTime: e.target.value ? new Date(e.target.value).toISOString() : '',
                }))
              }
              required
            />
          </div>
          <div className="flex items-center gap-3">
            <label className="relative inline-flex items-center cursor-pointer">
              <input
                type="checkbox"
                checked={windowForm.isRecurring}
                onChange={(e) => setWindowForm((f) => ({ ...f, isRecurring: e.target.checked }))}
                className="sr-only peer"
              />
              <div className="w-9 h-5 bg-gray-200 dark:bg-gray-700 peer-focus:outline-hidden peer-focus:ring-2 peer-focus:ring-info-500 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-info-600" />
            </label>
            <span className="text-sm text-gray-700 dark:text-gray-300">Tekrarlayan</span>
          </div>
          {windowForm.isRecurring && (
            <Input
              label="Cron Ifadesi"
              fullWidth
              type="text"
              value={windowForm.recurringPattern}
              onChange={(e) => setWindowForm((f) => ({ ...f, recurringPattern: e.target.value }))}
              placeholder="0 2 * * 0 (her pazar 02:00)"
            />
          )}
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setShowForm(false)}
              className="px-4 py-1.5 text-sm text-gray-600 dark:text-gray-400 bg-gray-100 dark:bg-gray-800 rounded-lg hover:bg-gray-200 dark:hover:bg-gray-600"
            >
              İptal
            </button>
            <Button variant="primary" size="sm" type="submit" disabled={isAdding}>
              {isAdding && <Spinner size="sm" color="inherit" />}
              Ekle
            </Button>
          </div>
        </form>
      )}

      {/* Windows List */}
      {windows.length === 0 ? (
        <p className="text-sm text-gray-400 dark:text-gray-500 text-center py-4">
          Tanimli baskim penceresi yok
        </p>
      ) : (
        <div className="space-y-2">
          {windows.map((w) => {
            const start = new Date(w.startTime);
            const end = new Date(w.endTime);
            const isActive = now >= start && now <= end;

            return (
              <div
                key={w.id}
                className={`flex items-center justify-between px-4 py-3 rounded-lg border ${
                  isActive
                    ? 'bg-warning-50 dark:bg-warning-900/20 border-warning-200 dark:border-warning-800'
                    : 'bg-gray-50 dark:bg-gray-800 border-gray-200 dark:border-gray-700'
                }`}
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-0.5">
                    <span className="font-medium text-sm text-gray-900 dark:text-gray-100">
                      {w.name}
                    </span>
                    {isActive && (
                      <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-warning-100 dark:bg-warning-900/40 text-warning-800 dark:text-warning-200">
                        Aktif
                      </span>
                    )}
                    {w.isRecurring && (
                      <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-accent-100 dark:bg-accent-900/40 text-accent-700 dark:text-accent-300">
                        Tekrarlayan
                      </span>
                    )}
                  </div>
                  <div className="text-xs text-gray-500 dark:text-gray-400">
                    {start.toLocaleString('tr-TR')} - {end.toLocaleString('tr-TR')}
                    {w.reason && <span className="ml-2">| {w.reason}</span>}
                  </div>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  iconOnly
                  aria-label="Delete"
                  onClick={() => onRemove(w.id)}
                  disabled={isRemoving}
                >
                  <Trash2 className="w-4 h-4" />
                </Button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};

// ============================================================================
// On-Call Schedule Display
// ============================================================================

const OnCallScheduleDisplay: React.FC<{ schedule?: OnCallSchedule[] }> = ({ schedule }) => {
  if (!schedule || schedule.length === 0) {
    return (
      <div className="text-sm text-gray-400 dark:text-gray-500 py-2">
        Nobetci takvimi tanimlanmamis
      </div>
    );
  }

  return (
    <div className="space-y-1.5">
      {schedule.map((entry, idx) => (
        <div
          key={idx}
          className="flex items-center gap-3 bg-gray-50 dark:bg-gray-800 rounded-lg px-3 py-2 text-sm"
        >
          <Calendar className="w-4 h-4 text-gray-400 dark:text-gray-500" />
          <span className="font-medium text-gray-700 dark:text-gray-300 w-24">
            {DAY_NAMES[entry.dayOfWeek]}
          </span>
          <Clock className="w-3.5 h-3.5 text-gray-400 dark:text-gray-500" />
          <span className="text-gray-600 dark:text-gray-400">
            {entry.startTime} - {entry.endTime}
          </span>
          <UserCheck className="w-3.5 h-3.5 text-gray-400 dark:text-gray-500 ml-2" />
          <span className="font-mono text-xs text-gray-600 dark:text-gray-400">
            {entry.userId.slice(0, 8)}...
          </span>
          {entry.backupUserId && (
            <>
              <Phone className="w-3.5 h-3.5 text-gray-400 dark:text-gray-500" />
              <span className="font-mono text-xs text-gray-500 dark:text-gray-400">
                {entry.backupUserId.slice(0, 8)}...
              </span>
            </>
          )}
        </div>
      ))}
    </div>
  );
};

// ============================================================================
// Delete Confirmation Dialog
// ============================================================================

const DeleteDialog: React.FC<{
  policyName: string;
  onConfirm: () => void;
  onCancel: () => void;
  isPending: boolean;
}> = ({ policyName, onConfirm, onCancel, isPending }) => {
  return (
    <ConfirmModal
      isOpen
      onClose={onCancel}
      onConfirm={onConfirm}
      title="Politikayi Sil"
      message={
        <>
          <strong>"{policyName}"</strong> eskalasyon politikasini silmek istediginizden emin
          misiniz? Bu islem geri alinamaz.
        </>
      }
      confirmText="Evet, Sil"
      cancelText="İptal"
      variant="danger"
      isLoading={isPending}
      loadingText="Siliniyor..."
    />
  );
};

// ============================================================================
// Clone Dialog
// ============================================================================

const CloneDialog: React.FC<{
  sourceName: string;
  onConfirm: (newName: string) => void;
  onCancel: () => void;
  isPending: boolean;
}> = ({ sourceName, onConfirm, onCancel, isPending }) => {
  const [newName, setNewName] = useState(`${sourceName} (Kopya)`);

  return (
    <Modal
      isOpen
      onClose={onCancel}
      size="sm"
      showCloseButton={!isPending}
      closeOnEscape={!isPending}
      closeOnOverlayClick={!isPending}
      title={
        <span className="flex items-center gap-3">
          <span className="flex items-center justify-center w-10 h-10 bg-info-100 dark:bg-info-900/40 rounded-full">
            <Copy className="w-5 h-5 text-info-600 dark:text-info-400" />
          </span>
          <span>Politikayi Kopyala</span>
        </span>
      }
      bodyClassName="p-6"
      footer={
        <>
          <button
            onClick={onCancel}
            disabled={isPending}
            className="px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-300 bg-gray-100 dark:bg-gray-800 rounded-lg hover:bg-gray-200 dark:hover:bg-gray-600 transition-colors disabled:opacity-50"
          >
            İptal
          </button>
          <Button
            variant="primary"
            onClick={() => onConfirm(newName)}
            disabled={isPending || !newName.trim()}
          >
            {isPending && <Spinner size="sm" color="inherit" />}
            Kopyala
          </Button>
        </>
      }
    >
      <p className="text-sm text-gray-500 dark:text-gray-400 mb-3">
        <strong>"{sourceName}"</strong> politikasinin kopyasi olusturulacak.
      </p>
      <Input
        label="Yeni Ad"
        className="mb-6"
        fullWidth
        type="text"
        value={newName}
        onChange={(e) => setNewName(e.target.value)}
      />
    </Modal>
  );
};

// ============================================================================
// Policy Card Component
// ============================================================================

const PolicyCard: React.FC<{
  policy: EscalationPolicy;
  onEdit: (policy: EscalationPolicy) => void;
  onDelete: (policy: EscalationPolicy) => void;
  onClone: (policy: EscalationPolicy) => void;
  onToggle: (policy: EscalationPolicy) => void;
  onManageSuppression: (policy: EscalationPolicy) => void;
  isToggling: boolean;
}> = ({ policy, onEdit, onDelete, onClone, onToggle, onManageSuppression, isToggling }) => {
  const [expanded, setExpanded] = useState(false);

  return (
    <div
      className={`bg-white dark:bg-gray-900 rounded-xl shadow-sm border border-gray-100 dark:border-gray-700 p-5 transition-all ${
        !policy.isActive ? 'opacity-60' : ''
      }`}
    >
      {/* Header */}
      <div className="flex items-start justify-between">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1 flex-wrap">
            <h3 className="font-semibold text-gray-900 dark:text-gray-100 truncate">
              {policy.name}
            </h3>
            {policy.isDefault && (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-primary-100 dark:bg-primary-900/40 text-primary-700 dark:text-primary-300 border border-primary-200 dark:border-primary-800">
                <Star className="w-3 h-3" />
                Varsayilan
              </span>
            )}
            <span
              className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${
                policy.isActive
                  ? 'bg-success-100 dark:bg-success-900/40 text-success-700 dark:text-success-300 border border-success-200 dark:border-success-800'
                  : 'bg-gray-100 dark:bg-gray-800 text-gray-500 dark:text-gray-400 border border-gray-200 dark:border-gray-700'
              }`}
            >
              {policy.isActive ? 'Aktif' : 'Pasif'}
            </span>
          </div>

          {policy.description && (
            <p className="text-sm text-gray-500 dark:text-gray-400 mb-2">{policy.description}</p>
          )}

          {/* Severity Badges + Summary */}
          <div className="flex items-center gap-2 flex-wrap mb-1">
            {policy.severity.map((sev) => (
              <SeverityBadge key={sev} severity={sev} />
            ))}
          </div>

          <div className="flex items-center gap-4 text-sm text-gray-500 dark:text-gray-400 flex-wrap mt-2">
            <span className="flex items-center gap-1">
              <Layers className="w-3.5 h-3.5" />
              {policy.levels.length} seviye
            </span>
            <span className="flex items-center gap-1">
              <Clock className="w-3.5 h-3.5" />
              Tekrar: {policy.repeatIntervalMinutes} dk
            </span>
            {policy.suppressionWindows && policy.suppressionWindows.length > 0 && (
              <span className="flex items-center gap-1">
                <PauseCircle className="w-3.5 h-3.5" />
                {policy.suppressionWindows.length} baskim penceresi
              </span>
            )}
            {policy.onCallSchedule && policy.onCallSchedule.length > 0 && (
              <span className="flex items-center gap-1">
                <UserCheck className="w-3.5 h-3.5" />
                {policy.onCallSchedule.length} nobetci kaydi
              </span>
            )}
            {policy.priority > 0 && (
              <span className="font-mono text-xs">Oncelik: {policy.priority}</span>
            )}
          </div>
        </div>

        {/* Actions */}
        <div className="flex items-center gap-1 ml-4 shrink-0">
          <ToggleButton
            onClick={() => onToggle(policy)}
            disabled={isToggling}
            title={policy.isActive ? 'Pasif yap' : 'Aktif yap'}
            pressed={policy.isActive}
            className="p-2 rounded-lg transition-colors disabled:opacity-50"
            pressedClassName="text-success-600 dark:text-success-400 hover:bg-success-50 dark:hover:bg-success-900/30"
            idleClassName="text-gray-400 dark:text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-700"
          >
            {isToggling ? (
              <Spinner size="sm" color="inherit" />
            ) : policy.isActive ? (
              <Bell className="w-4 h-4" />
            ) : (
              <BellOff className="w-4 h-4" />
            )}
          </ToggleButton>
          <Button
            variant="ghost"
            iconOnly
            aria-label="Baskim Pencereleri"
            onClick={() => onManageSuppression(policy)}
            title="Baskim Pencereleri"
          >
            <PauseCircle className="w-4 h-4" />
          </Button>
          <Button
            variant="ghost"
            iconOnly
            aria-label="Kopyala"
            onClick={() => onClone(policy)}
            title="Kopyala"
          >
            <Copy className="w-4 h-4" />
          </Button>
          <Button
            variant="ghost"
            iconOnly
            aria-label="Düzenle"
            onClick={() => onEdit(policy)}
            title="Düzenle"
          >
            <Edit3 className="w-4 h-4" />
          </Button>
          <Button
            variant="ghost"
            iconOnly
            aria-label="Sil"
            onClick={() => onDelete(policy)}
            title="Sil"
            disabled={policy.isDefault}
          >
            <Trash2 className="w-4 h-4" />
          </Button>
          <Button
            variant="ghost"
            onClick={() => setExpanded(!expanded)}
            title={expanded ? 'Daralt' : 'Genislet'}
          >
            {expanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
          </Button>
        </div>
      </div>

      {/* Expanded Detail */}
      {expanded && (
        <div className="mt-4 pt-4 border-t border-gray-100 dark:border-gray-700 space-y-4">
          {/* Escalation Chain */}
          <div>
            <h4 className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-2 flex items-center gap-2">
              <Layers className="w-4 h-4" />
              Eskalasyon Zinciri
            </h4>
            <div className="space-y-2">
              {policy.levels
                .slice()
                .sort((a, b) => a.level - b.level)
                .map((level) => (
                  <div
                    key={level.level}
                    className="flex items-start gap-3 bg-gray-50 dark:bg-gray-800 rounded-lg px-4 py-3"
                  >
                    <div className="flex items-center justify-center w-7 h-7 rounded-full bg-info-100 dark:bg-info-900/40 text-info-700 dark:text-info-300 text-sm font-bold shrink-0">
                      {level.level}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-medium text-sm text-gray-900 dark:text-gray-100">
                          {level.name}
                        </span>
                        <span className="text-xs text-gray-400 dark:text-gray-500">
                          {ACTION_OPTIONS.find((a) => a.value === level.action)?.label ||
                            level.action}
                        </span>
                      </div>
                      <div className="flex items-center gap-3 mt-1 text-xs text-gray-500 dark:text-gray-400 flex-wrap">
                        <span className="flex items-center gap-1">
                          <Clock className="w-3 h-3" />
                          {level.timeoutMinutes} dk sonra eskalasyon
                        </span>
                        <span>
                          Kanallar:{' '}
                          {level.channels
                            .map((c) => CHANNEL_OPTIONS.find((ch) => ch.value === c)?.label || c)
                            .join(', ')}
                        </span>
                        {level.notifyUserIds.length > 0 && (
                          <span>{level.notifyUserIds.length} kullanici</span>
                        )}
                      </div>
                    </div>
                  </div>
                ))}
            </div>
          </div>

          {/* On-Call Schedule */}
          {policy.onCallSchedule && policy.onCallSchedule.length > 0 && (
            <div>
              <h4 className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-2 flex items-center gap-2">
                <Phone className="w-4 h-4" />
                Nobetci Takvimi
              </h4>
              <OnCallScheduleDisplay schedule={policy.onCallSchedule} />
            </div>
          )}

          {/* Suppression Windows */}
          {policy.suppressionWindows && policy.suppressionWindows.length > 0 && (
            <div>
              <h4 className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-2 flex items-center gap-2">
                <PauseCircle className="w-4 h-4" />
                Baskim Pencereleri
              </h4>
              <div className="space-y-1.5">
                {policy.suppressionWindows.map((w) => {
                  const now = new Date();
                  const start = new Date(w.startTime);
                  const end = new Date(w.endTime);
                  const isActive = now >= start && now <= end;
                  return (
                    <div
                      key={w.id}
                      className={`flex items-center gap-2 rounded-lg px-3 py-2 text-sm ${
                        isActive
                          ? 'bg-warning-50 dark:bg-warning-900/20 border border-warning-200 dark:border-warning-800'
                          : 'bg-gray-50 dark:bg-gray-800'
                      }`}
                    >
                      <span className="font-medium text-gray-700 dark:text-gray-300">{w.name}</span>
                      {isActive && (
                        <span className="text-xs font-medium text-warning-700 dark:text-warning-300">
                          AKTIF
                        </span>
                      )}
                      <span className="text-xs text-gray-500 dark:text-gray-400">
                        {start.toLocaleString('tr-TR')} - {end.toLocaleString('tr-TR')}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Metadata */}
          <div className="text-xs text-gray-400 dark:text-gray-500 flex gap-4 flex-wrap">
            <span>Oluşturulma: {new Date(policy.createdAt).toLocaleString('tr-TR')}</span>
            <span>Güncelleme: {new Date(policy.updatedAt).toLocaleString('tr-TR')}</span>
            {policy.timezone && <span>Saat dilimi: {policy.timezone}</span>}
            {policy.ruleIds && policy.ruleIds.length > 0 && (
              <span>Kurallar: {policy.ruleIds.length}</span>
            )}
            {policy.farmIds && policy.farmIds.length > 0 && (
              <span>Farmlar: {policy.farmIds.length}</span>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

// ============================================================================
// Escalation Policies Page
// ============================================================================

const EscalationPoliciesPage: React.FC = () => {
  const { t } = useI18n();
  // Form state
  const [formMode, setFormMode] = useState<FormMode>('closed');
  const [editingPolicy, setEditingPolicy] = useState<EscalationPolicy | null>(null);

  // Dialogs
  const [deletingPolicy, setDeletingPolicy] = useState<EscalationPolicy | null>(null);
  const [cloningPolicy, setCloningPolicy] = useState<EscalationPolicy | null>(null);
  const [suppressionPolicy, setSuppressionPolicy] = useState<EscalationPolicy | null>(null);

  // Toggling
  const [togglingId, setTogglingId] = useState<string | null>(null);

  // Filter
  const [filterStatus, setFilterStatus] = useState<string>('all');

  // Hooks
  const { data: policies, isLoading, error, refetch } = useEscalationPolicies(false);
  const createMutation = useCreateEscalationPolicy();
  const updateMutation = useUpdateEscalationPolicy();
  const deleteMutation = useDeleteEscalationPolicy();
  const cloneMutation = useCloneEscalationPolicy();
  const toggleMutation = useToggleEscalationPolicy();
  const addSuppressionMutation = useAddSuppressionWindow();
  const removeSuppressionMutation = useRemoveSuppressionWindow();

  // Filtered policies
  const filteredPolicies = (policies || []).filter((p) => {
    if (filterStatus === 'active') return p.isActive;
    if (filterStatus === 'inactive') return !p.isActive;
    if (filterStatus === 'default') return p.isDefault;
    return true;
  });

  // Handlers
  const handleCreate = useCallback(
    async (formData: PolicyFormData) => {
      const input: CreateEscalationPolicyInput = {
        name: formData.name.trim(),
        description: formData.description.trim() || undefined,
        severity: formData.severity,
        levels: formData.levels,
        repeatIntervalMinutes: formData.repeatIntervalMinutes,
        maxRepeats: formData.maxRepeats,
        isDefault: formData.isDefault,
        priority: formData.priority,
        timezone: formData.timezone.trim() || undefined,
      };

      await createMutation.mutateAsync(input);
      setFormMode('closed');
    },
    [createMutation],
  );

  const handleUpdate = useCallback(
    async (formData: PolicyFormData) => {
      if (!editingPolicy) return;

      const input: UpdateEscalationPolicyInput = {
        policyId: editingPolicy.id,
        name: formData.name.trim(),
        description: formData.description.trim() || undefined,
        severity: formData.severity,
        levels: formData.levels,
        repeatIntervalMinutes: formData.repeatIntervalMinutes,
        maxRepeats: formData.maxRepeats,
        isDefault: formData.isDefault,
        priority: formData.priority,
        timezone: formData.timezone.trim() || undefined,
      };

      await updateMutation.mutateAsync(input);
      setFormMode('closed');
      setEditingPolicy(null);
    },
    [editingPolicy, updateMutation],
  );

  const handleEdit = useCallback((policy: EscalationPolicy) => {
    setEditingPolicy(policy);
    setFormMode('edit');
  }, []);

  const handleDelete = useCallback(async () => {
    if (!deletingPolicy) return;
    await deleteMutation.mutateAsync(deletingPolicy.id);
    setDeletingPolicy(null);
  }, [deletingPolicy, deleteMutation]);

  const handleClone = useCallback(
    async (newName: string) => {
      if (!cloningPolicy) return;
      await cloneMutation.mutateAsync({ policyId: cloningPolicy.id, newName: newName.trim() });
      setCloningPolicy(null);
    },
    [cloningPolicy, cloneMutation],
  );

  const handleToggle = useCallback(
    async (policy: EscalationPolicy) => {
      setTogglingId(policy.id);
      try {
        await toggleMutation.mutateAsync({ policyId: policy.id, isActive: !policy.isActive });
      } finally {
        setTogglingId(null);
      }
    },
    [toggleMutation],
  );

  const handleAddSuppression = useCallback(
    async (input: SuppressionWindowInput) => {
      if (!suppressionPolicy) return;
      const result = await addSuppressionMutation.mutateAsync({
        policyId: suppressionPolicy.id,
        window: input,
      });
      setSuppressionPolicy(result);
    },
    [suppressionPolicy, addSuppressionMutation],
  );

  const handleRemoveSuppression = useCallback(
    async (windowId: string) => {
      if (!suppressionPolicy) return;
      const result = await removeSuppressionMutation.mutateAsync({
        policyId: suppressionPolicy.id,
        windowId,
      });
      setSuppressionPolicy(result);
    },
    [suppressionPolicy, removeSuppressionMutation],
  );

  const policyToFormData = (policy: EscalationPolicy): PolicyFormData => ({
    name: policy.name,
    description: policy.description || '',
    severity: policy.severity,
    levels: policy.levels.length > 0 ? policy.levels : [{ ...EMPTY_LEVEL }],
    repeatIntervalMinutes: policy.repeatIntervalMinutes,
    maxRepeats: policy.maxRepeats,
    isDefault: policy.isDefault,
    priority: policy.priority,
    timezone: policy.timezone || '',
  });

  // Loading state
  if (isLoading && !policies) {
    return (
      <div className="p-6 flex items-center justify-center min-h-[400px]">
        <div className="text-center">
          <Spinner size="lg" block className="mb-3" />
          <p className="text-gray-500 dark:text-gray-400">Eskalasyon politikalari yükleniyor...</p>
        </div>
      </div>
    );
  }

  // Error state
  if (error && !policies) {
    return (
      <div className="p-6">
        <div className="bg-error-50 dark:bg-error-900/20 border border-error-100 dark:border-error-800 rounded-xl p-6 text-center">
          <XCircle className="w-10 h-10 text-error-400 mx-auto mb-3" />
          <h3 className="font-semibold text-error-900 dark:text-error-100 text-lg">
            Yukleme Hatasi
          </h3>
          <p className="text-sm text-error-600 dark:text-error-400 mt-1">
            {(error as Error).message}
          </p>
          <Button variant="danger" className="mt-4" onClick={() => refetch()}>
            Tekrar Dene
          </Button>
        </div>
      </div>
    );
  }

  const policyList = policies || [];

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <PageHeader
        title={
          <>
            <ShieldCheck className="w-7 h-7 text-info-600 dark:text-info-400" />
            Eskalasyon Politikalari
          </>
        }
        description={
          <>
            {policyList.length} politika tanimli
            {policyList.filter((p) => p.isActive).length > 0 && (
              <span className="text-success-600 dark:text-success-400 font-medium">
                {' '}
                ({policyList.filter((p) => p.isActive).length} aktif)
              </span>
            )}
            {policyList.find((p) => p.isDefault) && (
              <span className="text-primary-600 dark:text-primary-400 font-medium">
                {' '}
                | 1 varsayilan
              </span>
            )}
          </>
        }
        actions={
          <div className="flex items-center gap-2">
            <button
              onClick={() => refetch()}
              disabled={isLoading}
              className="flex items-center gap-2 px-4 py-2 bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300 rounded-lg hover:bg-gray-200 dark:hover:bg-gray-600 transition-colors"
            >
              <RefreshCw className={`w-4 h-4 ${isLoading ? 'animate-spin' : ''}`} />
              Yenile
            </button>
            <Button
              variant="primary"
              leftIcon={<Plus className="w-4 h-4" />}
              onClick={() => {
                setEditingPolicy(null);
                setFormMode('create');
              }}
            >
              Yeni Politika
            </Button>
          </div>
        }
      />

      {/* Filters */}
      <div className="bg-white dark:bg-gray-900 rounded-xl shadow-sm border border-gray-100 dark:border-gray-700 p-4">
        <div className="flex items-center gap-4">
          <span className="text-sm font-medium text-gray-700 dark:text-gray-300">Durum:</span>
          <div className="flex bg-gray-100 dark:bg-gray-800 rounded-lg p-1">
            {[
              { value: 'all', label: 'Tumu' },
              { value: 'active', label: 'Aktif' },
              { value: 'inactive', label: 'Pasif' },
              { value: 'default', label: 'Varsayilan' },
            ].map((tab) => (
              <ToggleButton
                key={tab.value}
                onClick={() => setFilterStatus(tab.value)}
                pressed={filterStatus === tab.value}
                className="px-4 py-1.5 text-sm font-medium rounded-md transition-colors"
                pressedClassName="bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100 shadow-sm"
                idleClassName="text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100"
              >
                {tab.label}
              </ToggleButton>
            ))}
          </div>
        </div>
      </div>

      {/* Error banners */}
      {error && policyList.length > 0 && (
        <div className="bg-error-50 dark:bg-error-900/20 border border-error-200 dark:border-error-800 rounded-lg p-3 flex items-center gap-2">
          <XCircle className="w-4 h-4 text-error-500 shrink-0" />
          <p className="text-sm text-error-700 dark:text-error-300">{(error as Error).message}</p>
          <Button variant="ghost" onClick={() => refetch()}>
            Tekrar Dene
          </Button>
        </div>
      )}

      {/* Mutation error banners */}
      {createMutation.error && (
        <div className="bg-error-50 dark:bg-error-900/20 border border-error-200 dark:border-error-800 rounded-lg p-3 flex items-center gap-2">
          <XCircle className="w-4 h-4 text-error-500 shrink-0" />
          <p className="text-sm text-error-700 dark:text-error-300">
            Oluşturma hatası: {(createMutation.error as Error).message}
          </p>
        </div>
      )}
      {updateMutation.error && (
        <div className="bg-error-50 dark:bg-error-900/20 border border-error-200 dark:border-error-800 rounded-lg p-3 flex items-center gap-2">
          <XCircle className="w-4 h-4 text-error-500 shrink-0" />
          <p className="text-sm text-error-700 dark:text-error-300">
            Güncelleme hatası: {(updateMutation.error as Error).message}
          </p>
        </div>
      )}
      {deleteMutation.error && (
        <div className="bg-error-50 dark:bg-error-900/20 border border-error-200 dark:border-error-800 rounded-lg p-3 flex items-center gap-2">
          <XCircle className="w-4 h-4 text-error-500 shrink-0" />
          <p className="text-sm text-error-700 dark:text-error-300">
            Silme hatası: {(deleteMutation.error as Error).message}
          </p>
        </div>
      )}
      {cloneMutation.error && (
        <div className="bg-error-50 dark:bg-error-900/20 border border-error-200 dark:border-error-800 rounded-lg p-3 flex items-center gap-2">
          <XCircle className="w-4 h-4 text-error-500 shrink-0" />
          <p className="text-sm text-error-700 dark:text-error-300">
            Kopyalama hatası: {(cloneMutation.error as Error).message}
          </p>
        </div>
      )}

      {/* Create/Edit Form */}
      {formMode === 'create' && (
        <PolicyForm
          mode="create"
          onSubmit={handleCreate}
          onCancel={() => setFormMode('closed')}
          isPending={createMutation.isPending}
        />
      )}
      {formMode === 'edit' && editingPolicy && (
        <PolicyForm
          mode="edit"
          initialData={policyToFormData(editingPolicy)}
          onSubmit={handleUpdate}
          onCancel={() => {
            setFormMode('closed');
            setEditingPolicy(null);
          }}
          isPending={updateMutation.isPending}
        />
      )}

      {/* Suppression Window Manager */}
      {suppressionPolicy && formMode === 'closed' && (
        <div className="relative">
          <button
            aria-label={t('common.close')}
            onClick={() => setSuppressionPolicy(null)}
            className="absolute -top-2 -right-2 z-10 p-1 bg-gray-100 dark:bg-gray-800 rounded-full text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-100 hover:bg-gray-200 dark:hover:bg-gray-600"
          >
            <X className="w-4 h-4" />
          </button>
          <SuppressionWindowManager
            policy={suppressionPolicy}
            onAdd={handleAddSuppression}
            onRemove={handleRemoveSuppression}
            isAdding={addSuppressionMutation.isPending}
            isRemoving={removeSuppressionMutation.isPending}
          />
        </div>
      )}

      {/* Empty State */}
      {filteredPolicies.length === 0 && !isLoading && formMode === 'closed' && (
        <div className="bg-white dark:bg-gray-900 rounded-xl shadow-sm border border-gray-100 dark:border-gray-700 p-12 text-center">
          <Shield className="w-12 h-12 text-gray-400 dark:text-gray-500 mx-auto mb-4" />
          <h3 className="text-lg font-medium text-gray-700 dark:text-gray-300 mb-2">
            Eskalasyon Politikasi Bulunamadi
          </h3>
          <p className="text-gray-500 dark:text-gray-400 text-sm mb-6">
            {filterStatus !== 'all'
              ? 'Seçili filtrelerle eşleşen politika bulunamadı. Filtreleri değiştirmeyi deneyin.'
              : 'Henuz tanimlanmis eskalasyon politikasi bulunmuyor. Ilk politikayi olusturun.'}
          </p>
          {filterStatus === 'all' && (
            <Button
              variant="primary"
              size="lg"
              leftIcon={<Plus className="w-4 h-4" />}
              onClick={() => setFormMode('create')}
            >
              Ilk Politikayi Oluştur
            </Button>
          )}
        </div>
      )}

      {/* Policy List */}
      <div className="space-y-4">
        {filteredPolicies.map((policy) => (
          <PolicyCard
            key={policy.id}
            policy={policy}
            onEdit={handleEdit}
            onDelete={setDeletingPolicy}
            onClone={setCloningPolicy}
            onToggle={handleToggle}
            onManageSuppression={setSuppressionPolicy}
            isToggling={togglingId === policy.id}
          />
        ))}
      </div>

      {/* Delete Confirmation Dialog */}
      {deletingPolicy && (
        <DeleteDialog
          policyName={deletingPolicy.name}
          onConfirm={handleDelete}
          onCancel={() => setDeletingPolicy(null)}
          isPending={deleteMutation.isPending}
        />
      )}

      {/* Clone Dialog */}
      {cloningPolicy && (
        <CloneDialog
          sourceName={cloningPolicy.name}
          onConfirm={handleClone}
          onCancel={() => setCloningPolicy(null)}
          isPending={cloneMutation.isPending}
        />
      )}
    </div>
  );
};

export default EscalationPoliciesPage;
