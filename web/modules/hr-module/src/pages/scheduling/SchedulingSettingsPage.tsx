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
  Tag,
  Trash2,
} from 'lucide-react';
import { cn, useAuth } from '@aquaculture/shared-ui';
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

// =====================
// Schedule Category System (localStorage-based)
// =====================

interface ScheduleCategory {
  code: string;
  name: string;
  color: string;
  textColor: string;
  isWorking: boolean;
  hours: number;
}

const DEFAULT_CATEGORIES: ScheduleCategory[] = [
  { code: 'D', name: 'Calisma', color: '#22C55E', textColor: '#FFFFFF', isWorking: true, hours: 9 },
  { code: 'X', name: 'Off', color: '#9CA3AF', textColor: '#FFFFFF', isWorking: false, hours: 0 },
  { code: 'P', name: 'Izin', color: '#3B82F6', textColor: '#FFFFFF', isWorking: false, hours: 0 },
  { code: 'OT', name: 'Fazla Mesai', color: '#F59E0B', textColor: '#FFFFFF', isWorking: true, hours: 4 },
  { code: 'E', name: 'Egitim', color: '#8B5CF6', textColor: '#FFFFFF', isWorking: true, hours: 8 },
  { code: 'H', name: 'Hastalik', color: '#EF4444', textColor: '#FFFFFF', isWorking: false, hours: 0 },
];

// SEC-007: categories storage key is built at runtime with tenant+user identity
// via makeCategoryStorageKey() — see WeeklySchedulePage for shared rationale.
function makeCategoryStorageKey(tenantId: string | null | undefined, userId: string | null | undefined): string {
  return `aqua-schedule-categories-${tenantId || 'anon'}-${userId || 'anon'}`;
}

const CATEGORY_COLORS = [
  '#22C55E', '#3B82F6', '#F59E0B', '#EF4444', '#8B5CF6',
  '#EC4899', '#06B6D4', '#84CC16', '#F97316', '#9CA3AF',
];

function loadCategories(tenantId?: string | null, userId?: string | null): ScheduleCategory[] {
  try {
    const stored = localStorage.getItem(makeCategoryStorageKey(tenantId, userId));
    if (stored) return JSON.parse(stored);
  } catch { /* ignore */ }
  return DEFAULT_CATEGORIES;
}

function saveCategories(cats: ScheduleCategory[], tenantId?: string | null, userId?: string | null) {
  localStorage.setItem(makeCategoryStorageKey(tenantId, userId), JSON.stringify(cats));
}

export function SchedulingSettingsPage() {
  // SEC-007: auth identity used to namespace localStorage category key
  const { user } = useAuth();
  const tenantId = user?.tenantId;
  const userId = user?.id;

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
    colorCode: '#3B82F6',
  });

  // Category management state — SEC-007: namespaced key
  const [categories, setCategories] = useState<ScheduleCategory[]>(() => loadCategories(tenantId, userId));
  const [showCategoryForm, setShowCategoryForm] = useState(false);
  const [editingCategoryCode, setEditingCategoryCode] = useState<string | null>(null);
  const [categoryForm, setCategoryForm] = useState({
    code: '',
    name: '',
    color: '#22C55E',
    isWorking: true,
    hours: 9,
  });

  const resetCategoryForm = () => {
    setCategoryForm({ code: '', name: '', color: '#22C55E', isWorking: true, hours: 9 });
    setEditingCategoryCode(null);
    setShowCategoryForm(false);
  };

  const handleSaveCategory = () => {
    if (!categoryForm.code.trim() || !categoryForm.name.trim()) return;

    const newCat: ScheduleCategory = {
      code: categoryForm.code.toUpperCase(),
      name: categoryForm.name,
      color: categoryForm.color,
      textColor: '#FFFFFF',
      isWorking: categoryForm.isWorking,
      hours: categoryForm.isWorking ? categoryForm.hours : 0,
    };

    let updated: ScheduleCategory[];
    if (editingCategoryCode) {
      updated = categories.map((c) => c.code === editingCategoryCode ? newCat : c);
    } else {
      if (categories.some((c) => c.code === newCat.code)) return; // duplicate
      updated = [...categories, newCat];
    }

    setCategories(updated);
    saveCategories(updated, tenantId, userId);
    resetCategoryForm();
  };

  const handleEditCategory = (cat: ScheduleCategory) => {
    setCategoryForm({
      code: cat.code,
      name: cat.name,
      color: cat.color,
      isWorking: cat.isWorking,
      hours: cat.hours,
    });
    setEditingCategoryCode(cat.code);
    setShowCategoryForm(true);
  };

  const handleDeleteCategory = (code: string) => {
    const updated = categories.filter((c) => c.code !== code);
    setCategories(updated);
    saveCategories(updated, tenantId, userId);
  };

  const handleResetCategories = () => {
    setCategories(DEFAULT_CATEGORIES);
    saveCategories(DEFAULT_CATEGORIES, tenantId, userId);
  };

  const SHIFT_COLORS = [
    '#3B82F6', '#10B981', '#F59E0B', '#8B5CF6', '#EF4444',
    '#EC4899', '#06B6D4', '#84CC16', '#F97316', '#6366F1',
  ];

  const resetShiftForm = () => {
    setShiftForm({ code: '', name: '', startTime: '08:00', endTime: '16:00', totalMinutes: 480, breakMinutes: 60, colorCode: '#3B82F6' });
    setEditingShiftId(null);
    setShowShiftForm(false);
  };

  const handleSaveShift = () => {
    if (!shiftForm.code.trim() || !shiftForm.name.trim()) return;
    if (editingShiftId) {
      updateShiftMutation.mutate(
        { id: editingShiftId, name: shiftForm.name, startTime: shiftForm.startTime, endTime: shiftForm.endTime, colorCode: shiftForm.colorCode },
        { onSuccess: resetShiftForm }
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
      colorCode: shift.colorCode || '#3B82F6',
    });
    setEditingShiftId(shift.id);
    setShowShiftForm(true);
  };

  const handleToggleShiftActive = (shift: Shift) => {
    updateShiftMutation.mutate(
      { id: shift.id, isActive: !shift.isActive } as { id: string } & Partial<CreateShiftInput>
    );
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

  const handleChange = (field: keyof UpdateSchedulingSettingsInput, value: UpdateSchedulingSettingsInput[keyof UpdateSchedulingSettingsInput]) => {
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
        {/* Schedule Categories Section */}
        <div className="bg-white rounded-xl shadow-sm overflow-hidden mb-6">
          <div className="px-6 py-4 border-b border-gray-200 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Tag className="h-5 w-5 text-indigo-600" />
              <h2 className="font-semibold text-gray-900">Cizelge Kategorileri</h2>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={handleResetCategories}
                className="text-xs text-gray-400 hover:text-gray-600 transition-colors"
                title="Varsayilanlara sifirla"
              >
                <RefreshCw className="h-3.5 w-3.5" />
              </button>
              {!showCategoryForm && (
                <button
                  onClick={() => { resetCategoryForm(); setShowCategoryForm(true); }}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-white bg-indigo-600 rounded-lg hover:bg-indigo-700 transition-colors"
                >
                  <Plus className="h-4 w-4" />
                  Yeni Kategori
                </button>
              )}
            </div>
          </div>

          <div className="p-6">
            <p className="text-xs text-gray-500 mb-4">
              Cizelge tablosunda hucrelere atanacak kategorileri yonetin. Calisma kategorileri gun ve saat hesabina dahil edilir.
            </p>

            {/* Category Form */}
            {showCategoryForm && (
              <div className="mb-6 p-4 bg-gray-50 rounded-lg border border-gray-200">
                <div className="flex items-center justify-between mb-4">
                  <h3 className="text-sm font-semibold text-gray-800">
                    {editingCategoryCode ? 'Kategori Duzenle' : 'Yeni Kategori Ekle'}
                  </h3>
                  <button onClick={resetCategoryForm} className="p-1 text-gray-400 hover:text-gray-600">
                    <X className="h-4 w-4" />
                  </button>
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1">Kod</label>
                    <input
                      type="text"
                      maxLength={4}
                      value={categoryForm.code}
                      onChange={(e) => setCategoryForm((p) => ({ ...p, code: e.target.value.toUpperCase() }))}
                      disabled={!!editingCategoryCode}
                      placeholder="D, X, P, OT..."
                      className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 disabled:bg-gray-100 disabled:text-gray-500"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1">Ad</label>
                    <input
                      type="text"
                      value={categoryForm.name}
                      onChange={(e) => setCategoryForm((p) => ({ ...p, name: e.target.value }))}
                      placeholder="Calisma, Off, Izin..."
                      className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1">Saat</label>
                    <input
                      type="number"
                      min={0}
                      max={24}
                      step={0.5}
                      value={categoryForm.hours}
                      onChange={(e) => setCategoryForm((p) => ({ ...p, hours: parseFloat(e.target.value) || 0 }))}
                      disabled={!categoryForm.isWorking}
                      className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 disabled:bg-gray-100"
                    />
                  </div>
                  <div className="flex items-center pt-5">
                    <input
                      type="checkbox"
                      id="catIsWorking"
                      checked={categoryForm.isWorking}
                      onChange={(e) => setCategoryForm((p) => ({ ...p, isWorking: e.target.checked, hours: e.target.checked ? p.hours || 9 : 0 }))}
                      className="h-4 w-4 text-indigo-600 border-gray-300 rounded focus:ring-indigo-500"
                    />
                    <label htmlFor="catIsWorking" className="ml-2 text-sm text-gray-700">
                      Calisma gunu sayilsin
                    </label>
                  </div>
                </div>
                {/* Color Picker */}
                <div className="mt-4">
                  <label className="block text-xs font-medium text-gray-600 mb-2">Renk</label>
                  <div className="flex gap-2 flex-wrap">
                    {CATEGORY_COLORS.map((color) => (
                      <button
                        key={color}
                        type="button"
                        onClick={() => setCategoryForm((p) => ({ ...p, color }))}
                        className={cn(
                          'w-7 h-7 rounded-full border-2 transition-all',
                          categoryForm.color === color ? 'border-gray-800 scale-110' : 'border-transparent hover:scale-105'
                        )}
                        style={{ backgroundColor: color }}
                      />
                    ))}
                  </div>
                </div>
                {/* Save */}
                <div className="mt-4 flex justify-end gap-2">
                  <button
                    type="button"
                    onClick={resetCategoryForm}
                    className="px-3 py-1.5 text-sm text-gray-600 bg-gray-100 rounded-lg hover:bg-gray-200 transition-colors"
                  >
                    Iptal
                  </button>
                  <button
                    type="button"
                    onClick={handleSaveCategory}
                    disabled={!categoryForm.code.trim() || !categoryForm.name.trim()}
                    className={cn(
                      'flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-white bg-indigo-600 rounded-lg',
                      'hover:bg-indigo-700 transition-colors disabled:opacity-50'
                    )}
                  >
                    <Save className="h-3.5 w-3.5" />
                    {editingCategoryCode ? 'Guncelle' : 'Kaydet'}
                  </button>
                </div>
              </div>
            )}

            {/* Category List */}
            {categories.length > 0 ? (
              <div className="space-y-2">
                {categories.map((cat) => (
                  <div
                    key={cat.code}
                    className="flex items-center gap-3 px-4 py-3 rounded-lg border border-gray-200 bg-white transition-colors"
                  >
                    <div
                      className="w-8 h-8 rounded-lg flex items-center justify-center text-xs font-bold flex-shrink-0"
                      style={{ backgroundColor: cat.color, color: cat.textColor }}
                    >
                      {cat.code}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-medium text-sm text-gray-900">{cat.name}</span>
                        {cat.isWorking ? (
                          <span className="px-1.5 py-0.5 text-[10px] font-medium bg-green-100 text-green-700 rounded">
                            Calisma - {cat.hours}h
                          </span>
                        ) : (
                          <span className="px-1.5 py-0.5 text-[10px] font-medium bg-gray-100 text-gray-500 rounded">
                            Calisma disi
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center gap-1">
                      <button
                        onClick={() => handleEditCategory(cat)}
                        className="p-1.5 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded transition-colors"
                        title="Duzenle"
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </button>
                      <button
                        onClick={() => handleDeleteCategory(cat.code)}
                        className="p-1.5 text-gray-400 hover:text-red-500 hover:bg-red-50 rounded transition-colors"
                        title="Sil"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-center py-8">
                <Tag className="h-10 w-10 text-gray-300 mx-auto mb-3" />
                <p className="text-sm text-gray-500 mb-3">Henuz kategori tanimlanmamis</p>
                <button
                  onClick={handleResetCategories}
                  className="text-sm text-indigo-600 hover:text-indigo-700 font-medium"
                >
                  Varsayilan kategorileri yukle
                </button>
              </div>
            )}
          </div>
        </div>

        {/* Shift Management Section */}
        <div className="bg-white rounded-xl shadow-sm overflow-hidden mb-6">
          <div className="px-6 py-4 border-b border-gray-200 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Layers className="h-5 w-5 text-indigo-600" />
              <h2 className="font-semibold text-gray-900">Vardiya Yonetimi</h2>
            </div>
            {!showShiftForm && (
              <button
                onClick={() => { resetShiftForm(); setShowShiftForm(true); }}
                className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-white bg-indigo-600 rounded-lg hover:bg-indigo-700 transition-colors"
              >
                <Plus className="h-4 w-4" />
                Yeni Vardiya
              </button>
            )}
          </div>

          <div className="p-6">
            {/* Shift Form */}
            {showShiftForm && (
              <div className="mb-6 p-4 bg-gray-50 rounded-lg border border-gray-200">
                <div className="flex items-center justify-between mb-4">
                  <h3 className="text-sm font-semibold text-gray-800">
                    {editingShiftId ? 'Vardiya Duzenle' : 'Yeni Vardiya Ekle'}
                  </h3>
                  <button onClick={resetShiftForm} className="p-1 text-gray-400 hover:text-gray-600">
                    <X className="h-4 w-4" />
                  </button>
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1">Kod</label>
                    <input
                      type="text"
                      maxLength={10}
                      value={shiftForm.code}
                      onChange={(e) => setShiftForm((p) => ({ ...p, code: e.target.value.toUpperCase() }))}
                      disabled={!!editingShiftId}
                      placeholder="S, A, G..."
                      className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 disabled:bg-gray-100 disabled:text-gray-500"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1">Ad</label>
                    <input
                      type="text"
                      value={shiftForm.name}
                      onChange={(e) => setShiftForm((p) => ({ ...p, name: e.target.value }))}
                      placeholder="Sabah, Aksam..."
                      className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1">Baslangic</label>
                    <input
                      type="time"
                      value={shiftForm.startTime}
                      onChange={(e) => setShiftForm((p) => ({ ...p, startTime: e.target.value }))}
                      className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1">Bitis</label>
                    <input
                      type="time"
                      value={shiftForm.endTime}
                      onChange={(e) => setShiftForm((p) => ({ ...p, endTime: e.target.value }))}
                      className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1">Toplam Dakika</label>
                    <input
                      type="number"
                      min={60}
                      max={1440}
                      step={30}
                      value={shiftForm.totalMinutes}
                      onChange={(e) => setShiftForm((p) => ({ ...p, totalMinutes: parseInt(e.target.value) || 480 }))}
                      className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1">Mola (dk)</label>
                    <input
                      type="number"
                      min={0}
                      max={240}
                      step={15}
                      value={shiftForm.breakMinutes}
                      onChange={(e) => setShiftForm((p) => ({ ...p, breakMinutes: parseInt(e.target.value) || 0 }))}
                      className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
                    />
                  </div>
                </div>
                {/* Color Picker */}
                <div className="mt-4">
                  <label className="block text-xs font-medium text-gray-600 mb-2">Renk</label>
                  <div className="flex gap-2 flex-wrap">
                    {SHIFT_COLORS.map((color) => (
                      <button
                        key={color}
                        type="button"
                        onClick={() => setShiftForm((p) => ({ ...p, colorCode: color }))}
                        className={cn(
                          'w-7 h-7 rounded-full border-2 transition-all',
                          shiftForm.colorCode === color ? 'border-gray-800 scale-110' : 'border-transparent hover:scale-105'
                        )}
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
                    className="px-3 py-1.5 text-sm text-gray-600 bg-gray-100 rounded-lg hover:bg-gray-200 transition-colors"
                  >
                    Iptal
                  </button>
                  <button
                    type="button"
                    onClick={handleSaveShift}
                    disabled={!shiftForm.code.trim() || !shiftForm.name.trim() || createShiftMutation.isPending || updateShiftMutation.isPending}
                    className={cn(
                      'flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-white bg-indigo-600 rounded-lg',
                      'hover:bg-indigo-700 transition-colors disabled:opacity-50'
                    )}
                  >
                    <Save className="h-3.5 w-3.5" />
                    {editingShiftId ? 'Guncelle' : 'Kaydet'}
                  </button>
                </div>
                {(createShiftMutation.error || updateShiftMutation.error) && (
                  <div className="mt-3 p-2 bg-red-50 border border-red-200 rounded text-xs text-red-600">
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
                      shift.isActive ? 'bg-white border-gray-200' : 'bg-gray-50 border-gray-100 opacity-60'
                    )}
                  >
                    <div
                      className="w-4 h-4 rounded-full flex-shrink-0"
                      style={{ backgroundColor: shift.colorCode || '#9CA3AF' }}
                    />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-semibold text-sm" style={{ color: shift.colorCode || '#374151' }}>
                          {shift.code}
                        </span>
                        <span className="text-sm text-gray-700">{shift.name}</span>
                      </div>
                      <div className="text-xs text-gray-500">
                        {shift.startTime?.substring(0, 5)} - {shift.endTime?.substring(0, 5)}
                        {(shift as Shift & { totalMinutes?: number }).totalMinutes && ` (${formatMinutesAsHours((shift as Shift & { totalMinutes?: number }).totalMinutes!)})`}
                      </div>
                    </div>
                    <div className="flex items-center gap-1">
                      <button
                        onClick={() => handleEditShift(shift)}
                        className="p-1.5 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded transition-colors"
                        title="Duzenle"
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </button>
                      <button
                        onClick={() => handleToggleShiftActive(shift)}
                        disabled={updateShiftMutation.isPending}
                        className={cn(
                          'px-2 py-1 text-xs rounded-full font-medium transition-colors',
                          shift.isActive
                            ? 'text-green-700 bg-green-100 hover:bg-green-200'
                            : 'text-gray-500 bg-gray-100 hover:bg-gray-200'
                        )}
                      >
                        {shift.isActive ? 'Aktif' : 'Pasif'}
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-center py-8">
                <Layers className="h-10 w-10 text-gray-300 mx-auto mb-3" />
                <p className="text-sm text-gray-500 mb-3">Henuz vardiya tanimlanmamis</p>
                <button
                  onClick={() => { resetShiftForm(); setShowShiftForm(true); }}
                  className="text-sm text-indigo-600 hover:text-indigo-700 font-medium"
                >
                  Ilk vardiyayi olustur
                </button>
              </div>
            )}
          </div>
        </div>

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
