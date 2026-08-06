import { clsx } from 'clsx';
import { ChevronLeft, ChevronRight, Clock, Coffee, Palmtree, GraduationCap, CalendarOff } from 'lucide-react';
import type { JSX } from 'react';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { AppHeader } from '@/components/AppHeader';
import { Card, EmptyState, IconButton, Skeleton } from '@/components/ui';
import { useMySchedule, formatMinutesAsHours } from '@/hooks/useMySchedule';
import type { WeeklyPlanEntry } from '@/hooks/useMySchedule';


const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const DAY_NAMES_FULL = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

/**
 * Entry type → its well and its ink.
 *
 * v4: the five hand-mixed palettes (ocean / gray / sea / coral / purple, each
 * with a dark-mode twin) become semantic tokens. Work is the accent because it
 * is the default state of a shift; leave confirms; a public holiday is the one
 * the worker must not misread, so it takes the watch tone; training borrows the
 * transfer hue, which exists precisely to be discriminable from the others. The
 * label ("Work", "Day Off", "Leave", "Holiday", "Training") is always drawn, so
 * none of this rests on colour alone.
 */
const ENTRY_TYPE_CONFIG: Record<string, { icon: typeof Clock; label: string; bgColor: string; textColor: string; barColor: string }> = {
  work: { icon: Clock, label: 'Work', bgColor: 'bg-acc-dim', textColor: 'text-acc', barColor: 'bg-acc' },
  off: { icon: Coffee, label: 'Day Off', bgColor: 'bg-surface-2', textColor: 'text-ink-3', barColor: 'bg-surface-3' },
  leave: { icon: Palmtree, label: 'Leave', bgColor: 'bg-surface-2', textColor: 'text-ok', barColor: 'bg-ok' },
  holiday: { icon: CalendarOff, label: 'Holiday', bgColor: 'bg-warn-dim', textColor: 'text-warn', barColor: 'bg-warn' },
  training: { icon: GraduationCap, label: 'Training', bgColor: 'bg-type-transfer-dim', textColor: 'text-type-transfer', barColor: 'bg-type-transfer' },
};

function isToday(dateStr: string): boolean {
  return new Date().toISOString().split('T')[0] === dateStr;
}

function DayCard({ entry }: { entry: WeeklyPlanEntry }): JSX.Element {
  const config = ENTRY_TYPE_CONFIG[entry.entryType] || ENTRY_TYPE_CONFIG.off;
  const Icon = config.icon;
  const today = isToday(entry.date);
  const dayIndex = new Date(entry.date).getDay();
  const adjustedIndex = dayIndex === 0 ? 6 : dayIndex - 1;

  const startTime = entry.plannedStartTime || entry.shift?.startTime;
  const endTime = entry.plannedEndTime || entry.shift?.endTime;

  return (
    <Card className={clsx('p-4', today && 'border-acc')}>
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          {today && <span aria-hidden className="w-2 h-2 rounded-full bg-acc animate-am-blip" />}
          <span
            className={clsx('text-body font-bold', today ? 'text-acc' : 'text-ink-1')}
          >
            {DAY_NAMES_FULL[adjustedIndex]}
          </span>
        </div>
        <span className="text-meta text-ink-3 font-mono">
          {new Date(entry.date).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}
        </span>
      </div>

      <div className={clsx('flex items-center gap-3 rounded-xl px-3 py-2.5', config.bgColor)}>
        <Icon size={18} className={config.textColor} />
        <div className="flex-1">
          <div className={clsx('text-body font-semibold', config.textColor)}>
            {entry.entryType === 'work' && entry.shift ? entry.shift.name : config.label}
          </div>
          {entry.entryType === 'work' && startTime && endTime && (
            <div className="text-meta text-ink-3 mt-0.5 font-mono">
              {startTime.slice(0, 5)} - {endTime.slice(0, 5)}
              {entry.plannedMinutes > 0 && (
                <span className="ml-2">({formatMinutesAsHours(entry.plannedMinutes)})</span>
              )}
            </div>
          )}
        </div>
        {entry.shift?.colorCode && (
          // The tenant's own shift colour — data, not a design token.
          <div className="w-3 h-3 rounded-full shrink-0" style={{ backgroundColor: entry.shift.colorCode }} />
        )}
      </div>
    </Card>
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
    <div className="pb-32">
      <AppHeader title="My Schedule" onBack={() => navigate(-1)} showAvatar={false} />

      <div className="px-4 flex flex-col gap-4">
        {/* Week navigation */}
        <div className="flex items-center justify-between">
          <IconButton
            aria-label="Previous week"
            onClick={() => setWeekOffset((w) => w - 1)}
            className="bg-surface-2 rounded-xl"
          >
            <ChevronLeft size={20} className="text-ink-2" />
          </IconButton>
          <div className="text-center">
            <div className="text-title font-semibold text-ink-1">{formatWeekRange()}</div>
            <div className="text-meta text-ink-3 font-medium mt-0.5">
              {weekOffset === 0 ? 'This Week' : weekOffset === 1 ? 'Next Week' : weekOffset === -1 ? 'Last Week' : ''}
            </div>
          </div>
          <IconButton
            aria-label="Next week"
            onClick={() => setWeekOffset((w) => w + 1)}
            className="bg-surface-2 rounded-xl"
          >
            <ChevronRight size={20} className="text-ink-2" />
          </IconButton>
        </div>

        {/* Summary stats */}
        {plan && (
          <div className="grid grid-cols-3 gap-2">
            <Card className="p-2.5 text-center">
              <div className="text-head font-mono font-bold text-ink-1 tabular-nums">
                {plan.plannedWorkDays}
              </div>
              <div className="text-meta text-ink-3 font-medium">Work Days</div>
            </Card>
            <Card className="p-2.5 text-center">
              <div className="text-head font-mono font-bold text-ink-1 tabular-nums">
                {formatMinutesAsHours(plan.plannedTotalMinutes)}
              </div>
              <div className="text-meta text-ink-3 font-medium">Total Hours</div>
            </Card>
            <Card
              className={clsx('p-2.5 text-center', plan.plannedOvertimeMinutes > 0 && 'border-warn')}
            >
              <div
                className={clsx(
                  'text-head font-mono font-bold tabular-nums',
                  plan.plannedOvertimeMinutes > 0 ? 'text-warn' : 'text-ink-1',
                )}
              >
                {plan.plannedOvertimeMinutes > 0 ? formatMinutesAsHours(plan.plannedOvertimeMinutes) : '--'}
              </div>
              <div className="text-meta text-ink-3 font-medium">Overtime</div>
            </Card>
          </div>
        )}

        {/* Content */}
        {isLoading ? (
          <Skeleton variant="tile" count={5} />
        ) : isError ? (
          // A failed fetch is not "no schedule published" — saying the second
          // when the first happened sends a worker to a shift that may not be
          // theirs, or away from one that is.
          <EmptyState
            tone="error"
            icon={<Clock size={22} />}
            title="Could not load schedule"
            description="Please try again later"
          />
        ) : !plan || sortedEntries.length === 0 ? (
          <EmptyState
            icon={<CalendarOff size={22} />}
            title="No schedule published"
            description="Your schedule for this week has not been published yet"
            action={
              <button
                type="button"
                onClick={() => setWeekOffset(0)}
                className="text-body font-semibold text-acc min-h-touch touch-feedback"
              >
                Go to this week
              </button>
            }
          />
        ) : (
          <div className="space-y-3">
            {/* Mini day indicator bar */}
            <div className="flex gap-1.5 mb-1">
              {sortedEntries.map((entry) => {
                const dayIndex = new Date(entry.date).getDay();
                const adjustedIndex = dayIndex === 0 ? 6 : dayIndex - 1;
                const today = isToday(entry.date);
                const config = ENTRY_TYPE_CONFIG[entry.entryType] || ENTRY_TYPE_CONFIG.off;
                return (
                  <div key={entry.id} className="flex-1 text-center">
                    <div
                      className={clsx('text-meta font-bold mb-1', today ? 'text-acc' : 'text-ink-3')}
                    >
                      {DAY_NAMES[adjustedIndex]}
                    </div>
                    {/* Today's bar sits at full strength; the rest of the week
                        is dimmed, which is what the light/dark blue pair was
                        doing before the legacy palette went. */}
                    <div
                      className={clsx('h-1.5 rounded-full', config.barColor, !today && 'opacity-60')}
                    />
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
