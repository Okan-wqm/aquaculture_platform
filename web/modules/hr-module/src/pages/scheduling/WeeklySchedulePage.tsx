/**
 * WeeklySchedulePage
 *
 * The roster: every active employee against the visible days, each cell the
 * employee's weekly-plan entry from the scheduling API. Choosing a shift or
 * an off day in a cell saves it at once — the employee's plan for that week
 * is created first when there is none — and the refetched overview repaints
 * the cell. The daily, weekly and monthly views read the same per-week
 * overviews, so an assignment made in one view is what the others show.
 * Leave days come from approved leave requests and a published week is
 * read-only: both are the API's rules, and the cells only reflect them.
 */

import React, { useMemo, useState } from 'react';
import {
  Calendar,
  ChevronLeft,
  ChevronRight,
  Coffee,
  Lock,
  Send,
  Settings,
  Umbrella,
} from 'lucide-react';
import { Link } from 'react-router-dom';
import {
  Badge,
  Button,
  EmptyState,
  ErrorState,
  Menu,
  PageHeader,
  Spinner,
  cn,
  colors,
  useConfirm,
  type MenuItem,
} from '@aquaculture/shared-ui';

import { sanitizeColor } from '../../components/leave/LeaveBalanceWidget';
import { PrintScheduleButton } from '../../components/scheduling';
import { useShifts } from '../../hooks/useAttendance';
import {
  formatDateISO,
  formatMinutesAsHours,
  getWeekMonday,
  getWeekdayNameTR,
  getWeekdayShortTR,
  useAssignScheduleCell,
  usePublishWeekPlans,
  useTeamWeeklyOverviews,
} from '../../hooks/useScheduling';
import type { Shift } from '../../types/attendance.types';
import type {
  DayEntry,
  EmployeeWeekSummary,
  TeamWeeklyOverview,
  WeekDay,
} from '../../types/scheduling.types';

type ViewMode = 'daily' | 'weekly' | 'monthly';

const VIEW_MODES: readonly { mode: ViewMode; label: string }[] = [
  { mode: 'daily', label: 'Günlük' },
  { mode: 'weekly', label: 'Haftalık' },
  { mode: 'monthly', label: 'Aylık' },
];

const NO_SHIFTS: readonly Shift[] = [];

function weekdayOf(date: Date): WeekDay {
  switch (date.getDay()) {
    case 0:
      return 'sunday';
    case 1:
      return 'monday';
    case 2:
      return 'tuesday';
    case 3:
      return 'wednesday';
    case 4:
      return 'thursday';
    case 5:
      return 'friday';
    default:
      return 'saturday';
  }
}

function startOfDay(date: Date): Date {
  const day = new Date(date);
  day.setHours(0, 0, 0, 0);
  return day;
}

function addDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

/** Lands on the first of the target month so a 31st never rolls over into the month after. */
function addMonths(date: Date, months: number): Date {
  const next = new Date(date);
  next.setMonth(next.getMonth() + months, 1);
  return next;
}

function datesOfWeek(monday: Date): Date[] {
  return Array.from({ length: 7 }, (_, index) => addDays(monday, index));
}

function datesOfMonth(year: number, month: number): Date[] {
  const count = new Date(year, month + 1, 0).getDate();
  return Array.from({ length: count }, (_, index) => new Date(year, month, index + 1));
}

/** The ISO Mondays covering the given dates, in order and without repeats. */
function weekStartsOf(dates: readonly Date[]): string[] {
  const starts = new Set<string>();
  for (const date of dates) starts.add(formatDateISO(getWeekMonday(date)));
  return Array.from(starts);
}

function isWeekend(date: Date): boolean {
  return date.getDay() === 0 || date.getDay() === 6;
}

function isWorkingEntry(entry: DayEntry): boolean {
  return entry.entryType === 'work' || entry.entryType === 'training';
}

function timeRange(start: string, end: string): string {
  return `${start.slice(0, 5)}–${end.slice(0, 5)}`;
}

interface RosterEmployee {
  employeeId: string;
  employeeName: string;
  position: string | undefined;
}

interface RosterCell {
  weekStart: string;
  plan: EmployeeWeekSummary;
  entry: DayEntry;
}

const faceShell = 'flex w-full items-center justify-center gap-1 rounded font-semibold';

interface CellFaceProps {
  cell: RosterCell;
  shift: Shift | undefined;
  compact: boolean;
  saving: boolean;
}

/**
 * What a cell shows: the shift code in the shift's colour, an off day, a
 * leave day, a public holiday — or nothing while the week has no plan.
 */
function CellFace({ cell, shift, compact, saving }: CellFaceProps): React.JSX.Element {
  const size = compact ? 'h-6 text-xs' : 'h-8 text-xs';
  if (saving) {
    return (
      <span className={cn(faceShell, size, 'text-gray-400 dark:text-gray-500')}>
        <Spinner size="sm" color="inherit" />
      </span>
    );
  }
  if (cell.plan.weeklyPlanId === undefined) {
    return <span className={cn(faceShell, size, 'text-gray-300 dark:text-gray-600')}>·</span>;
  }
  switch (cell.entry.entryType) {
    case 'off':
      return (
        <span
          className={cn(
            faceShell,
            size,
            'bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400',
          )}
          title="Tatil"
        >
          <Coffee className="h-3.5 w-3.5" aria-hidden="true" />
          {!compact && 'Tatil'}
        </span>
      );
    case 'leave':
      return (
        <span
          className={cn(
            faceShell,
            size,
            'bg-success-100 text-success-700 dark:bg-success-900/40 dark:text-success-300',
          )}
          title="İzin (onaylı izin talebi)"
        >
          <Umbrella className="h-3.5 w-3.5" aria-hidden="true" />
          {!compact && 'İzin'}
        </span>
      );
    case 'holiday':
      return (
        <span
          className={cn(
            faceShell,
            size,
            'bg-accent-100 text-accent-700 dark:bg-accent-900/40 dark:text-accent-300',
          )}
          title="Resmi tatil"
        >
          {compact ? 'RT' : 'Resmi tatil'}
        </span>
      );
    case 'work':
    case 'training': {
      const title =
        shift === undefined
          ? (cell.entry.shiftName ?? 'Vardiya atanmadı')
          : `${shift.name} · ${timeRange(shift.startTime, shift.endTime)}`;
      return (
        <span
          className={cn(faceShell, size, 'text-white shadow-sm')}
          style={{
            backgroundColor: sanitizeColor(
              shift === undefined ? null : shift.colorCode,
              colors.info[500],
            ),
          }}
          title={title}
        >
          {cell.entry.shiftCode ?? '—'}
        </span>
      );
    }
  }
}

function ShiftOption({ shift }: { shift: Shift }): React.JSX.Element {
  return (
    <span className="flex items-center gap-2">
      <span
        className="h-3 w-3 flex-shrink-0 rounded-full"
        style={{ backgroundColor: sanitizeColor(shift.colorCode, colors.info[500]) }}
        aria-hidden="true"
      />
      <span className="font-semibold">{shift.code}</span>
      <span className="text-gray-500 dark:text-gray-400">
        {shift.name} · {timeRange(shift.startTime, shift.endTime)}
      </span>
    </span>
  );
}

export function WeeklySchedulePage(): React.JSX.Element {
  const confirm = useConfirm();
  const [viewMode, setViewMode] = useState<ViewMode>('weekly');
  const [anchor, setAnchor] = useState<Date>(() => startOfDay(new Date()));

  const visibleDates = useMemo((): Date[] => {
    switch (viewMode) {
      case 'daily':
        return [anchor];
      case 'weekly':
        return datesOfWeek(getWeekMonday(anchor));
      case 'monthly':
        return datesOfMonth(anchor.getFullYear(), anchor.getMonth());
    }
  }, [viewMode, anchor]);
  const weekStarts = useMemo(() => weekStartsOf(visibleDates), [visibleDates]);

  const overviews = useTeamWeeklyOverviews(weekStarts);
  const shiftsQuery = useShifts({ isActive: true });
  const shifts = shiftsQuery.data ?? NO_SHIFTS;
  const assign = useAssignScheduleCell();
  const publish = usePublishWeekPlans();

  const overviewByWeek = useMemo(() => {
    const byWeek = new Map<string, TeamWeeklyOverview>();
    overviews.forEach((result, index) => {
      const weekStart = weekStarts[index];
      if (weekStart !== undefined && result.data !== undefined) byWeek.set(weekStart, result.data);
    });
    return byWeek;
  }, [overviews, weekStarts]);

  const plansByWeek = useMemo(() => {
    const index = new Map<string, Map<string, EmployeeWeekSummary>>();
    for (const [weekStart, overview] of overviewByWeek) {
      index.set(weekStart, new Map(overview.employeePlans.map((plan) => [plan.employeeId, plan])));
    }
    return index;
  }, [overviewByWeek]);

  const employees = useMemo((): RosterEmployee[] => {
    const seen = new Map<string, RosterEmployee>();
    for (const overview of overviewByWeek.values()) {
      for (const plan of overview.employeePlans) {
        if (!seen.has(plan.employeeId)) {
          seen.set(plan.employeeId, {
            employeeId: plan.employeeId,
            employeeName: plan.employeeName,
            position: plan.position,
          });
        }
      }
    }
    return Array.from(seen.values());
  }, [overviewByWeek]);

  const shiftByCode = useMemo(
    () => new Map(shifts.map((shift) => [shift.code, shift] as const)),
    [shifts],
  );

  const planOf = (weekStart: string, employeeId: string): EmployeeWeekSummary | undefined => {
    const weekPlans = plansByWeek.get(weekStart);
    return weekPlans === undefined ? undefined : weekPlans.get(employeeId);
  };

  const cellOf = (employeeId: string, date: Date): RosterCell | undefined => {
    const weekStart = formatDateISO(getWeekMonday(date));
    const plan = planOf(weekStart, employeeId);
    if (plan === undefined) return undefined;
    const weekday = weekdayOf(date);
    const entry = plan.days.find((day) => day.dayOfWeek === weekday);
    return entry === undefined ? undefined : { weekStart, plan, entry };
  };

  const employeeTotals = (employeeId: string): { workDays: number; minutes: number } => {
    let workDays = 0;
    let minutes = 0;
    for (const date of visibleDates) {
      const cell = cellOf(employeeId, date);
      if (cell !== undefined && isWorkingEntry(cell.entry)) {
        workDays += 1;
        minutes += cell.entry.plannedMinutes;
      }
    }
    return { workDays, minutes };
  };

  const workingCountOn = (date: Date): number =>
    employees.reduce((count, employee) => {
      const cell = cellOf(employee.employeeId, date);
      return cell !== undefined && isWorkingEntry(cell.entry) ? count + 1 : count;
    }, 0);

  const navigate = (direction: -1 | 1): void => {
    setAnchor((current) => {
      switch (viewMode) {
        case 'daily':
          return addDays(current, direction);
        case 'weekly':
          return addDays(current, 7 * direction);
        case 'monthly':
          return addMonths(current, direction);
      }
    });
  };

  const navTitle = useMemo((): string => {
    switch (viewMode) {
      case 'daily':
        return anchor.toLocaleDateString('tr-TR', {
          weekday: 'long',
          day: 'numeric',
          month: 'long',
          year: 'numeric',
        });
      case 'weekly': {
        const monday = getWeekMonday(anchor);
        const start = monday.toLocaleDateString('tr-TR', { day: 'numeric', month: 'short' });
        const end = addDays(monday, 6).toLocaleDateString('tr-TR', {
          day: 'numeric',
          month: 'short',
          year: 'numeric',
        });
        return `${start} – ${end}`;
      }
      case 'monthly':
        return anchor.toLocaleDateString('tr-TR', { month: 'long', year: 'numeric' });
    }
  }, [viewMode, anchor]);

  const columnHeader = (date: Date): { top: string; bottom: string } => {
    const weekday = weekdayOf(date);
    switch (viewMode) {
      case 'daily':
        return {
          top: getWeekdayNameTR(weekday),
          bottom: date.toLocaleDateString('tr-TR', { day: 'numeric', month: 'long' }),
        };
      case 'weekly':
        return { top: getWeekdayShortTR(weekday), bottom: String(date.getDate()) };
      case 'monthly':
        return { top: String(date.getDate()), bottom: getWeekdayShortTR(weekday) };
    }
  };

  const currentWeekStart = formatDateISO(getWeekMonday(anchor));
  const weekOverview = viewMode === 'weekly' ? overviewByWeek.get(currentWeekStart) : undefined;
  const draftPlanIds = useMemo(
    (): string[] =>
      weekOverview === undefined
        ? []
        : weekOverview.employeePlans.flatMap((plan) =>
            plan.weeklyPlanId !== undefined && plan.planStatus === 'draft'
              ? [plan.weeklyPlanId]
              : [],
          ),
    [weekOverview],
  );

  const publishWeek = async (): Promise<void> => {
    if (weekOverview === undefined || draftPlanIds.length === 0) return;
    const confirmed = await confirm({
      title: 'Haftayı yayınla',
      message: `${draftPlanIds.length} çalışanın taslak planı yayınlanacak. Yayınlanan planlar düzenlenemez.`,
      confirmText: 'Yayınla',
      cancelText: 'Vazgeç',
      variant: 'warning',
    });
    if (!confirmed) return;
    publish.mutate({ weekStartDate: weekOverview.weekStartDate, planIds: draftPlanIds });
  };

  const failed = overviews.find((result) => result.isError);
  const loading = failed === undefined && overviews.some((result) => result.data === undefined);
  const pending = assign.isPending ? assign.variables : undefined;
  const todayStr = formatDateISO(new Date());
  const compact = viewMode === 'monthly';

  const renderCell = (employee: RosterEmployee, date: Date): React.JSX.Element => {
    const dateStr = formatDateISO(date);
    const cell = cellOf(employee.employeeId, date);
    const tdClass = cn(
      'border border-gray-200 text-center dark:border-gray-700',
      compact ? 'p-0.5' : 'p-1',
      isWeekend(date) && 'bg-gray-50 dark:bg-gray-800',
    );
    if (cell === undefined) {
      return <td key={dateStr} className={tdClass} />;
    }

    const saving =
      pending !== undefined &&
      pending.employeeId === employee.employeeId &&
      pending.date === dateStr;
    const shift =
      cell.entry.shiftCode === undefined ? undefined : shiftByCode.get(cell.entry.shiftCode);
    const face = <CellFace cell={cell} shift={shift} compact={compact} saving={saving} />;
    const locked =
      cell.plan.planStatus === 'published' ||
      cell.entry.entryType === 'leave' ||
      cell.entry.entryType === 'holiday';
    if (locked) {
      return (
        <td key={dateStr} className={tdClass}>
          {face}
        </td>
      );
    }

    const assignCell = (shiftId: string | null): void => {
      assign.mutate({
        employeeId: employee.employeeId,
        weekStartDate: cell.weekStart,
        weeklyPlanId: cell.plan.weeklyPlanId,
        date: dateStr,
        shiftId,
      });
    };
    const items: MenuItem[] = [
      ...shifts.map(
        (option): MenuItem => ({
          id: option.id,
          label: <ShiftOption shift={option} />,
          onSelect: () => assignCell(option.id),
        }),
      ),
      {
        id: 'off',
        label: 'Tatil',
        icon: <Coffee className="h-4 w-4" aria-hidden="true" />,
        separator: shifts.length > 0,
        onSelect: () => assignCell(null),
      },
    ];
    const dateLabel = `${getWeekdayNameTR(weekdayOf(date))} ${date.toLocaleDateString('tr-TR', {
      day: 'numeric',
      month: 'long',
    })}`;

    return (
      <td key={dateStr} className={tdClass}>
        <Menu
          aria-label={`${employee.employeeName}, ${dateLabel}: vardiya seç`}
          items={items}
          align="start"
          panelClassName="w-64"
          className="w-full"
          trigger={(props) => (
            <button
              type="button"
              {...props}
              disabled={assign.isPending}
              className="block w-full rounded transition-colors hover:bg-gray-100 focus-visible:outline-2 focus-visible:outline-primary-500 disabled:cursor-wait dark:hover:bg-gray-700"
              title={`${employee.employeeName} · ${dateLabel}`}
            >
              {face}
            </button>
          )}
        />
      </td>
    );
  };

  const renderEmployeeRow = (employee: RosterEmployee): React.JSX.Element => {
    const totals = employeeTotals(employee.employeeId);
    const firstWeek = weekStarts[0];
    const rowPlan =
      compact || firstWeek === undefined ? undefined : planOf(firstWeek, employee.employeeId);
    const published = rowPlan !== undefined && rowPlan.planStatus === 'published';
    const initials = employee.employeeName
      .split(' ')
      .map((part) => part.charAt(0))
      .join('')
      .slice(0, 2)
      .toUpperCase();

    return (
      <tr key={employee.employeeId} className="hover:bg-gray-50/50 dark:hover:bg-gray-800/50">
        <th
          scope="row"
          className="sticky left-0 z-10 border border-gray-200 bg-white px-3 py-2 text-left font-normal dark:border-gray-700 dark:bg-gray-900"
        >
          <div className="flex items-center gap-2">
            <span
              className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full bg-primary-100 text-xs font-semibold text-primary-700 dark:bg-primary-900/40 dark:text-primary-300"
              aria-hidden="true"
            >
              {initials}
            </span>
            <span className="min-w-0">
              <span className="block truncate text-xs font-medium text-gray-900 dark:text-gray-100">
                {employee.employeeName}
              </span>
              {employee.position !== undefined && employee.position !== '' && (
                <span className="block truncate text-xs text-gray-400 dark:text-gray-500">
                  {employee.position}
                </span>
              )}
            </span>
            {published && (
              <Badge variant="info" size="sm" className="ml-auto flex-shrink-0">
                <Lock className="mr-1 h-3 w-3" aria-hidden="true" />
                Yayınlandı
              </Badge>
            )}
          </div>
        </th>
        {visibleDates.map((date) => renderCell(employee, date))}
        <td className="border border-gray-200 bg-success-50 px-2 py-1 text-center dark:border-gray-700 dark:bg-success-900/20">
          <span
            className={cn(
              'text-xs font-bold',
              totals.workDays > 0
                ? 'text-success-700 dark:text-success-300'
                : 'text-gray-300 dark:text-gray-600',
            )}
          >
            {totals.workDays}
          </span>
        </td>
        <td className="border border-gray-200 bg-success-50 px-2 py-1 text-center dark:border-gray-700 dark:bg-success-900/20">
          <span
            className={cn(
              'text-xs font-bold',
              totals.minutes > 0
                ? 'text-success-700 dark:text-success-300'
                : 'text-gray-300 dark:text-gray-600',
            )}
          >
            {formatMinutesAsHours(totals.minutes)}
          </span>
        </td>
      </tr>
    );
  };

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-800">
      <div className="border-b border-gray-200 bg-white px-6 py-4 dark:border-gray-700 dark:bg-gray-900">
        <PageHeader
          title={
            <>
              <Calendar
                className="h-6 w-6 text-primary-600 dark:text-primary-400"
                aria-hidden="true"
              />
              İş Çizelgesi
            </>
          }
          description="Çalışanların haftalık planları; her hücre seçildiği anda kaydedilir"
          actions={
            <div className="flex flex-wrap items-center gap-3">
              <div
                role="group"
                aria-label="Görünüm"
                className="flex rounded-lg bg-gray-100 p-0.5 dark:bg-gray-800"
              >
                {VIEW_MODES.map(({ mode, label }) => (
                  <Button
                    key={mode}
                    size="xs"
                    variant={viewMode === mode ? 'secondary' : 'ghost'}
                    aria-pressed={viewMode === mode}
                    onClick={() => setViewMode(mode)}
                  >
                    {label}
                  </Button>
                ))}
              </div>

              <nav aria-label="Tarih gezinme" className="flex items-center gap-1">
                <Button variant="ghost" iconOnly aria-label="Önceki" onClick={() => navigate(-1)}>
                  <ChevronLeft className="h-5 w-5" aria-hidden="true" />
                </Button>
                <div
                  className="flex min-w-[200px] items-center justify-center gap-2 rounded-lg border border-gray-200 bg-white px-4 py-2 dark:border-gray-700 dark:bg-gray-900"
                  aria-live="polite"
                >
                  <Calendar
                    className="h-4 w-4 text-primary-600 dark:text-primary-400"
                    aria-hidden="true"
                  />
                  <span className="text-sm font-semibold text-gray-900 dark:text-gray-100">
                    {navTitle}
                  </span>
                </div>
                <Button variant="ghost" iconOnly aria-label="Sonraki" onClick={() => navigate(1)}>
                  <ChevronRight className="h-5 w-5" aria-hidden="true" />
                </Button>
                <Button
                  variant="ghost"
                  size="xs"
                  className="ml-1"
                  onClick={() => setAnchor(startOfDay(new Date()))}
                >
                  Bugüne Dön
                </Button>
              </nav>

              {viewMode === 'weekly' && (
                <>
                  <Button
                    variant="primary"
                    leftIcon={<Send className="h-4 w-4" aria-hidden="true" />}
                    disabled={draftPlanIds.length === 0}
                    loading={publish.isPending}
                    onClick={() => {
                      void publishWeek();
                    }}
                  >
                    Haftayı Yayınla{draftPlanIds.length > 0 ? ` (${draftPlanIds.length})` : ''}
                  </Button>
                  {weekOverview !== undefined && <PrintScheduleButton overview={weekOverview} />}
                </>
              )}

              <Link
                to="/hr/scheduling/settings"
                className="flex items-center gap-1.5 rounded-lg bg-gray-100 px-3 py-2 text-sm text-gray-600 transition-colors hover:bg-gray-200 dark:bg-gray-800 dark:text-gray-400 dark:hover:bg-gray-600"
              >
                <Settings className="h-4 w-4" aria-hidden="true" />
                Ayarlar
              </Link>
            </div>
          }
        />
      </div>

      {/* Legend: the active shifts, then the two entry kinds a cell can also be */}
      <div className="border-b border-gray-100 bg-white px-6 py-2 dark:border-gray-700 dark:bg-gray-900">
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-xs font-medium text-gray-500 dark:text-gray-400">Vardiyalar:</span>
          {shifts.map((shift) => (
            <span
              key={shift.id}
              className="inline-flex items-center gap-1.5 rounded-full bg-gray-100 px-2.5 py-1 text-xs dark:bg-gray-800"
            >
              <span
                className="h-3 w-3 rounded-full"
                style={{ backgroundColor: sanitizeColor(shift.colorCode, colors.info[500]) }}
                aria-hidden="true"
              />
              <span className="font-bold text-gray-900 dark:text-gray-100">{shift.code}</span>
              <span className="text-gray-500 dark:text-gray-400">
                {shift.name} · {timeRange(shift.startTime, shift.endTime)}
              </span>
            </span>
          ))}
          {shifts.length === 0 && !shiftsQuery.isPending && (
            <Link
              to="/hr/scheduling/settings"
              className="text-xs font-medium text-primary-600 hover:underline dark:text-primary-400"
            >
              Aktif vardiya yok — Ayarlar'dan tanımlayın
            </Link>
          )}
          <Badge variant="default" size="sm">
            <Coffee className="mr-1 h-3 w-3" aria-hidden="true" />
            Tatil
          </Badge>
          <Badge variant="success" size="sm">
            <Umbrella className="mr-1 h-3 w-3" aria-hidden="true" />
            İzin (onaylı izin talebi)
          </Badge>
        </div>
      </div>

      <div className="p-4">
        <div
          className={cn(
            'overflow-auto rounded-xl bg-white shadow-sm dark:bg-gray-900',
            compact && 'max-h-[calc(100vh-220px)]',
          )}
        >
          {failed !== undefined ? (
            <ErrorState
              variant="plain"
              title="Çizelge yüklenemedi"
              description={
                failed.error instanceof Error ? failed.error.message : 'Planlar alınamadı'
              }
              retryLabel="Yeniden dene"
              onRetry={() => {
                void failed.refetch();
              }}
            />
          ) : loading ? (
            <div className="p-12">
              <Spinner size="lg" block text="Çizelge yükleniyor..." />
            </div>
          ) : employees.length === 0 ? (
            <EmptyState
              variant="plain"
              icon={<Calendar />}
              title="Çalışan bulunamadı"
              description="Çizelge için aktif bir çalışan kaydı gerekir."
            />
          ) : (
            <table className="w-full border-collapse">
              <caption className="sr-only">{navTitle} çalışma çizelgesi</caption>
              <thead className="sticky top-0 z-10">
                <tr className="bg-gray-50 dark:bg-gray-800">
                  <th
                    scope="col"
                    className="sticky left-0 z-20 min-w-[180px] border border-gray-200 bg-gray-50 px-4 py-2 text-left text-xs font-semibold text-gray-600 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-400"
                  >
                    Çalışan
                  </th>
                  {visibleDates.map((date) => {
                    const header = columnHeader(date);
                    const dateStr = formatDateISO(date);
                    const today = dateStr === todayStr;
                    return (
                      <th
                        key={dateStr}
                        scope="col"
                        className={cn(
                          'border border-gray-200 px-1 py-1.5 text-center dark:border-gray-700',
                          compact ? 'min-w-[36px]' : 'min-w-[56px]',
                          isWeekend(date) && 'bg-gray-100 dark:bg-gray-800',
                          today && 'bg-primary-50 dark:bg-primary-900/30',
                        )}
                      >
                        <span
                          className={cn(
                            'block text-xs font-semibold',
                            today
                              ? 'text-primary-600 dark:text-primary-400'
                              : isWeekend(date)
                                ? 'text-gray-400 dark:text-gray-500'
                                : 'text-gray-700 dark:text-gray-300',
                          )}
                        >
                          {header.top}
                        </span>
                        <span
                          className={cn(
                            'block text-xs',
                            today
                              ? 'text-primary-500 dark:text-primary-400'
                              : 'text-gray-400 dark:text-gray-500',
                          )}
                        >
                          {header.bottom}
                        </span>
                      </th>
                    );
                  })}
                  <th
                    scope="col"
                    className="min-w-[40px] border border-gray-200 bg-success-50 px-2 py-1.5 text-center text-xs font-semibold text-gray-600 dark:border-gray-700 dark:bg-success-900/20 dark:text-gray-400"
                  >
                    Gün
                  </th>
                  <th
                    scope="col"
                    className="min-w-[56px] border border-gray-200 bg-success-50 px-2 py-1.5 text-center text-xs font-semibold text-gray-600 dark:border-gray-700 dark:bg-success-900/20 dark:text-gray-400"
                  >
                    Saat
                  </th>
                </tr>
              </thead>
              <tbody>{employees.map((employee) => renderEmployeeRow(employee))}</tbody>
              <tfoot>
                <tr className="bg-gray-50 dark:bg-gray-800">
                  <th
                    scope="row"
                    className="sticky left-0 z-10 border border-gray-200 bg-gray-50 px-3 py-2 text-left text-xs font-semibold text-gray-600 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-400"
                  >
                    Çalışan sayısı
                  </th>
                  {visibleDates.map((date) => {
                    const count = workingCountOn(date);
                    return (
                      <td
                        key={formatDateISO(date)}
                        className="border border-gray-200 px-1 py-2 text-center dark:border-gray-700"
                      >
                        <span
                          className={cn(
                            'text-xs font-bold',
                            count > 0
                              ? 'text-primary-600 dark:text-primary-400'
                              : 'text-gray-300 dark:text-gray-600',
                          )}
                        >
                          {count}
                        </span>
                      </td>
                    );
                  })}
                  <td
                    className="border border-gray-200 bg-success-50 dark:border-gray-700 dark:bg-success-900/20"
                    colSpan={2}
                  />
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
