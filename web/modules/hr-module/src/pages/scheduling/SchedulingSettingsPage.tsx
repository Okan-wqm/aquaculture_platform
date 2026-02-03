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
} from 'lucide-react';
import { cn } from '@aquaculture/shared-ui';
import {
  useSchedulingSettings,
  useUpdateSchedulingSettings,
  formatMinutesAsHours,
} from '../../hooks/useScheduling';
import { useShifts } from '../../hooks/useAttendance';
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
  const { data: settings, isLoading, error } = useSchedulingSettings();
  const { data: shifts } = useShifts({ isActive: true });
  const updateMutation = useUpdateSchedulingSettings();

  const [formData, setFormData] = useState<UpdateSchedulingSettingsInput>({});
  const [hasChanges, setHasChanges] = useState(false);

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

  const handleChange = (field: keyof UpdateSchedulingSettingsInput, value: any) => {
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
      <div className="min-h-screen bg-gray-50 p-6">
        <div className="max-w-3xl mx-auto">
          <div className="animate-pulse space-y-6">
            <div className="h-8 bg-gray-200 rounded w-1/3" />
            <div className="bg-white rounded-xl p-6 space-y-4">
              {[1, 2, 3, 4, 5].map((i) => (
                <div key={i} className="h-12 bg-gray-100 rounded" />
              ))}
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen bg-gray-50 p-6">
        <div className="max-w-3xl mx-auto">
          <div className="bg-red-50 rounded-xl p-6 text-center">
            <AlertTriangle className="h-12 w-12 text-red-400 mx-auto mb-4" />
            <h3 className="text-lg font-medium text-red-800 mb-2">
              Ayarlar yuklenemedi
            </h3>
            <p className="text-red-600">{String(error)}</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <div className="bg-white border-b border-gray-200 px-6 py-4">
        <div className="max-w-3xl mx-auto flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-gray-900 flex items-center gap-2">
              <Settings className="h-6 w-6 text-indigo-600" />
              Cizelge Ayarlari
            </h1>
            <p className="text-sm text-gray-500 mt-1">
              Haftalik planlama yapilandirmasi
            </p>
          </div>

          {hasChanges && (
            <div className="flex items-center gap-2">
              <button
                onClick={handleReset}
                className="px-4 py-2 text-gray-700 bg-gray-100 rounded-lg hover:bg-gray-200 transition-colors"
              >
                Iptal
              </button>
              <button
                onClick={handleSubmit}
                disabled={updateMutation.isPending}
                className={cn(
                  'flex items-center gap-2 px-4 py-2 text-white bg-indigo-600 rounded-lg',
                  'hover:bg-indigo-700 transition-colors',
                  'disabled:opacity-50'
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
        </div>
      </div>

      {/* Content */}
      <div className="max-w-3xl mx-auto p-6">
        <form onSubmit={handleSubmit} className="space-y-6">
          {/* Work Hours Section */}
          <div className="bg-white rounded-xl shadow-sm overflow-hidden">
            <div className="px-6 py-4 border-b border-gray-200 flex items-center gap-2">
              <Clock className="h-5 w-5 text-indigo-600" />
              <h2 className="font-semibold text-gray-900">Calisma Saatleri</h2>
            </div>
            <div className="p-6 space-y-4">
              {/* Standard Weekly Hours */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Standart Haftalik Calisma Suresi
                </label>
                <div className="flex items-center gap-3">
                  <input
                    type="number"
                    min="60"
                    max="3600"
                    step="30"
                    value={formData.standardWeeklyMinutes || 2700}
                    onChange={(e) =>
                      handleChange('standardWeeklyMinutes', parseInt(e.target.value))
                    }
                    className="w-32 px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
                  />
                  <span className="text-sm text-gray-500">
                    dakika ({formatMinutesAsHours(formData.standardWeeklyMinutes || 2700)})
                  </span>
                </div>
                <p className="mt-1 text-xs text-gray-500">
                  Ornek: 2700 dakika = 45 saat
                </p>
              </div>

              {/* Max Weekly Overtime */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Maksimum Haftalik Fazla Mesai
                </label>
                <div className="flex items-center gap-3">
                  <input
                    type="number"
                    min="0"
                    max="3600"
                    step="30"
                    value={formData.maxOvertimeMinutesPerWeek || 900}
                    onChange={(e) =>
                      handleChange('maxOvertimeMinutesPerWeek', parseInt(e.target.value))
                    }
                    className="w-32 px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
                  />
                  <span className="text-sm text-gray-500">
                    dakika ({formatMinutesAsHours(formData.maxOvertimeMinutesPerWeek || 900)})
                  </span>
                </div>
              </div>

              {/* Max Monthly Overtime */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Maksimum Aylik Fazla Mesai
                </label>
                <div className="flex items-center gap-3">
                  <input
                    type="number"
                    min="0"
                    max="10800"
                    step="60"
                    value={formData.maxOvertimeMinutesPerMonth || 2700}
                    onChange={(e) =>
                      handleChange('maxOvertimeMinutesPerMonth', parseInt(e.target.value))
                    }
                    className="w-32 px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
                  />
                  <span className="text-sm text-gray-500">
                    dakika ({formatMinutesAsHours(formData.maxOvertimeMinutesPerMonth || 2700)})
                  </span>
                </div>
              </div>

              {/* Min Rest Between Shifts */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Vardiyalar Arasi Minimum Dinlenme
                </label>
                <div className="flex items-center gap-3">
                  <input
                    type="number"
                    min="0"
                    max="1440"
                    step="30"
                    value={formData.minRestMinutesBetweenShifts || 660}
                    onChange={(e) =>
                      handleChange('minRestMinutesBetweenShifts', parseInt(e.target.value))
                    }
                    className="w-32 px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
                  />
                  <span className="text-sm text-gray-500">
                    dakika ({formatMinutesAsHours(formData.minRestMinutesBetweenShifts || 660)})
                  </span>
                </div>
              </div>
            </div>
          </div>

          {/* Schedule Settings Section */}
          <div className="bg-white rounded-xl shadow-sm overflow-hidden">
            <div className="px-6 py-4 border-b border-gray-200 flex items-center gap-2">
              <CalendarDays className="h-5 w-5 text-indigo-600" />
              <h2 className="font-semibold text-gray-900">Program Ayarlari</h2>
            </div>
            <div className="p-6 space-y-4">
              {/* Work Week Start Day */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Hafta Baslangic Gunu
                </label>
                <select
                  value={formData.workWeekStartDay || 'monday'}
                  onChange={(e) =>
                    handleChange('workWeekStartDay', e.target.value as WeekDay)
                  }
                  className="w-full max-w-xs px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
                >
                  {WEEKDAY_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              </div>

              {/* Default Shift */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Varsayilan Vardiya
                </label>
                <select
                  value={formData.defaultShiftId || ''}
                  onChange={(e) =>
                    handleChange('defaultShiftId', e.target.value || undefined)
                  }
                  className="w-full max-w-xs px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
                >
                  <option value="">Secilmedi</option>
                  {shifts?.map((shift) => (
                    <option key={shift.id} value={shift.id}>
                      {shift.code} - {shift.name} ({shift.startTime}-{shift.endTime})
                    </option>
                  ))}
                </select>
                <p className="mt-1 text-xs text-gray-500">
                  Yeni plan olusturulurken kullanilacak varsayilan vardiya
                </p>
              </div>

              {/* Max Consecutive Work Days */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Maksimum Ardisik Calisma Gunu
                </label>
                <input
                  type="number"
                  min="1"
                  max="14"
                  value={formData.maxConsecutiveWorkDays || 6}
                  onChange={(e) =>
                    handleChange('maxConsecutiveWorkDays', parseInt(e.target.value))
                  }
                  className="w-32 px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
                />
                <p className="mt-1 text-xs text-gray-500">
                  Bu limite ulasinca uyari gosterilir
                </p>
              </div>

              {/* Allow Overtime Without Approval */}
              <div className="flex items-center gap-3">
                <input
                  type="checkbox"
                  id="allowOvertimeWithoutApproval"
                  checked={formData.allowOvertimeWithoutApproval || false}
                  onChange={(e) =>
                    handleChange('allowOvertimeWithoutApproval', e.target.checked)
                  }
                  className="h-4 w-4 text-indigo-600 border-gray-300 rounded focus:ring-indigo-500"
                />
                <label
                  htmlFor="allowOvertimeWithoutApproval"
                  className="text-sm text-gray-700"
                >
                  Fazla mesai onay gerektirmesin
                </label>
              </div>
            </div>
          </div>

          {/* Notification Settings Section */}
          <div className="bg-white rounded-xl shadow-sm overflow-hidden">
            <div className="px-6 py-4 border-b border-gray-200 flex items-center gap-2">
              <Bell className="h-5 w-5 text-indigo-600" />
              <h2 className="font-semibold text-gray-900">Bildirim Ayarlari</h2>
            </div>
            <div className="p-6 space-y-4">
              {/* Auto Notify Employees */}
              <div className="flex items-center gap-3">
                <input
                  type="checkbox"
                  id="autoNotifyEmployees"
                  checked={formData.autoNotifyEmployees || false}
                  onChange={(e) =>
                    handleChange('autoNotifyEmployees', e.target.checked)
                  }
                  className="h-4 w-4 text-indigo-600 border-gray-300 rounded focus:ring-indigo-500"
                />
                <label
                  htmlFor="autoNotifyEmployees"
                  className="text-sm text-gray-700"
                >
                  Plan yayinlaninca calisanlari otomatik bilgilendir
                </label>
              </div>

              {/* Notify Days Before */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Bildirim Zamani
                </label>
                <div className="flex items-center gap-2">
                  <span className="text-sm text-gray-500">Hafta baslamadan</span>
                  <input
                    type="number"
                    min="0"
                    max="7"
                    value={formData.notifyDaysBefore || 2}
                    onChange={(e) =>
                      handleChange('notifyDaysBefore', parseInt(e.target.value))
                    }
                    className="w-20 px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
                  />
                  <span className="text-sm text-gray-500">gun once</span>
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
                className="px-4 py-2 text-gray-700 bg-gray-100 rounded-lg hover:bg-gray-200 transition-colors"
              >
                Iptal
              </button>
              <button
                type="submit"
                disabled={updateMutation.isPending}
                className={cn(
                  'flex items-center gap-2 px-4 py-2 text-white bg-indigo-600 rounded-lg',
                  'hover:bg-indigo-700 transition-colors',
                  'disabled:opacity-50'
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
          <div className="mt-4 p-4 bg-green-50 border border-green-200 rounded-lg text-green-700">
            Ayarlar basariyla kaydedildi.
          </div>
        )}

        {updateMutation.error && (
          <div className="mt-4 p-4 bg-red-50 border border-red-200 rounded-lg text-red-700">
            Hata: {String(updateMutation.error)}
          </div>
        )}
      </div>
    </div>
  );
}

export default SchedulingSettingsPage;
