import { clsx } from 'clsx';
import { ArrowLeft, ChevronLeft, ChevronRight, Clock, Coffee, Palmtree, GraduationCap, CalendarOff } from 'lucide-react';
import type { JSX } from 'react';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';

import type { WeeklyPlanEntryType } from '@/generated/graphql';
import { useMySchedule, formatMinutesAsHours } from '@/hooks/useMySchedule';
import type { WeeklyPlanEntry } from '@/hooks/useMySchedule';


const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const DAY_NAMES_FULL = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

// MOB-HIGH-022: keyed by the generated enum (wire NAMES). The old record was
// keyed by lowercase strings, so every lookup missed and each day rendered as
// "Day Off"; a total Record makes a missing entry type a compile error.
const ENTRY_TYPE_CONFIG: Record<WeeklyPlanEntryType, { icon: typeof Clock; label: string; bgColor: string; textColor: string }> = {
  WORK: { icon: Clock, label: 'Work', bgColor: 'bg-ocean-50 dark:bg-ocean-900/20', textColor: 'text-ocean-600 dark:text-ocean-400' },
  OFF: { icon: Coffee, label: 'Day Off', bgColor: 'bg-gray-50 dark:bg-gray-800', textColor: 'text-gray-500' },
  LEAVE: { icon: Palmtree, label: 'Leave', bgColor: 'bg-sea-50 dark:bg-sea-900/20', textColor: 'text-sea-600 dark:text-sea-400' },
  HOLIDAY: { icon: CalendarOff, label: 'Holiday', bgColor: 'bg-coral-50 dark:bg-coral-900/20', textColor: 'text-coral-600' },
  TRAINING: { icon: GraduationCap, label: 'Training', bgColor: 'bg-purple-50 dark:bg-purple-900/20', textColor: 'text-purple-600' },
};

function isToday(dateStr: string): boolean {
  return new Date().toISOString().split('T')[0] === dateStr;
}

function DayCard({ entry }: { entry: WeeklyPlanEntry }): JSX.Element {
  const config = ENTRY_TYPE_CONFIG[entry.entryType];
  const Icon = config.icon;
  const today = isToday(entry.date);
  const dayIndex = new Date(entry.date).getDay();
  const adjustedIndex = dayIndex === 0 ? 6 : dayIndex - 1;

  const startTime = entry.plannedStartTime || entry.shift?.startTime;
  const endTime = entry.plannedEndTime || entry.shift?.endTime;

  return (
    <div
      className={clsx(
        'rounded-2xl p-4 border transition-all',
        today
          ? 'border-ocean-300 dark:border-ocean-600 bg-ocean-50/50 dark:bg-ocean-900/10 shadow-glow-ocean'
          : 'border-gray-100 dark:border-gray-800 bg-white dark:bg-gray-900'
      )}
    >
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          {today && <span className="w-2 h-2 rounded-full bg-ocean-500 animate-pulse" />}
          <span className={clsx('text-sm font-bold', today ? 'text-ocean-600 dark:text-ocean-400' : 'text-gray-900 dark:text-white')}>
            {DAY_NAMES_FULL[adjustedIndex]}
          </span>
        </div>
        <span className="text-xs text-gray-400 font-medium">
          {new Date(entry.date).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}
        </span>
      </div>

      <div className={clsx('flex items-center gap-3 rounded-xl px-3 py-2.5', config.bgColor)}>
        <Icon size={18} className={config.textColor} />
        <div className="flex-1">
          <div className={clsx('text-sm font-semibold', config.textColor)}>
            {entry.entryType === 'WORK' && entry.shift ? entry.shift.name : config.label}
          </div>
          {entry.entryType === 'WORK' && startTime && endTime && (
            <div className="text-xs text-gray-500 mt-0.5">
              {startTime.slice(0, 5)} - {endTime.slice(0, 5)}
              {entry.plannedMinutes > 0 && (
                <span className="ml-2 text-gray-400">({formatMinutesAsHours(entry.plannedMinutes)})</span>
              )}
            </div>
          )}
        </div>
        {entry.shift?.colorCode && (
          <div className="w-3 h-3 rounded-full" style={{ backgroundColor: entry.shift.colorCode }} />
        )}
      </div>
    </div>
  );
}

export function MySchedulePage(): JSX.Element {
  const navigate = useNavigate();
  const [weekOffset, setWeekOffset] = useState(0);
  const { data: plan, isLoading, isError } = useMySchedule(weekOffset);

  const targetDate = new Date();
  targetDate.setDate(targetDate.getDate() + weekOffset * 7);
  const day = targetDate.getDay();
  const mondayDate = new Date(targetDate);
  mondayDate.setDate(targetDate.getDate() - day + (day === 0 ? -6 : 1));
  const sundayDate = new Date(mondayDate);
  sundayDate.setDate(mondayDate.getDate() + 6);

  const formatWeekRange = (): string => {
    const opts: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short' };
    return `${mondayDate.toLocaleDateString('en-GB', opts)} - ${sundayDate.toLocaleDateString('en-GB', opts)}`;
  };

  const sortedEntries = plan?.entries
    ? [...plan.entries].sort((a, b) => a.date.localeCompare(b.date))
    : [];

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-950">
      {/* Header */}
      <div className="bg-gradient-to-r from-ocean-700 to-ocean-500 text-white">
        <div className="flex items-center gap-3 px-4 py-4 pt-safe-top">
          <button onClick={() => navigate(-1)} className="p-2 -ml-2 rounded-xl hover:bg-white/10 touch-feedback">
            <ArrowLeft size={22} />
          </button>
          <div className="flex items-center gap-2.5">
            <Clock size={22} />
            <h1 className="text-lg font-bold">My Schedule</h1>
          </div>
        </div>

        {/* Week navigation */}
        <div className="flex items-center justify-between px-4 pb-4">
          <button
            onClick={() => setWeekOffset((w) => w - 1)}
            className="p-2 rounded-xl bg-white/10 hover:bg-white/20 touch-feedback"
          >
            <ChevronLeft size={20} />
          </button>
          <div className="text-center">
            <div className="text-sm font-semibold">{formatWeekRange()}</div>
            <div className="text-ocean-200 text-xs font-medium mt-0.5">
              {weekOffset === 0 ? 'This Week' : weekOffset === 1 ? 'Next Week' : weekOffset === -1 ? 'Last Week' : ''}
            </div>
          </div>
          <button
            onClick={() => setWeekOffset((w) => w + 1)}
            className="p-2 rounded-xl bg-white/10 hover:bg-white/20 touch-feedback"
          >
            <ChevronRight size={20} />
          </button>
        </div>

        {/* Summary stats */}
        {plan && (
          <div className="grid grid-cols-3 gap-3 px-4 pb-4">
            <div className="bg-white/10 backdrop-blur-sm rounded-xl p-2.5 text-center">
              <div className="text-lg font-bold">{plan.plannedWorkDays}</div>
              <div className="text-ocean-200 text-[10px] font-medium">Work Days</div>
            </div>
            <div className="bg-white/10 backdrop-blur-sm rounded-xl p-2.5 text-center">
              <div className="text-lg font-bold">{formatMinutesAsHours(plan.plannedTotalMinutes)}</div>
              <div className="text-ocean-200 text-[10px] font-medium">Total Hours</div>
            </div>
            <div className={clsx(
              'rounded-xl p-2.5 text-center backdrop-blur-sm',
              plan.plannedOvertimeMinutes > 0 ? 'bg-coral-500/30' : 'bg-white/10'
            )}>
              <div className="text-lg font-bold">
                {plan.plannedOvertimeMinutes > 0 ? formatMinutesAsHours(plan.plannedOvertimeMinutes) : '--'}
              </div>
              <div className={clsx('text-[10px] font-medium', plan.plannedOvertimeMinutes > 0 ? 'text-coral-200' : 'text-ocean-200')}>
                Overtime
              </div>
            </div>
          </div>
        )}

        {/* BUG-12: Removed conflicting 'relative' — 'relative' overrides 'absolute'
            as they are in the same CSS property group. Only 'absolute' is intended. */}
        <div className="absolute -bottom-px left-0 right-0">
          <svg viewBox="0 0 400 20" fill="none" className="w-full block" preserveAspectRatio="none">
            <path d="M0 20V0c100 15 200 15 400 0v20z" className="fill-gray-50 dark:fill-gray-950" />
          </svg>
        </div>
      </div>

      {/* Content */}
      <div className="px-4 pt-2 pb-24">
        {isLoading ? (
          <div className="space-y-3">
            {[1, 2, 3, 4, 5].map((i) => (
              <div key={i} className="h-20 rounded-2xl skeleton" />
            ))}
          </div>
        ) : isError ? (
          <div className="text-center py-12 text-gray-400">
            <Clock size={48} className="mx-auto mb-3 opacity-30" />
            <p className="font-medium">Could not load schedule</p>
            <p className="text-sm mt-1">Please try again later</p>
          </div>
        ) : !plan || sortedEntries.length === 0 ? (
          <div className="text-center py-12 text-gray-400">
            <CalendarOff size={48} className="mx-auto mb-3 opacity-30" />
            <p className="font-medium">No schedule published</p>
            <p className="text-sm mt-1">Your schedule for this week has not been published yet</p>
            <button
              onClick={() => setWeekOffset(0)}
              className="mt-4 text-ocean-500 text-sm font-semibold touch-feedback"
            >
              Go to this week
            </button>
          </div>
        ) : (
          <div className="space-y-3">
            {/* Mini day indicator bar */}
            <div className="flex gap-1.5 mb-4">
              {sortedEntries.map((entry) => {
                const dayIndex = new Date(entry.date).getDay();
                const adjustedIndex = dayIndex === 0 ? 6 : dayIndex - 1;
                const today = isToday(entry.date);
                return (
                  <div key={entry.id} className="flex-1 text-center">
                    <div className={clsx(
                      'text-[10px] font-bold mb-1',
                      today ? 'text-ocean-600' : 'text-gray-400'
                    )}>
                      {DAY_NAMES[adjustedIndex]}
                    </div>
                    <div className={clsx(
                      'h-1.5 rounded-full',
                      entry.entryType === 'WORK'
                        ? today ? 'bg-ocean-500' : 'bg-ocean-300 dark:bg-ocean-700'
                        : entry.entryType === 'OFF' ? 'bg-gray-200 dark:bg-gray-700'
                        : entry.entryType === 'LEAVE' ? 'bg-sea-400'
                        : entry.entryType === 'HOLIDAY' ? 'bg-coral-400'
                        : 'bg-purple-400'
                    )} />
                  </div>
                );
              })}
            </div>

            {sortedEntries.map((entry) => (
              <DayCard key={entry.id} entry={entry} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
