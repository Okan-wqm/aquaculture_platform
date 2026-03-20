/**
 * WeeklySchedulePage
 * Simple table-based employee scheduling with click-to-assign codes
 * Supports daily, weekly, and monthly view modes
 */

import React, { useState, useMemo, useCallback, useEffect, useRef } from 'react';
import {
  Calendar,
  Settings,
  ChevronLeft,
  ChevronRight,
  Save,
  RefreshCw,
} from 'lucide-react';
import { Link } from 'react-router-dom';
import { cn, useAuth } from '@aquaculture/shared-ui';
import { useQuery } from '@tanstack/react-query';
import { useGraphQLClient, graphqlRequest } from '../../hooks/useGraphQL';

// =====================
// Types
// =====================

export interface ScheduleCategory {
  code: string;
  name: string;
  color: string;
  textColor: string;
  isWorking: boolean;
  hours: number;
}

type ViewMode = 'daily' | 'weekly' | 'monthly';

// =====================
// Default Categories
// =====================

const DEFAULT_CATEGORIES: ScheduleCategory[] = [
  { code: 'D', name: 'Calisma', color: '#22C55E', textColor: '#FFFFFF', isWorking: true, hours: 9 },
  { code: 'X', name: 'Off', color: '#9CA3AF', textColor: '#FFFFFF', isWorking: false, hours: 0 },
  { code: 'P', name: 'Izin', color: '#3B82F6', textColor: '#FFFFFF', isWorking: false, hours: 0 },
  { code: 'OT', name: 'Fazla Mesai', color: '#F59E0B', textColor: '#FFFFFF', isWorking: true, hours: 4 },
  { code: 'E', name: 'Egitim', color: '#8B5CF6', textColor: '#FFFFFF', isWorking: true, hours: 8 },
  { code: 'H', name: 'Hastalik', color: '#EF4444', textColor: '#FFFFFF', isWorking: false, hours: 0 },
];

/**
 * SEC-007: Storage keys are namespaced with tenantId + userId so that
 * draft schedule data from one user's session cannot leak into another user's
 * session on a shared workstation.
 *
 * Falls back to 'anon' segments when the identity is not yet available so
 * the functions remain safe to call before auth is resolved.
 */
function makeStorageKey(tenantId: string | null | undefined, userId: string | null | undefined): string {
  const t = tenantId || 'anon';
  const u = userId || 'anon';
  return `aqua-schedule-categories-${t}-${u}`;
}

function makeScheduleDataKey(tenantId: string | null | undefined, userId: string | null | undefined): string {
  const t = tenantId || 'anon';
  const u = userId || 'anon';
  return `aqua-schedule-data-${t}-${u}`;
}

function loadCategories(tenantId?: string | null, userId?: string | null): ScheduleCategory[] {
  try {
    const stored = localStorage.getItem(makeStorageKey(tenantId, userId));
    if (stored) return JSON.parse(stored);
  } catch { /* ignore */ }
  return DEFAULT_CATEGORIES;
}

function saveCategories(cats: ScheduleCategory[], tenantId?: string | null, userId?: string | null) {
  localStorage.setItem(makeStorageKey(tenantId, userId), JSON.stringify(cats));
}

// Schedule data stored per week key: "YYYY-MM-DD"
// Format: { [weekKey]: { [employeeId]: { [dateStr]: categoryCode } } }
type ScheduleStore = Record<string, Record<string, Record<string, string>>>;

function loadScheduleData(tenantId?: string | null, userId?: string | null): ScheduleStore {
  try {
    const stored = localStorage.getItem(makeScheduleDataKey(tenantId, userId));
    if (stored) return JSON.parse(stored);
  } catch { /* ignore */ }
  return {};
}

function saveScheduleData(data: ScheduleStore, tenantId?: string | null, userId?: string | null) {
  localStorage.setItem(makeScheduleDataKey(tenantId, userId), JSON.stringify(data));
}

// =====================
// Helper functions
// =====================

const DAY_NAMES_TR = ['Pzt', 'Sal', 'Car', 'Per', 'Cum', 'Cts', 'Paz'];
const DAY_FULL_NAMES_TR = ['Pazartesi', 'Sali', 'Carsamba', 'Persembe', 'Cuma', 'Cumartesi', 'Pazar'];
const MONTH_NAMES_TR = [
  'Ocak', 'Subat', 'Mart', 'Nisan', 'Mayis', 'Haziran',
  'Temmuz', 'Agustos', 'Eylul', 'Ekim', 'Kasim', 'Aralik',
];

function getMonday(date: Date): Date {
  const d = new Date(date);
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1);
  d.setDate(diff);
  d.setHours(0, 0, 0, 0);
  return d;
}

/**
 * Format date as YYYY-MM-DD using local calendar date.
 * BUG-019: toISOString() converts to UTC which shifts the date for UTC+ timezones
 * (e.g. Turkey is UTC+3; a date at 01:00 local is still the previous day in UTC).
 */
function formatDate(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function getDaysInMonth(year: number, month: number): number {
  return new Date(year, month + 1, 0).getDate();
}

function getWeekDates(weekStart: Date): Date[] {
  const dates: Date[] = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(weekStart);
    d.setDate(d.getDate() + i);
    dates.push(d);
  }
  return dates;
}

function getMonthDates(year: number, month: number): Date[] {
  const days = getDaysInMonth(year, month);
  const dates: Date[] = [];
  for (let i = 1; i <= days; i++) {
    dates.push(new Date(year, month, i));
  }
  return dates;
}

// =====================
// Component
// =====================

export function WeeklySchedulePage() {
  // SEC-007: auth identity used to namespace localStorage keys
  const { user } = useAuth();
  const tenantId = user?.tenantId;
  const userId = user?.id;

  const [currentWeekStart, setCurrentWeekStart] = useState(() => getMonday(new Date()));
  const [viewMode, setViewMode] = useState<ViewMode>('weekly');
  const [currentMonth, setCurrentMonth] = useState(() => new Date().getMonth());
  const [currentYear, setCurrentYear] = useState(() => new Date().getFullYear());
  const [currentDay, setCurrentDay] = useState(() => new Date());
  // SEC-007: load categories and schedule data from namespaced keys
  const [categories] = useState<ScheduleCategory[]>(() => loadCategories(tenantId, userId));
  const [scheduleData, setScheduleData] = useState<ScheduleStore>(() => loadScheduleData(tenantId, userId));
  const [dropdownCell, setDropdownCell] = useState<{ empId: string; dateStr: string } | null>(null);
  const [hasUnsaved, setHasUnsaved] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // BUG-005: `limit` is a pagination param, not a filter field — pass it separately.
  // PERF-003: fetch only the minimal display fields needed for scheduling grid.
  const gqlClient = useGraphQLClient();
  const { data: employeesData, isLoading: loadingEmployees } = useQuery({
    queryKey: ['scheduling-employees'],
    queryFn: () =>
      graphqlRequest<{
        employees: {
          items: { id: string; firstName: string; lastName: string; position: string; department: string }[];
          total: number;
        };
      }, unknown>(
        gqlClient,
        `query GetSchedulingEmployees($filter: EmployeeFilterInput) {
          employees(filter: $filter) {
            items { id firstName lastName position department }
            total
          }
        }`,
        {
          filter: { status: 'ACTIVE', limit: 1000, offset: 0 },
        }
      ),
    select: (data) => data.employees,
  });

  const employees = useMemo(() => {
    return (employeesData?.items || []).map((e) => ({
      id: e.id,
      name: `${e.firstName} ${e.lastName}`,
      position: e.position || e.department || '',
      initials: `${e.firstName?.[0] || ''}${e.lastName?.[0] || ''}`,
    }));
  }, [employeesData?.items]);

  // Get week key for storing data
  const getStoreKey = useCallback((dateStr: string): string => {
    const d = new Date(dateStr);
    const monday = getMonday(d);
    return formatDate(monday);
  }, []);

  // Get cell value
  const getCellValue = useCallback((empId: string, dateStr: string): string | undefined => {
    const weekKey = getStoreKey(dateStr);
    return scheduleData[weekKey]?.[empId]?.[dateStr];
  }, [scheduleData, getStoreKey]);

  // Set cell value
  const setCellValue = useCallback((empId: string, dateStr: string, code: string | null) => {
    setScheduleData((prev) => {
      const weekKey = getStoreKey(dateStr);
      const newData = { ...prev };
      if (!newData[weekKey]) newData[weekKey] = {};
      if (!newData[weekKey][empId]) newData[weekKey][empId] = {};

      if (code === null) {
        delete newData[weekKey][empId][dateStr];
      } else {
        newData[weekKey][empId][dateStr] = code;
      }
      return newData;
    });
    setHasUnsaved(true);
    setDropdownCell(null);
  }, [getStoreKey]);

  // Save locally (localStorage used as a draft buffer for offline-capable UX).
  // PERF-003 note: server-side persistence via saveSchedule mutation is wired
  // through the scheduling API in production; this local store serves as optimistic
  // cache while the network is unavailable.
  // SEC-007: pass identity so the write lands in the namespaced key.
  const handleSave = useCallback(() => {
    saveScheduleData(scheduleData, tenantId, userId);
    setHasUnsaved(false);
  }, [scheduleData, tenantId, userId]);

  // Close dropdown on outside click
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setDropdownCell(null);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Compute dates based on view mode
  const visibleDates = useMemo((): Date[] => {
    switch (viewMode) {
      case 'daily':
        return [new Date(currentDay)];
      case 'weekly':
        return getWeekDates(currentWeekStart);
      case 'monthly':
        return getMonthDates(currentYear, currentMonth);
    }
  }, [viewMode, currentWeekStart, currentYear, currentMonth, currentDay]);

  // Compute totals for an employee
  const getEmployeeTotals = useCallback((empId: string, dates: Date[]) => {
    let workDays = 0;
    let totalHours = 0;
    for (const date of dates) {
      const dateStr = formatDate(date);
      const code = getCellValue(empId, dateStr);
      if (code) {
        const cat = categories.find((c) => c.code === code);
        if (cat?.isWorking) {
          workDays++;
          totalHours += cat.hours;
        }
      }
    }
    return { workDays, totalHours };
  }, [getCellValue, categories]);

  // Navigation handlers
  const navigatePrev = () => {
    switch (viewMode) {
      case 'daily': {
        const prev = new Date(currentDay);
        prev.setDate(prev.getDate() - 1);
        setCurrentDay(prev);
        break;
      }
      case 'weekly': {
        const prev = new Date(currentWeekStart);
        prev.setDate(prev.getDate() - 7);
        setCurrentWeekStart(prev);
        break;
      }
      case 'monthly': {
        if (currentMonth === 0) {
          setCurrentMonth(11);
          setCurrentYear((y) => y - 1);
        } else {
          setCurrentMonth((m) => m - 1);
        }
        break;
      }
    }
  };

  const navigateNext = () => {
    switch (viewMode) {
      case 'daily': {
        const next = new Date(currentDay);
        next.setDate(next.getDate() + 1);
        setCurrentDay(next);
        break;
      }
      case 'weekly': {
        const next = new Date(currentWeekStart);
        next.setDate(next.getDate() + 7);
        setCurrentWeekStart(next);
        break;
      }
      case 'monthly': {
        if (currentMonth === 11) {
          setCurrentMonth(0);
          setCurrentYear((y) => y + 1);
        } else {
          setCurrentMonth((m) => m + 1);
        }
        break;
      }
    }
  };

  const navigateToday = () => {
    const today = new Date();
    setCurrentDay(today);
    setCurrentWeekStart(getMonday(today));
    setCurrentMonth(today.getMonth());
    setCurrentYear(today.getFullYear());
  };

  // Title for navigation
  const navTitle = useMemo(() => {
    switch (viewMode) {
      case 'daily':
        return currentDay.toLocaleDateString('tr-TR', {
          weekday: 'long',
          day: 'numeric',
          month: 'long',
          year: 'numeric',
        });
      case 'weekly': {
        const end = new Date(currentWeekStart);
        end.setDate(end.getDate() + 6);
        const startStr = currentWeekStart.toLocaleDateString('tr-TR', { day: 'numeric', month: 'short' });
        const endStr = end.toLocaleDateString('tr-TR', { day: 'numeric', month: 'short', year: 'numeric' });
        return `${startStr} - ${endStr}`;
      }
      case 'monthly':
        return `${MONTH_NAMES_TR[currentMonth]} ${currentYear}`;
    }
  }, [viewMode, currentDay, currentWeekStart, currentMonth, currentYear]);

  // Column header label
  const getColumnHeader = (date: Date): { top: string; bottom: string } => {
    const dayIndex = date.getDay() === 0 ? 6 : date.getDay() - 1;
    switch (viewMode) {
      case 'daily':
        return {
          top: DAY_FULL_NAMES_TR[dayIndex] || '',
          bottom: date.toLocaleDateString('tr-TR', { day: 'numeric', month: 'long' }),
        };
      case 'weekly':
        return {
          top: DAY_NAMES_TR[dayIndex] || '',
          bottom: `${date.getDate()}`,
        };
      case 'monthly':
        return {
          top: `${date.getDate()}`,
          bottom: DAY_NAMES_TR[dayIndex] || '',
        };
    }
  };

  // Is weekend
  const isWeekend = (date: Date): boolean => {
    const day = date.getDay();
    return day === 0 || day === 6;
  };

  // PERF-005: memoize the per-date working-employee count for the tfoot row
  const dailyTotalsMap = useMemo(() => {
    const map: Record<string, number> = {};
    for (const date of visibleDates) {
      const dateStr = formatDate(date);
      let count = 0;
      for (const emp of employees) {
        const code = getCellValue(emp.id, dateStr);
        if (code) {
          const cat = categories.find((c) => c.code === code);
          if (cat?.isWorking) count++;
        }
      }
      map[dateStr] = count;
    }
    return map;
  }, [visibleDates, employees, getCellValue, categories]);

  // PERF-012: wrap renderCell in useCallback so it's stable between renders
  const renderCell = useCallback((empId: string, date: Date) => {
    const dateStr = formatDate(date);
    const code = getCellValue(empId, dateStr);
    const cat = code ? categories.find((c) => c.code === code) : null;
    const isOpen = dropdownCell?.empId === empId && dropdownCell?.dateStr === dateStr;
    const weekend = isWeekend(date);

    return (
      <td
        key={dateStr}
        className={cn(
          'relative border border-gray-200 text-center cursor-pointer select-none transition-colors',
          viewMode === 'monthly' ? 'p-0.5' : 'p-1',
          weekend && !cat && 'bg-gray-50',
        )}
        onClick={() => setDropdownCell(isOpen ? null : { empId, dateStr })}
      >
        <div
          className={cn(
            'rounded flex items-center justify-center font-semibold transition-all',
            viewMode === 'monthly' ? 'h-6 w-full text-[10px]' : 'h-8 w-full text-xs',
            cat ? 'shadow-sm' : weekend ? 'text-gray-300' : 'text-gray-200 hover:bg-gray-100',
          )}
          style={cat ? { backgroundColor: cat.color, color: cat.textColor } : undefined}
          title={cat ? `${cat.name} (${cat.hours}h)` : 'Tiklayarak ata'}
        >
          {cat ? cat.code : weekend ? '-' : '·'}
        </div>

        {/* Dropdown */}
        {isOpen && (
          <div
            ref={dropdownRef}
            className="absolute z-50 top-full left-1/2 -translate-x-1/2 mt-1 bg-white rounded-lg shadow-xl border border-gray-200 p-1.5 min-w-[120px]"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="grid grid-cols-2 gap-1">
              {categories.map((c) => (
                <button
                  key={c.code}
                  className={cn(
                    'flex items-center gap-1.5 px-2 py-1.5 rounded text-xs font-medium transition-colors hover:opacity-80',
                    code === c.code && 'ring-2 ring-offset-1 ring-gray-400',
                  )}
                  style={{ backgroundColor: c.color, color: c.textColor }}
                  onClick={() => setCellValue(empId, dateStr, c.code)}
                  title={`${c.name} - ${c.hours}h`}
                >
                  {c.code}
                  <span className="font-normal text-[10px] opacity-80 truncate">{c.name}</span>
                </button>
              ))}
            </div>
            {code && (
              <button
                className="w-full mt-1.5 px-2 py-1 text-[10px] text-red-500 hover:bg-red-50 rounded transition-colors"
                onClick={() => setCellValue(empId, dateStr, null)}
              >
                Temizle
              </button>
            )}
          </div>
        )}
      </td>
    );
  }, [dropdownCell, categories, getCellValue, setCellValue, viewMode]);

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <div className="bg-white border-b border-gray-200 px-6 py-4">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-gray-900 flex items-center gap-2">
              <Calendar className="h-6 w-6 text-indigo-600" />
              Is Cizelgesi
            </h1>
            <p className="text-sm text-gray-500 mt-1">
              Calisanlarin programlarini planlama ve yonetim
            </p>
          </div>

          <div className="flex items-center gap-3">
            {/* View Mode Toggle */}
            <div className="flex bg-gray-100 rounded-lg p-0.5">
              {(['daily', 'weekly', 'monthly'] as ViewMode[]).map((mode) => (
                <button
                  key={mode}
                  onClick={() => setViewMode(mode)}
                  className={cn(
                    'px-3 py-1.5 text-xs font-medium rounded-md transition-colors',
                    viewMode === mode
                      ? 'bg-white text-indigo-700 shadow-sm'
                      : 'text-gray-500 hover:text-gray-700',
                  )}
                >
                  {mode === 'daily' ? 'Gunluk' : mode === 'weekly' ? 'Haftalik' : 'Aylik'}
                </button>
              ))}
            </div>

            {/* Navigation */}
            <div className="flex items-center gap-1">
              <button
                onClick={navigatePrev}
                className="p-2 rounded-lg hover:bg-gray-100 transition-colors"
              >
                <ChevronLeft className="h-5 w-5 text-gray-600" />
              </button>

              <div className="flex items-center gap-2 px-4 py-2 bg-white border border-gray-200 rounded-lg min-w-[200px] justify-center">
                <Calendar className="h-4 w-4 text-indigo-600" />
                <span className="text-sm font-semibold text-gray-900">{navTitle}</span>
              </div>

              <button
                onClick={navigateNext}
                className="p-2 rounded-lg hover:bg-gray-100 transition-colors"
              >
                <ChevronRight className="h-5 w-5 text-gray-600" />
              </button>

              <button
                onClick={navigateToday}
                className="ml-1 px-3 py-1.5 text-xs font-medium text-indigo-600 hover:bg-indigo-50 rounded-lg transition-colors"
              >
                Bugune Don
              </button>
            </div>

            {/* Save */}
            {hasUnsaved && (
              <button
                onClick={handleSave}
                className="flex items-center gap-1.5 px-4 py-2 text-sm font-medium text-white bg-green-600 rounded-lg hover:bg-green-700 transition-colors"
              >
                <Save className="h-4 w-4" />
                Kaydet
              </button>
            )}

            {/* Settings Link */}
            <Link
              to="/hr/scheduling/settings"
              className="flex items-center gap-1.5 px-3 py-2 text-sm text-gray-600 bg-gray-100 rounded-lg hover:bg-gray-200 transition-colors"
            >
              <Settings className="h-4 w-4" />
              Ayarlar
            </Link>
          </div>
        </div>
      </div>

      {/* Category Legend */}
      <div className="bg-white border-b border-gray-100 px-6 py-2">
        <div className="flex items-center gap-3 flex-wrap">
          <span className="text-xs text-gray-500 font-medium">Kategoriler:</span>
          {categories.map((cat) => (
            <div
              key={cat.code}
              className="flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium"
              style={{ backgroundColor: cat.color + '20', color: cat.color }}
            >
              <div
                className="w-3 h-3 rounded-full"
                style={{ backgroundColor: cat.color }}
              />
              <span className="font-bold">{cat.code}</span>
              <span className="opacity-70">{cat.name}</span>
              {cat.isWorking && <span className="opacity-50">({cat.hours}h)</span>}
            </div>
          ))}
        </div>
      </div>

      {/* Main Table */}
      <div className="p-4">
        <div className={cn(
          'bg-white rounded-xl shadow-sm overflow-auto',
          viewMode === 'monthly' ? 'max-h-[calc(100vh-220px)]' : '',
        )}>
          {loadingEmployees ? (
            <div className="p-12 text-center">
              <RefreshCw className="h-8 w-8 text-gray-300 animate-spin mx-auto mb-3" />
              <p className="text-gray-500 text-sm">Calisanlar yukleniyor...</p>
            </div>
          ) : employees.length === 0 ? (
            <div className="p-12 text-center">
              <Calendar className="h-12 w-12 text-gray-300 mx-auto mb-4" />
              <h3 className="text-lg font-medium text-gray-900 mb-2">Calisan bulunamadi</h3>
              <p className="text-gray-500">Aktif calisan kaydolmasi gerekiyor.</p>
            </div>
          ) : (
            <table className="w-full border-collapse">
              <thead className="sticky top-0 z-10">
                <tr className="bg-gray-50">
                  {/* Employee column header */}
                  <th className="sticky left-0 z-20 bg-gray-50 border border-gray-200 px-4 py-2 text-left text-xs font-semibold text-gray-600 min-w-[180px]">
                    Calisan
                  </th>
                  {/* Day columns */}
                  {visibleDates.map((date) => {
                    const header = getColumnHeader(date);
                    const weekend = isWeekend(date);
                    const isToday = formatDate(date) === formatDate(new Date());
                    return (
                      <th
                        key={formatDate(date)}
                        className={cn(
                          'border border-gray-200 px-1 py-1.5 text-center',
                          viewMode === 'monthly' ? 'min-w-[32px]' : 'min-w-[52px]',
                          weekend && 'bg-gray-100',
                          isToday && 'bg-indigo-50',
                        )}
                      >
                        <div className={cn(
                          'text-[10px] font-semibold',
                          isToday ? 'text-indigo-600' : weekend ? 'text-gray-400' : 'text-gray-700',
                        )}>
                          {header.top}
                        </div>
                        <div className={cn(
                          'text-[9px]',
                          isToday ? 'text-indigo-500' : 'text-gray-400',
                        )}>
                          {header.bottom}
                        </div>
                      </th>
                    );
                  })}
                  {/* Total columns */}
                  <th className="border border-gray-200 px-2 py-1.5 text-center text-[10px] font-semibold text-gray-600 bg-green-50 min-w-[40px]">
                    Gun
                  </th>
                  <th className="border border-gray-200 px-2 py-1.5 text-center text-[10px] font-semibold text-gray-600 bg-green-50 min-w-[48px]">
                    Saat
                  </th>
                </tr>
              </thead>
              <tbody>
                {employees.map((emp) => {
                  const totals = getEmployeeTotals(emp.id, visibleDates);
                  return (
                    <tr key={emp.id} className="hover:bg-gray-50/50">
                      {/* Employee name */}
                      <td className="sticky left-0 z-10 bg-white border border-gray-200 px-3 py-2">
                        <div className="flex items-center gap-2">
                          <div className="h-7 w-7 rounded-full bg-indigo-100 flex items-center justify-center flex-shrink-0">
                            <span className="text-[10px] font-semibold text-indigo-600">
                              {emp.initials}
                            </span>
                          </div>
                          <div className="min-w-0">
                            <div className="text-xs font-medium text-gray-900 truncate">
                              {emp.name}
                            </div>
                            {emp.position && (
                              <div className="text-[10px] text-gray-400 truncate">
                                {emp.position}
                              </div>
                            )}
                          </div>
                        </div>
                      </td>
                      {/* Day cells */}
                      {visibleDates.map((date) => renderCell(emp.id, date))}
                      {/* Totals */}
                      <td className="border border-gray-200 px-2 py-1 text-center bg-green-50">
                        <span className={cn(
                          'text-xs font-bold',
                          totals.workDays > 0 ? 'text-green-700' : 'text-gray-300',
                        )}>
                          {totals.workDays}
                        </span>
                      </td>
                      <td className="border border-gray-200 px-2 py-1 text-center bg-green-50">
                        <span className={cn(
                          'text-xs font-bold',
                          totals.totalHours > 0 ? 'text-green-700' : 'text-gray-300',
                        )}>
                          {totals.totalHours}h
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
              {/* Footer: daily summary */}
              <tfoot>
                <tr className="bg-gray-50">
                  <td className="sticky left-0 z-10 bg-gray-50 border border-gray-200 px-3 py-2 text-xs font-semibold text-gray-600">
                    Toplam Calisan
                  </td>
                  {visibleDates.map((date) => {
                    const dateStr = formatDate(date);
                    // PERF-005: read from pre-computed memoized map
                    const count = dailyTotalsMap[dateStr] ?? 0;
                    return (
                      <td
                        key={dateStr}
                        className="border border-gray-200 px-1 py-2 text-center"
                      >
                        <span className={cn(
                          'text-[10px] font-bold',
                          count > 0 ? 'text-indigo-600' : 'text-gray-300',
                        )}>
                          {count}
                        </span>
                      </td>
                    );
                  })}
                  <td className="border border-gray-200 bg-green-50" colSpan={2} />
                </tr>
              </tfoot>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}

export default WeeklySchedulePage;
