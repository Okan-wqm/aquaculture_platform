/**
 * SchedulingSettingsPage
 * Tenant-level scheduling configuration
 */

import React, { useState, useEffect } from 'react';
import {
  Settings,
  Clock,
  AlertTriangle,
  Save,
  Bell,
  CalendarDays,
  Users,
  RefreshCw,
  Plus,
  Pencil,
  X,
  Layers,
} from 'lucide-react';
import {
  Button,
  cn,
  colors,
  Input,
  PageHeader,
  Select,
  ToggleButton,
  useI18n,
} from '@aquaculture/shared-ui';
import {
  useSchedulingSettings,
  useUpdateSchedulingSettings,
  formatMinutesAsHours,
} from '../../hooks/useScheduling';
import { useShifts, useCreateShift, useUpdateShift } from '../../hooks/useAttendance';
import type { Shift, CreateShiftInput, DayOfWeek } from '../../types/attendance.types';
import type { WeekDay, UpdateSchedulingSettingsInput } from '../../types/scheduling.types';

const WEEKDAY_OPTIONS: { value: WeekDay; label: string }[] = [
  { value: 'monday', label: 'Pazartesi' },
  { value: 'tuesday', label: 'Sali' },
  { value: 'wednesday', label: 'Carsamba' },
  { value: 'thursday', label: 'Persembe' },
  { value: 'friday', label: 'Cuma' },
  { value: 'saturday', label: 'Cumartesi' },
  { value: 'sunday', label: 'Pazar' },
];

export function SchedulingSettingsPage() {
  const { t } = useI18n();
  const { data: settings, isLoading, error } = useSchedulingSettings();
  const { data: shifts } = useShifts({ isActive: true });
  const updateMutation = useUpdateSchedulingSettings();
  const createShiftMutation = useCreateShift();
  const updateShiftMutation = useUpdateShift();

  const [formData, setFormData] = useState<UpdateSchedulingSettingsInput>({});
  const [hasChanges, setHasChanges] = useState(false);

  // Shift management state
  const [showShiftForm, setShowShiftForm] = useState(false);
  const [editingShiftId, setEditingShiftId] = useState<string | null>(null);
  const [shiftForm, setShiftForm] = useState({
    code: '',
    name: '',
    startTime: '08:00',
    endTime: '16:00',
    totalMinutes: 480,
    breakMinutes: 60,
    colorCode: colors.info[500],
  });

  const SHIFT_COLORS = [
    colors.info[500],
    colors.success[500],
    colors.warning[500],
    colors.primary[700],
    colors.error[500],
    colors.accent[500],
    colors.primary[400],
    colors.secondary[500],
    colors.accent[600],
    colors.primary[500],
  ];

  const resetShiftForm = () => {
    setShiftForm({
      code: '',
      name: '',
      startTime: '08:00',
      endTime: '16:00',
      totalMinutes: 480,
      breakMinutes: 60,
      colorCode: colors.info[500],
    });
    setEditingShiftId(null);
    setShowShiftForm(false);
  };

  const handleSaveShift = () => {
    if (!shiftForm.code.trim() || !shiftForm.name.trim()) return;
    if (editingShiftId) {
      updateShiftMutation.mutate(
        {
          id: editingShiftId,
          name: shiftForm.name,
          startTime: shiftForm.startTime,
          endTime: shiftForm.endTime,
          colorCode: shiftForm.colorCode,
        },
        { onSuccess: resetShiftForm },
      );
    } else {
      const createInput: CreateShiftInput = {
        code: shiftForm.code,
        name: shiftForm.name,
        startTime: shiftForm.startTime,
        endTime: shiftForm.endTime,
        graceMinutes: 15,
        colorCode: shiftForm.colorCode,
        workDays: [] as DayOfWeek[],
      };
      createShiftMutation.mutate(createInput, { onSuccess: resetShiftForm });
    }
  };

  const handleEditShift = (shift: Shift) => {
    setShiftForm({
      code: shift.code,
      name: shift.name,
      startTime: shift.startTime?.substring(0, 5) || '08:00',
      endTime: shift.endTime?.substring(0, 5) || '16:00',
      totalMinutes: 480,
      breakMinutes: 0,
      colorCode: shift.colorCode || colors.info[500],
    });
    setEditingShiftId(shift.id);
    setShowShiftForm(true);
  };

  const handleToggleShiftActive = (shift: Shift) => {
    updateShiftMutation.mutate({ id: shift.id, isActive: !shift.isActive } as {
      id: string;
    } & Partial<CreateShiftInput>);
  };

  // Initialize form when settings load
  useEffect(() => {
    if (settings) {
      setFormData({
        standardWeeklyMinutes: settings.standardWeeklyMinutes,
        maxOvertimeMinutesPerWeek: settings.maxOvertimeMinutesPerWeek,
        maxOvertimeMinutesPerMonth: settings.maxOvertimeMinutesPerMonth,
        defaultShiftId: settings.defaultShiftId,
        workWeekStartDay: settings.workWeekStartDay,
        autoNotifyEmployees: settings.autoNotifyEmployees,
        notifyDaysBefore: settings.notifyDaysBefore,
        maxConsecutiveWorkDays: settings.maxConsecutiveWorkDays,
        minRestMinutesBetweenShifts: settings.minRestMinutesBetweenShifts,
        allowOvertimeWithoutApproval: settings.allowOvertimeWithoutApproval,
      });
      setHasChanges(false);
    }
  }, [settings]);

  const handleChange = (
    field: keyof UpdateSchedulingSettingsInput,
    value: UpdateSchedulingSettingsInput[keyof UpdateSchedulingSettingsInput],
  ) => {
    setFormData((prev) => ({ ...prev, [field]: value }));
    setHasChanges(true);
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    updateMutation.mutate(formData, {
      onSuccess: () => {
        setHasChanges(false);
      },
    });
  };

  const handleReset = () => {
    if (settings) {
      setFormData({
        standardWeeklyMinutes: settings.standardWeeklyMinutes,
        maxOvertimeMinutesPerWeek: settings.maxOvertimeMinutesPerWeek,
        maxOvertimeMinutesPerMonth: settings.maxOvertimeMinutesPerMonth,
        defaultShiftId: settings.defaultShiftId,
        workWeekStartDay: settings.workWeekStartDay,
        autoNotifyEmployees: settings.autoNotifyEmployees,
        notifyDaysBefore: settings.notifyDaysBefore,
        maxConsecutiveWorkDays: settings.maxConsecutiveWorkDays,
        minRestMinutesBetweenShifts: settings.minRestMinutesBetweenShifts,
        allowOvertimeWithoutApproval: settings.allowOvertimeWithoutApproval,
      });
      setHasChanges(false);
    }
  };

  if (isLoading) {
    return (
      <div className="min-h-screen bg-gray-50 dark:bg-gray-800 p-6">
        <div className="max-w-3xl mx-auto">
          <div className="animate-pulse space-y-6">
            <div className="h-8 bg-gray-200 dark:bg-gray-700 rounded w-1/3" />
            <div className="bg-white dark:bg-gray-900 rounded-xl p-6 space-y-4">
              {[1, 2, 3, 4, 5].map((i) => (
                <div key={i} className="h-12 bg-gray-100 dark:bg-gray-800 rounded" />
              ))}
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen bg-gray-50 dark:bg-gray-800 p-6">
        <div className="max-w-3xl mx-auto">
          <div className="bg-error-50 dark:bg-error-900/20 rounded-xl p-6 text-center">
            <AlertTriangle className="h-12 w-12 text-error-400 mx-auto mb-4" />
            <h3 className="text-lg font-medium text-error-800 dark:text-error-200 mb-2">
              Ayarlar yuklenemedi
            </h3>
            <p className="text-error-600 dark:text-error-400">{String(error)}</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-800">
      {/* Header */}
      <div className="bg-white dark:bg-gray-900 border-b border-gray-200 dark:border-gray-700 px-6 py-4">
        <PageHeader
          title={
            <>
              <Settings className="h-6 w-6 text-primary-600 dark:text-primary-400" />
              Cizelge Ayarlari
            </>
          }
          description="Haftalik planlama yapilandirmasi"
          actions={
            <>
              {hasChanges && (
                <div className="flex items-center gap-2">
                  <button
                    onClick={handleReset}
                    className="px-4 py-2 text-gray-700 dark:text-gray-300 bg-gray-100 dark:bg-gray-800 rounded-lg hover:bg-gray-200 dark:hover:bg-gray-600 transition-colors"
                  >
                    Iptal
                  </button>
                  <button
                    onClick={handleSubmit}
                    disabled={updateMutation.isPending}
                    className={cn(
                      'flex items-center gap-2 px-4 py-2 text-white bg-primary-600 rounded-lg',
                      'hover:bg-primary-700 transition-colors',
                      'disabled:opacity-50',
                    )}
                  >
                    {updateMutation.isPending ? (
                      <RefreshCw className="h-4 w-4 animate-spin" />
                    ) : (
                      <Save className="h-4 w-4" />
                    )}
                    Kaydet
                  </button>
                </div>
              )}
            </>
          }
        />
      </div>

      {/* Content */}
      <div className="max-w-3xl mx-auto p-6">
        {/* Shift Management Section */}
        <div className="bg-white dark:bg-gray-900 rounded-xl shadow-sm overflow-hidden mb-6">
          <div className="px-6 py-4 border-b border-gray-200 dark:border-gray-700 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Layers className="h-5 w-5 text-primary-600 dark:text-primary-400" />
              <h2 className="font-semibold text-gray-900 dark:text-gray-100">Vardiya Yonetimi</h2>
            </div>
            {!showShiftForm && (
              <Button
                variant="primary"
                size="sm"
                leftIcon={<Plus className="h-4 w-4" />}
                onClick={() => {
                  resetShiftForm();
                  setShowShiftForm(true);
                }}
              >
                Yeni Vardiya
              </Button>
            )}
          </div>

          <div className="p-6">
            {/* Shift Form */}
            {showShiftForm && (
              <div className="mb-6 p-4 bg-gray-50 dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700">
                <div className="flex items-center justify-between mb-4">
                  <h3 className="text-sm font-semibold text-gray-800 dark:text-gray-200">
                    {editingShiftId ? 'Vardiya Duzenle' : 'Yeni Vardiya Ekle'}
                  </h3>
                  <Button
                    variant="ghost"
                    size="sm"
                    iconOnly
                    aria-label="Close"
                    onClick={resetShiftForm}
                  >
                    <X className="h-4 w-4" />
                  </Button>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <Input
                    label="Kod"
                    fullWidth
                    type="text"
                    maxLength={10}
                    value={shiftForm.code}
                    onChange={(e) =>
                      setShiftForm((p) => ({ ...p, code: e.target.value.toUpperCase() }))
                    }
                    disabled={!!editingShiftId}
                    placeholder="S, A, G..."
                  />
                  <Input
                    label="Ad"
                    fullWidth
                    type="text"
                    value={shiftForm.name}
                    onChange={(e) => setShiftForm((p) => ({ ...p, name: e.target.value }))}
                    placeholder="Sabah, Aksam..."
                  />
                  <Input
                    label="Baslangic"
                    fullWidth
                    type="time"
                    value={shiftForm.startTime}
                    onChange={(e) => setShiftForm((p) => ({ ...p, startTime: e.target.value }))}
                  />
                  <Input
                    label="Bitis"
                    fullWidth
                    type="time"
                    value={shiftForm.endTime}
                    onChange={(e) => setShiftForm((p) => ({ ...p, endTime: e.target.value }))}
                  />
                  <Input
                    label="Toplam Dakika"
                    fullWidth
                    type="number"
                    min={60}
                    max={1440}
                    step={30}
                    value={shiftForm.totalMinutes}
                    onChange={(e) =>
                      setShiftForm((p) => ({
                        ...p,
                        totalMinutes: parseInt(e.target.value) || 480,
                      }))
                    }
                  />
                  <Input
                    label="Mola (dk)"
                    fullWidth
                    type="number"
                    min={0}
                    max={240}
                    step={15}
                    value={shiftForm.breakMinutes}
                    onChange={(e) =>
                      setShiftForm((p) => ({ ...p, breakMinutes: parseInt(e.target.value) || 0 }))
                    }
                  />
                </div>
                {/* Color Picker */}
                <div className="mt-4">
                  <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-2">
                    Renk
                  </label>
                  <div className="flex gap-2 flex-wrap">
                    {SHIFT_COLORS.map((color) => (
                      <ToggleButton
                        aria-label={`${t('a11y.selectColour')} ${color}`}
                        key={color}
                        type="button"
                        onClick={() => setShiftForm((p) => ({ ...p, colorCode: color }))}
                        pressed={shiftForm.colorCode === color}
                        className="w-7 h-7 rounded-full border-2 transition-all"
                        pressedClassName="border-gray-800 scale-110"
                        idleClassName="border-transparent hover:scale-105"
                        style={{ backgroundColor: color }}
                      />
                    ))}
                  </div>
                </div>
                {/* Save */}
                <div className="mt-4 flex justify-end gap-2">
                  <button
                    type="button"
                    onClick={resetShiftForm}
                    className="px-3 py-1.5 text-sm text-gray-600 dark:text-gray-400 bg-gray-100 dark:bg-gray-800 rounded-lg hover:bg-gray-200 dark:hover:bg-gray-600 transition-colors"
                  >
                    Iptal
                  </button>
                  <button
                    type="button"
                    onClick={handleSaveShift}
                    disabled={
                      !shiftForm.code.trim() ||
                      !shiftForm.name.trim() ||
                      createShiftMutation.isPending ||
                      updateShiftMutation.isPending
                    }
                    className={cn(
                      'flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-white bg-primary-600 rounded-lg',
                      'hover:bg-primary-700 transition-colors disabled:opacity-50',
                    )}
                  >
                    <Save className="h-3.5 w-3.5" />
                    {editingShiftId ? 'Guncelle' : 'Kaydet'}
                  </button>
                </div>
                {(createShiftMutation.error || updateShiftMutation.error) && (
                  <div className="mt-3 p-2 bg-error-50 dark:bg-error-900/20 border border-error-200 dark:border-error-800 rounded text-xs text-error-600 dark:text-error-400">
                    {String(createShiftMutation.error || updateShiftMutation.error)}
                  </div>
                )}
              </div>
            )}

            {/* Shift List */}
            {shifts?.length ? (
              <div className="space-y-2">
                {shifts.map((shift) => (
                  <div
                    key={shift.id}
                    className={cn(
                      'flex items-center gap-3 px-4 py-3 rounded-lg border transition-colors',
                      shift.isActive
                        ? 'bg-white dark:bg-gray-900 border-gray-200 dark:border-gray-700'
                        : 'bg-gray-50 dark:bg-gray-800 border-gray-100 dark:border-gray-700 opacity-60',
                    )}
                  >
                    <div
                      className="w-4 h-4 rounded-full flex-shrink-0"
                      style={{ backgroundColor: shift.colorCode || colors.neutral[400] }}
                    />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span
                          className="font-semibold text-sm"
                          style={{ color: shift.colorCode || colors.neutral[700] }}
                        >
                          {shift.code}
                        </span>
                        <span className="text-sm text-gray-700 dark:text-gray-300">
                          {shift.name}
                        </span>
                      </div>
                      <div className="text-xs text-gray-500 dark:text-gray-400">
                        {shift.startTime?.substring(0, 5)} - {shift.endTime?.substring(0, 5)}
                        {(shift as Shift & { totalMinutes?: number }).totalMinutes &&
                          ` (${formatMinutesAsHours((shift as Shift & { totalMinutes?: number }).totalMinutes!)})`}
                      </div>
                    </div>
                    <div className="flex items-center gap-1">
                      <Button
                        variant="ghost"
                        size="sm"
                        iconOnly
                        aria-label="Duzenle"
                        onClick={() => handleEditShift(shift)}
                        title="Duzenle"
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </Button>
                      <ToggleButton
                        onClick={() => handleToggleShiftActive(shift)}
                        disabled={updateShiftMutation.isPending}
                        pressed={shift.isActive}
                        className="px-2 py-1 text-xs rounded-full font-medium transition-colors"
                        pressedClassName="text-success-700 dark:text-success-300 bg-success-100 dark:bg-success-900/40 hover:bg-success-200 dark:hover:bg-success-800/60"
                        idleClassName="text-gray-500 dark:text-gray-400 bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-600"
                      >
                        {shift.isActive ? 'Aktif' : 'Pasif'}
                      </ToggleButton>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-center py-8">
                <Layers className="h-10 w-10 text-gray-300 mx-auto mb-3" />
                <p className="text-sm text-gray-500 dark:text-gray-400 mb-3">
                  Henuz vardiya tanimlanmamis
                </p>
                <Button
                  variant="ghost"
                  onClick={() => {
                    resetShiftForm();
                    setShowShiftForm(true);
                  }}
                >
                  Ilk vardiyayi olustur
                </Button>
              </div>
            )}
          </div>
        </div>

        <form onSubmit={handleSubmit} className="space-y-6">
          {/* Work Hours Section */}
          <div className="bg-white dark:bg-gray-900 rounded-xl shadow-sm overflow-hidden">
            <div className="px-6 py-4 border-b border-gray-200 dark:border-gray-700 flex items-center gap-2">
              <Clock className="h-5 w-5 text-primary-600 dark:text-primary-400" />
              <h2 className="font-semibold text-gray-900 dark:text-gray-100">Calisma Saatleri</h2>
            </div>
            <div className="p-6 space-y-4">
              {/* Standard Weekly Hours */}
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                  Standart Haftalik Calisma Suresi
                </label>
                <div className="flex items-center gap-3">
                  <Input
                    type="number"
                    min="60"
                    max="3600"
                    step="30"
                    value={formData.standardWeeklyMinutes || 2700}
                    onChange={(e) =>
                      handleChange('standardWeeklyMinutes', parseInt(e.target.value))
                    }
                  />
                  <span className="text-sm text-gray-500 dark:text-gray-400">
                    dakika ({formatMinutesAsHours(formData.standardWeeklyMinutes || 2700)})
                  </span>
                </div>
                <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                  Ornek: 2700 dakika = 45 saat
                </p>
              </div>

              {/* Max Weekly Overtime */}
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                  Maksimum Haftalik Fazla Mesai
                </label>
                <div className="flex items-center gap-3">
                  <Input
                    type="number"
                    min="0"
                    max="3600"
                    step="30"
                    value={formData.maxOvertimeMinutesPerWeek || 900}
                    onChange={(e) =>
                      handleChange('maxOvertimeMinutesPerWeek', parseInt(e.target.value))
                    }
                  />
                  <span className="text-sm text-gray-500 dark:text-gray-400">
                    dakika ({formatMinutesAsHours(formData.maxOvertimeMinutesPerWeek || 900)})
                  </span>
                </div>
              </div>

              {/* Max Monthly Overtime */}
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                  Maksimum Aylik Fazla Mesai
                </label>
                <div className="flex items-center gap-3">
                  <Input
                    type="number"
                    min="0"
                    max="10800"
                    step="60"
                    value={formData.maxOvertimeMinutesPerMonth || 2700}
                    onChange={(e) =>
                      handleChange('maxOvertimeMinutesPerMonth', parseInt(e.target.value))
                    }
                  />
                  <span className="text-sm text-gray-500 dark:text-gray-400">
                    dakika ({formatMinutesAsHours(formData.maxOvertimeMinutesPerMonth || 2700)})
                  </span>
                </div>
              </div>

              {/* Min Rest Between Shifts */}
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                  Vardiyalar Arasi Minimum Dinlenme
                </label>
                <div className="flex items-center gap-3">
                  <Input
                    type="number"
                    min="0"
                    max="1440"
                    step="30"
                    value={formData.minRestMinutesBetweenShifts || 660}
                    onChange={(e) =>
                      handleChange('minRestMinutesBetweenShifts', parseInt(e.target.value))
                    }
                  />
                  <span className="text-sm text-gray-500 dark:text-gray-400">
                    dakika ({formatMinutesAsHours(formData.minRestMinutesBetweenShifts || 660)})
                  </span>
                </div>
              </div>
            </div>
          </div>

          {/* Schedule Settings Section */}
          <div className="bg-white dark:bg-gray-900 rounded-xl shadow-sm overflow-hidden">
            <div className="px-6 py-4 border-b border-gray-200 dark:border-gray-700 flex items-center gap-2">
              <CalendarDays className="h-5 w-5 text-primary-600 dark:text-primary-400" />
              <h2 className="font-semibold text-gray-900 dark:text-gray-100">Program Ayarlari</h2>
            </div>
            <div className="p-6 space-y-4">
              {/* Work Week Start Day */}
              <Select
                label="Hafta Baslangic Gunu"
                value={formData.workWeekStartDay || 'monday'}
                onChange={(e) => handleChange('workWeekStartDay', e.target.value as WeekDay)}
                options={WEEKDAY_OPTIONS.map((opt) => ({ value: opt.value, label: opt.label }))}
              />

              {/* Default Shift */}
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                  Varsayilan Vardiya
                </label>
                <Select
                  value={formData.defaultShiftId || ''}
                  onChange={(e) => handleChange('defaultShiftId', e.target.value || undefined)}
                  placeholder="Secilmedi"
                  options={(shifts ?? []).map((shift) => ({
                    value: shift.id,
                    label: `${shift.code} - ${shift.name} (${shift.startTime}-${shift.endTime})`,
                  }))}
                />
                <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                  Yeni plan olusturulurken kullanilacak varsayilan vardiya
                </p>
              </div>

              {/* Max Consecutive Work Days */}
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                  Maksimum Ardisik Calisma Gunu
                </label>
                <Input
                  type="number"
                  min="1"
                  max="14"
                  value={formData.maxConsecutiveWorkDays || 6}
                  onChange={(e) => handleChange('maxConsecutiveWorkDays', parseInt(e.target.value))}
                />
                <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                  Bu limite ulasinca uyari gosterilir
                </p>
              </div>

              {/* Allow Overtime Without Approval */}
              <div className="flex items-center gap-3">
                <input
                  type="checkbox"
                  id="allowOvertimeWithoutApproval"
                  checked={formData.allowOvertimeWithoutApproval || false}
                  onChange={(e) => handleChange('allowOvertimeWithoutApproval', e.target.checked)}
                  className="h-4 w-4 text-primary-600 border-gray-300 dark:border-gray-600 rounded focus:ring-primary-500"
                />
                <label
                  htmlFor="allowOvertimeWithoutApproval"
                  className="text-sm text-gray-700 dark:text-gray-300"
                >
                  Fazla mesai onay gerektirmesin
                </label>
              </div>
            </div>
          </div>

          {/* Notification Settings Section */}
          <div className="bg-white dark:bg-gray-900 rounded-xl shadow-sm overflow-hidden">
            <div className="px-6 py-4 border-b border-gray-200 dark:border-gray-700 flex items-center gap-2">
              <Bell className="h-5 w-5 text-primary-600 dark:text-primary-400" />
              <h2 className="font-semibold text-gray-900 dark:text-gray-100">Bildirim Ayarlari</h2>
            </div>
            <div className="p-6 space-y-4">
              {/* Auto Notify Employees */}
              <div className="flex items-center gap-3">
                <input
                  type="checkbox"
                  id="autoNotifyEmployees"
                  checked={formData.autoNotifyEmployees || false}
                  onChange={(e) => handleChange('autoNotifyEmployees', e.target.checked)}
                  className="h-4 w-4 text-primary-600 border-gray-300 dark:border-gray-600 rounded focus:ring-primary-500"
                />
                <label
                  htmlFor="autoNotifyEmployees"
                  className="text-sm text-gray-700 dark:text-gray-300"
                >
                  Plan yayinlaninca calisanlari otomatik bilgilendir
                </label>
              </div>

              {/* Notify Days Before */}
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                  Bildirim Zamani
                </label>
                <div className="flex items-center gap-2">
                  <span className="text-sm text-gray-500 dark:text-gray-400">Hafta baslamadan</span>
                  <Input
                    type="number"
                    min="0"
                    max="7"
                    value={formData.notifyDaysBefore || 2}
                    onChange={(e) => handleChange('notifyDaysBefore', parseInt(e.target.value))}
                  />
                  <span className="text-sm text-gray-500 dark:text-gray-400">gun once</span>
                </div>
              </div>
            </div>
          </div>

          {/* Save Button (mobile) */}
          {hasChanges && (
            <div className="flex justify-end gap-3 lg:hidden">
              <button
                type="button"
                onClick={handleReset}
                className="px-4 py-2 text-gray-700 dark:text-gray-300 bg-gray-100 dark:bg-gray-800 rounded-lg hover:bg-gray-200 dark:hover:bg-gray-600 transition-colors"
              >
                Iptal
              </button>
              <button
                type="submit"
                disabled={updateMutation.isPending}
                className={cn(
                  'flex items-center gap-2 px-4 py-2 text-white bg-primary-600 rounded-lg',
                  'hover:bg-primary-700 transition-colors',
                  'disabled:opacity-50',
                )}
              >
                {updateMutation.isPending ? (
                  <RefreshCw className="h-4 w-4 animate-spin" />
                ) : (
                  <Save className="h-4 w-4" />
                )}
                Kaydet
              </button>
            </div>
          )}
        </form>

        {/* Success/Error Messages */}
        {updateMutation.isSuccess && (
          <div className="mt-4 p-4 bg-success-50 dark:bg-success-900/20 border border-success-200 dark:border-success-800 rounded-lg text-success-700 dark:text-success-300">
            Ayarlar basariyla kaydedildi.
          </div>
        )}

        {updateMutation.error && (
          <div className="mt-4 p-4 bg-error-50 dark:bg-error-900/20 border border-error-200 dark:border-error-800 rounded-lg text-error-700 dark:text-error-300">
            Hata: {String(updateMutation.error)}
          </div>
        )}
      </div>
    </div>
  );
}

export default SchedulingSettingsPage;
