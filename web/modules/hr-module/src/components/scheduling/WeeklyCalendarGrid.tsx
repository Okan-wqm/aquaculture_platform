/**
 * WeeklyCalendarGrid Component
 * 7-day grid for planning employee weekly schedule with drag-drop
 */

import React, { useMemo } from 'react';
import { AlertTriangle, Clock } from 'lucide-react';
import { cn } from '@aquaculture/shared-ui';
import { ShiftCell } from './ShiftCell';
import { formatMinutesAsHours, getWeekdayShortTR } from '../../hooks/useScheduling';
import type { WeeklyPlan, WeeklyPlanEntry, WeekDay } from '../../types/scheduling.types';

interface WeeklyCalendarGridProps {
  plan: WeeklyPlan;
  isEditable?: boolean;
  selectedEntryId?: string;
  onSelectEntry?: (entryId: string) => void;
  onUpdateEntry?: (entryId: string, shiftId: string | null, isOffDay: boolean) => void;
  compact?: boolean;
  showOvertimeWarning?: boolean;
}

const WEEKDAYS: WeekDay[] = [
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
  'sunday',
];

const WEEKDAY_LABELS: Record<WeekDay, string> = {
  monday: 'Pazartesi',
  tuesday: 'Sali',
  wednesday: 'Carsamba',
  thursday: 'Persembe',
  friday: 'Cuma',
  saturday: 'Cumartesi',
  sunday: 'Pazar',
};

export function WeeklyCalendarGrid({
  plan,
  isEditable = false,
  selectedEntryId,
  onSelectEntry,
  onUpdateEntry,
  compact = false,
  showOvertimeWarning = true,
}: WeeklyCalendarGridProps) {
  // Map entries by day
  const entriesByDay = useMemo(() => {
    const map: Partial<Record<WeekDay, WeeklyPlanEntry>> = {};
    plan.entries?.forEach((entry) => {
      map[entry.dayOfWeek] = entry;
    });
    return map;
  }, [plan.entries]);

  // Calculate dates for each day
  const dayDates = useMemo(() => {
    // PERF-011: new Date('YYYY-MM-DD') parses as UTC midnight which shifts the
    // calendar date for UTC+ timezones.  Append T00:00:00 to parse as local time.
    const startDate = new Date(plan.weekStartDate.includes('T')
      ? plan.weekStartDate
      : `${plan.weekStartDate}T00:00:00`);
    const dates: Record<WeekDay, string> = {} as Record<WeekDay, string>;
    WEEKDAYS.forEach((day, index) => {
      const date = new Date(startDate);
      date.setDate(date.getDate() + index);
      dates[day] = date.toLocaleDateString('tr-TR', {
        day: 'numeric',
        month: 'short',
      });
    });
    return dates;
  }, [plan.weekStartDate]);

  const handleEntryDrop = (day: WeekDay, shiftId: string | null, isOffDay: boolean) => {
    const entry = entriesByDay[day];
    if (entry && onUpdateEntry) {
      onUpdateEntry(entry.id, shiftId, isOffDay);
    }
  };

  const hasOvertime = plan.plannedOvertimeMinutes > 0;
  const totalHours = formatMinutesAsHours(plan.plannedTotalMinutes);
  const overtimeHours = formatMinutesAsHours(plan.plannedOvertimeMinutes);

  const gridLabel = `${plan.employee?.firstName ?? ''} ${plan.employee?.lastName ?? ''} haftalik is cizelgesi`;

  return (
    <div className="w-full">
      {/* Screen reader summary */}
      <div className="sr-only" role="status" aria-live="polite">
        {plan.employee?.firstName} {plan.employee?.lastName} icin haftalik plan:
        {plan.plannedWorkDays} is gunu, {plan.plannedOffDays} tatil gunu, toplam {totalHours}.
        {hasOvertime && ` +${overtimeHours} fazla mesai.`}
      </div>

      {/* Grid container */}
      <div role="grid" aria-label={gridLabel}>
        {/* Header Row - Days */}
        <div className="grid grid-cols-7 gap-1 mb-1" role="row">
          {WEEKDAYS.map((day, index) => (
            <div
              key={day}
              role="columnheader"
              aria-colindex={index + 1}
              className={cn(
                'text-center py-2 rounded-t-lg',
                day === 'saturday' || day === 'sunday'
                  ? 'bg-gray-100 text-gray-600'
                  : 'bg-indigo-50 text-indigo-700'
              )}
            >
              <div className="text-sm font-medium">
                {compact ? getWeekdayShortTR(day) : WEEKDAY_LABELS[day]}
              </div>
              {!compact && (
                <div className="text-xs text-gray-500">{dayDates[day]}</div>
              )}
            </div>
          ))}
        </div>

        {/* Entries Row */}
        <div className="grid grid-cols-7 gap-1" role="row">
          {WEEKDAYS.map((day, index) => {
            const entry = entriesByDay[day];
            return (
              <div key={day} className="min-h-[60px]" role="gridcell" aria-colindex={index + 1}>
                <ShiftCell
                  entry={entry}
                  isEditable={isEditable && plan.status === 'draft'}
                  isSelected={entry?.id === selectedEntryId}
                  onSelect={() => entry && onSelectEntry?.(entry.id)}
                  onDrop={(shiftId, isOffDay) => handleEntryDrop(day, shiftId, isOffDay)}
                  compact={compact}
                  dayLabel={WEEKDAY_LABELS[day]}
                  dateLabel={dayDates[day]}
                />
              </div>
            );
          })}
        </div>
      </div>

      {/* Summary Row */}
      <div className="mt-2 flex items-center justify-between text-sm" aria-hidden="true">
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-1 text-gray-600">
            <Clock className="h-4 w-4" aria-hidden="true" />
            <span>
              <span className="font-medium">{totalHours}</span>
              <span className="text-gray-400 ml-1">toplam</span>
            </span>
          </div>

          <div className="text-gray-400" aria-hidden="true">|</div>

          <div className="text-gray-600">
            <span className="font-medium">{plan.plannedWorkDays}</span>
            <span className="text-gray-400 ml-1">is gunu</span>
          </div>

          <div className="text-gray-400" aria-hidden="true">|</div>

          <div className="text-gray-600">
            <span className="font-medium">{plan.plannedOffDays}</span>
            <span className="text-gray-400 ml-1">tatil</span>
          </div>
        </div>

        {/* Overtime indicator */}
        {showOvertimeWarning && hasOvertime && (
          <div
            role="alert"
            aria-live="polite"
            className={cn(
              'flex items-center gap-1 px-2 py-1 rounded-full text-xs font-medium',
              plan.plannedOvertimeMinutes > 300
                ? 'bg-red-100 text-red-700'
                : 'bg-amber-100 text-amber-700'
            )}
          >
            <AlertTriangle className="h-3 w-3" aria-hidden="true" />
            <span>+{overtimeHours} fazla mesai</span>
          </div>
        )}
      </div>

      {/* Status indicator */}
      {plan.status === 'published' && (
        <div className="mt-2 flex items-center justify-end">
          <span className="text-xs px-2 py-0.5 rounded-full bg-green-100 text-green-700">
            Yayinlandi
            {plan.publishedAt && (
              <span className="ml-1 text-green-500">
                ({new Date(plan.publishedAt).toLocaleDateString('tr-TR')})
              </span>
            )}
          </span>
        </div>
      )}
    </div>
  );
}

export default WeeklyCalendarGrid;
