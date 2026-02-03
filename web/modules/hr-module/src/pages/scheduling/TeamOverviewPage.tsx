/**
 * TeamOverviewPage
 * Matrix view of all employees' weekly schedules
 */

import React, { useState, useMemo } from 'react';
import {
  Users,
  Calendar,
  Printer,
  Filter,
  Coffee,
  Umbrella,
  AlertTriangle,
} from 'lucide-react';
import { cn } from '@aquaculture/shared-ui';
import {
  WeekNavigator,
  PrintScheduleButton,
} from '../../components/scheduling';
import {
  useTeamWeeklyOverview,
  getWeekMonday,
  formatDateISO,
  formatMinutesAsHours,
  getWeekdayShortTR,
} from '../../hooks/useScheduling';
import type { WeekDay, DayEntry } from '../../types/scheduling.types';

const WEEKDAYS: WeekDay[] = [
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
  'sunday',
];

interface DayCellProps {
  entry?: DayEntry;
  isWeekend?: boolean;
}

function DayCell({ entry, isWeekend }: DayCellProps) {
  if (!entry) {
    return (
      <td className={cn(
        'px-2 py-3 text-center border-r border-gray-100',
        isWeekend && 'bg-gray-50'
      )}>
        <span className="text-gray-300">-</span>
      </td>
    );
  }

  if (entry.entryType === 'off') {
    return (
      <td className={cn(
        'px-2 py-3 text-center border-r border-gray-100',
        isWeekend && 'bg-gray-50'
      )}>
        <div className="flex items-center justify-center">
          <span className="inline-flex items-center gap-1 px-2 py-0.5 bg-gray-100 rounded text-xs text-gray-600">
            <Coffee className="h-3 w-3" />
            Tatil
          </span>
        </div>
      </td>
    );
  }

  if (entry.entryType === 'leave') {
    return (
      <td className={cn(
        'px-2 py-3 text-center border-r border-gray-100',
        isWeekend && 'bg-gray-50'
      )}>
        <div className="flex items-center justify-center">
          <span className="inline-flex items-center gap-1 px-2 py-0.5 bg-green-100 rounded text-xs text-green-700">
            <Umbrella className="h-3 w-3" />
            Izin
          </span>
        </div>
      </td>
    );
  }

  if (entry.entryType === 'holiday') {
    return (
      <td className={cn(
        'px-2 py-3 text-center border-r border-gray-100 bg-purple-50'
      )}>
        <span className="text-xs text-purple-700 font-medium">Resmi Tatil</span>
      </td>
    );
  }

  // Work day
  const timeRange = entry.startTime && entry.endTime
    ? `${entry.startTime.slice(0, 5)}-${entry.endTime.slice(0, 5)}`
    : entry.shiftCode || '-';

  return (
    <td className={cn(
      'px-2 py-3 text-center border-r border-gray-100',
      isWeekend && 'bg-gray-50'
    )}>
      <div className="text-xs">
        <span className="font-medium text-blue-700">{entry.shiftCode || 'M'}</span>
        <div className="text-gray-500 text-[10px]">{timeRange}</div>
      </div>
    </td>
  );
}

export function TeamOverviewPage() {
  const [currentWeekStart, setCurrentWeekStart] = useState(() => getWeekMonday(new Date()));
  const [departmentFilter, setDepartmentFilter] = useState<string | undefined>();
  const [siteFilter, setSiteFilter] = useState<string | undefined>();

  const weekStartStr = formatDateISO(currentWeekStart);

  const { data: overview, isLoading, error } = useTeamWeeklyOverview(
    weekStartStr,
    departmentFilter,
    siteFilter
  );

  // Calculate dates for header
  const headerDates = useMemo(() => {
    const dates: Record<WeekDay, { short: string; date: string }> = {} as any;
    WEEKDAYS.forEach((day, index) => {
      const date = new Date(currentWeekStart);
      date.setDate(date.getDate() + index);
      dates[day] = {
        short: getWeekdayShortTR(day),
        date: date.toLocaleDateString('tr-TR', { day: 'numeric', month: 'short' }),
      };
    });
    return dates;
  }, [currentWeekStart]);

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <div className="bg-white border-b border-gray-200 px-6 py-4">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-gray-900 flex items-center gap-2">
              <Users className="h-6 w-6 text-indigo-600" />
              Takim Gorunumu
            </h1>
            <p className="text-sm text-gray-500 mt-1">
              Tum calisanlarin haftalik programlari
            </p>
          </div>

          <div className="flex items-center gap-4">
            <WeekNavigator
              currentWeekStart={currentWeekStart}
              onChange={setCurrentWeekStart}
            />

            {overview && (
              <PrintScheduleButton
                overview={overview}
                siteName="Site"
                departmentName={departmentFilter}
              />
            )}
          </div>
        </div>
      </div>

      {/* Stats Bar */}
      {overview && (
        <div className="bg-white border-b border-gray-200 px-6 py-3">
          <div className="flex items-center gap-6">
            <div className="flex items-center gap-2">
              <Users className="h-4 w-4 text-gray-400" />
              <span className="text-sm text-gray-600">
                <strong className="text-gray-900">{overview.totalEmployees}</strong> calisan
              </span>
            </div>

            {overview.daysSummary.map((day) => (
              <div
                key={day.dayOfWeek}
                className="flex items-center gap-1.5 text-xs"
              >
                <span className="font-medium text-gray-500">
                  {getWeekdayShortTR(day.dayOfWeek)}:
                </span>
                <span className="text-blue-600">{day.workingCount}C</span>
                <span className="text-gray-400">/</span>
                <span className="text-gray-500">{day.offCount}T</span>
                {day.leaveCount > 0 && (
                  <>
                    <span className="text-gray-400">/</span>
                    <span className="text-green-600">{day.leaveCount}I</span>
                  </>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Main Content */}
      <div className="p-6">
        {isLoading ? (
          <div className="bg-white rounded-xl shadow-sm p-8">
            <div className="animate-pulse space-y-4">
              <div className="h-8 bg-gray-200 rounded w-full" />
              {[1, 2, 3, 4, 5].map((i) => (
                <div key={i} className="h-12 bg-gray-100 rounded w-full" />
              ))}
            </div>
          </div>
        ) : error ? (
          <div className="bg-white rounded-xl shadow-sm p-8 text-center">
            <AlertTriangle className="h-12 w-12 text-red-400 mx-auto mb-4" />
            <h3 className="text-lg font-medium text-gray-900 mb-2">
              Veri yuklenemedi
            </h3>
            <p className="text-gray-500">{String(error)}</p>
          </div>
        ) : !overview?.employeePlans.length ? (
          <div className="bg-white rounded-xl shadow-sm p-12 text-center">
            <Calendar className="h-12 w-12 text-gray-300 mx-auto mb-4" />
            <h3 className="text-lg font-medium text-gray-900 mb-2">
              Bu hafta icin plan bulunamadi
            </h3>
            <p className="text-gray-500">
              Calisanlar icin haftalik plan olusturun.
            </p>
          </div>
        ) : (
          <div className="bg-white rounded-xl shadow-sm overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="bg-gray-50 border-b border-gray-200">
                    <th className="text-left px-4 py-3 text-sm font-semibold text-gray-700 sticky left-0 bg-gray-50 z-10 min-w-[180px]">
                      Calisan
                    </th>
                    {WEEKDAYS.map((day) => (
                      <th
                        key={day}
                        className={cn(
                          'text-center px-2 py-3 text-sm font-semibold min-w-[90px]',
                          day === 'saturday' || day === 'sunday'
                            ? 'text-gray-500 bg-gray-100'
                            : 'text-gray-700'
                        )}
                      >
                        <div>{headerDates[day].short}</div>
                        <div className="text-xs font-normal text-gray-500">
                          {headerDates[day].date}
                        </div>
                      </th>
                    ))}
                    <th className="text-center px-4 py-3 text-sm font-semibold text-gray-700 min-w-[70px]">
                      Gun
                    </th>
                    <th className="text-center px-4 py-3 text-sm font-semibold text-gray-700 min-w-[70px]">
                      Saat
                    </th>
                    <th className="text-center px-4 py-3 text-sm font-semibold text-gray-700 min-w-[70px]">
                      Mesai
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {overview.employeePlans.map((emp, idx) => {
                    const hasOvertime = emp.overtimeMinutes > 0;

                    return (
                      <tr
                        key={emp.employeeId}
                        className={cn(
                          'border-b border-gray-100 hover:bg-gray-50 transition-colors',
                          idx % 2 === 0 ? 'bg-white' : 'bg-gray-50/30'
                        )}
                      >
                        {/* Employee Name */}
                        <td className="px-4 py-3 sticky left-0 bg-inherit z-10">
                          <div className="flex items-center gap-3">
                            <div className="h-8 w-8 rounded-full bg-indigo-100 flex items-center justify-center flex-shrink-0">
                              <span className="text-xs font-medium text-indigo-600">
                                {emp.employeeName
                                  .split(' ')
                                  .map((n) => n[0])
                                  .join('')
                                  .slice(0, 2)}
                              </span>
                            </div>
                            <div className="min-w-0">
                              <div className="font-medium text-gray-900 truncate">
                                {emp.employeeName}
                              </div>
                              {emp.position && (
                                <div className="text-xs text-gray-500 truncate">
                                  {emp.position}
                                </div>
                              )}
                            </div>
                          </div>
                        </td>

                        {/* Days */}
                        {WEEKDAYS.map((day) => {
                          const dayEntry = emp.days.find((d) => d.dayOfWeek === day);
                          const isWeekend = day === 'saturday' || day === 'sunday';
                          return (
                            <DayCell
                              key={day}
                              entry={dayEntry}
                              isWeekend={isWeekend}
                            />
                          );
                        })}

                        {/* Total Work Days */}
                        <td className="px-4 py-3 text-center">
                          <span className="font-medium text-gray-900">
                            {emp.totalWorkDays}
                          </span>
                        </td>

                        {/* Total Hours */}
                        <td className="px-4 py-3 text-center">
                          <span className="font-medium text-gray-900">
                            {formatMinutesAsHours(emp.totalMinutes)}
                          </span>
                        </td>

                        {/* Overtime */}
                        <td className="px-4 py-3 text-center">
                          {hasOvertime ? (
                            <span className={cn(
                              'inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium',
                              emp.overtimeMinutes > 300
                                ? 'bg-red-100 text-red-700'
                                : 'bg-amber-100 text-amber-700'
                            )}>
                              +{formatMinutesAsHours(emp.overtimeMinutes)}
                            </span>
                          ) : (
                            <span className="text-gray-400">-</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>

                {/* Summary Footer */}
                <tfoot>
                  <tr className="bg-indigo-50 border-t-2 border-indigo-200">
                    <td className="px-4 py-3 font-semibold text-indigo-900 sticky left-0 bg-indigo-50 z-10">
                      TOPLAM
                    </td>
                    {overview.daysSummary.map((day) => (
                      <td
                        key={day.dayOfWeek}
                        className="px-2 py-3 text-center text-sm"
                      >
                        <div className="font-medium text-indigo-700">
                          {day.workingCount} C
                        </div>
                        <div className="text-xs text-indigo-500">
                          {day.offCount} T
                        </div>
                      </td>
                    ))}
                    <td colSpan={3} className="px-4 py-3 text-center">
                      <span className="text-sm font-medium text-indigo-900">
                        {overview.totalEmployees} Calisan
                      </span>
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </div>
        )}

        {/* Legend */}
        <div className="mt-4 flex items-center justify-center gap-6 text-xs text-gray-500">
          <div className="flex items-center gap-1.5">
            <div className="w-4 h-4 rounded bg-blue-100 border border-blue-200" />
            <span>Mesai</span>
          </div>
          <div className="flex items-center gap-1.5">
            <div className="w-4 h-4 rounded bg-gray-100 border border-gray-200" />
            <span>Tatil</span>
          </div>
          <div className="flex items-center gap-1.5">
            <div className="w-4 h-4 rounded bg-green-100 border border-green-200" />
            <span>Izin</span>
          </div>
          <div className="flex items-center gap-1.5">
            <div className="w-4 h-4 rounded bg-purple-100 border border-purple-200" />
            <span>Resmi Tatil</span>
          </div>
        </div>
      </div>
    </div>
  );
}

export default TeamOverviewPage;
