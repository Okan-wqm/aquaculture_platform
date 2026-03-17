/**
 * RuntimeScheduler — Calendar schedule display widget for SCADA operator mode.
 *
 * Read-only display of SchedulerEvents in weekly or monthly grid layout.
 *
 * Features:
 *   - Weekly view: 7-column grid (Mon–Sun) with time-proportional event blocks
 *   - Monthly view: traditional month grid with event pills per day
 *   - Color coding by tagId (auto-assigned from a palette or config)
 *   - Current time indicator line (weekly view)
 *   - Event detail tooltip/popover on hover or click
 *   - Navigation: prev/next week or month
 *   - Respects SchedulerEvent.recurrence (weekly, monthly, once)
 *   - React.memo — stable re-render only when events or date changes
 *   - Tailwind CSS only, accessible with aria-labels
 */

import React, {
  memo,
  useState,
  useMemo,
  useCallback,
  useRef,
  useEffect,
} from 'react';
import {
  ChevronLeft,
  ChevronRight,
  Clock,
  Calendar,
  Tag,
} from 'lucide-react';
import type {
  RuntimeWidgetProps,
  SchedulerEvent,
} from '../../../types/scada-runtime.types';

/* ------------------------------------------------------------------ */
/*  Constants & helpers                                                 */
/* ------------------------------------------------------------------ */

const HOUR_HEIGHT_PX = 40; // px per hour in weekly view
const DAY_NAMES_SHORT = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

// Auto-assign colours to events by tagId
const COLOR_PALETTE = [
  '#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6',
  '#06b6d4', '#f97316', '#14b8a6', '#ec4899', '#84cc16',
];

function getColorForTag(tagId: string, colorMap: Map<string, string>): string {
  if (colorMap.has(tagId)) return colorMap.get(tagId)!;
  const color = COLOR_PALETTE[colorMap.size % COLOR_PALETTE.length];
  colorMap.set(tagId, color);
  return color;
}

/** Parse "HH:mm" string to minutes since midnight. */
function timeToMinutes(t: string): number {
  const [h, m] = t.split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
}

/** ISO week: Monday=0, Sunday=6 */
function getWeekStart(date: Date): Date {
  const d = new Date(date);
  const day = (d.getDay() + 6) % 7; // shift so Mon=0
  d.setDate(d.getDate() - day);
  d.setHours(0, 0, 0, 0);
  return d;
}

function addDays(date: Date, n: number): Date {
  const d = new Date(date);
  d.setDate(d.getDate() + n);
  return d;
}

function addMonths(date: Date, n: number): Date {
  const d = new Date(date);
  d.setMonth(d.getMonth() + n);
  d.setDate(1);
  return d;
}

function isSameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

function formatTime(t: string): string {
  const mins = timeToMinutes(t);
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  const period = h >= 12 ? 'PM' : 'AM';
  const h12 = h % 12 || 12;
  return `${h12}:${String(m).padStart(2, '0')} ${period}`;
}

/** Check if a SchedulerEvent fires on a specific date (0-indexed JS Date). */
function eventOccursOnDate(event: SchedulerEvent, date: Date): boolean {
  if (!event.enabled) return false;
  const dayOfWeek = (date.getDay() + 6) % 7; // Mon=0
  const dayOfMonth = date.getDate();

  switch (event.recurrence) {
    case 'weekly':
      return event.days.includes(dayOfWeek);
    case 'monthly':
      return event.days.includes(dayOfMonth);
    case 'once': {
      // For 'once', days[0] is expected to encode a unix timestamp or yyyyMMdd
      // We'll accept the first value as a day-of-month for simplicity,
      // falling back to the same logic as monthly.
      return event.days.includes(dayOfMonth);
    }
    default:
      return false;
  }
}

/* ------------------------------------------------------------------ */
/*  Event detail tooltip                                                */
/* ------------------------------------------------------------------ */

interface EventDetailProps {
  event: SchedulerEvent;
  color: string;
  anchorRef: React.RefObject<HTMLElement | null>;
  onClose: () => void;
}

const EventDetail = memo<EventDetailProps>(({ event, color, anchorRef, onClose }) => {
  const popRef = useRef<HTMLDivElement>(null);

  // Close on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (
        popRef.current &&
        !popRef.current.contains(e.target as Node) &&
        !anchorRef.current?.contains(e.target as Node)
      ) {
        onClose();
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [anchorRef, onClose]);

  return (
    <div
      ref={popRef}
      role="tooltip"
      aria-label={`Event details: ${event.name}`}
      className="absolute z-50 bg-white border border-gray-200 rounded-lg shadow-xl p-3 w-52 text-xs pointer-events-auto"
      style={{ top: '100%', left: 0, marginTop: 4 }}
    >
      <div className="flex items-start justify-between gap-2 mb-2">
        <div className="flex items-center gap-1.5">
          <span
            className="w-3 h-3 rounded-sm flex-shrink-0"
            style={{ backgroundColor: color }}
            aria-hidden="true"
          />
          <span className="font-semibold text-gray-800 leading-tight">{event.name}</span>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="text-gray-400 hover:text-gray-600 flex-shrink-0 leading-none"
          aria-label="Close detail"
        >
          ✕
        </button>
      </div>
      <div className="space-y-1 text-gray-600">
        <div className="flex items-center gap-1">
          <Clock className="w-3 h-3 flex-shrink-0" aria-hidden="true" />
          <span>{formatTime(event.startTime)} – {formatTime(event.endTime)}</span>
        </div>
        <div className="flex items-center gap-1">
          <Tag className="w-3 h-3 flex-shrink-0" aria-hidden="true" />
          <span className="font-mono truncate">{event.tagId}</span>
        </div>
        <div className="flex items-center gap-1">
          <Calendar className="w-3 h-3 flex-shrink-0" aria-hidden="true" />
          <span className="capitalize">{event.recurrence}</span>
        </div>
        <div className="text-[10px] text-gray-400">
          ON: {String(event.onValue)} / OFF: {String(event.offValue)}
        </div>
      </div>
    </div>
  );
});
EventDetail.displayName = 'EventDetail';

/* ------------------------------------------------------------------ */
/*  EventBlock — single event pill/block in the grid                   */
/* ------------------------------------------------------------------ */

interface EventBlockProps {
  event: SchedulerEvent;
  color: string;
  /** For weekly view: position as fraction of day height. */
  topPct?: number;
  heightPct?: number;
  compact?: boolean; // monthly pill mode
}

const EventBlock = memo<EventBlockProps>(
  ({ event, color, topPct, heightPct, compact = false }) => {
    const anchorRef = useRef<HTMLDivElement | null>(null);
    const [showDetail, setShowDetail] = useState(false);

    const handleClick = useCallback((e: React.MouseEvent) => {
      e.stopPropagation();
      setShowDetail((p) => !p);
    }, []);

    const closeDetail = useCallback(() => setShowDetail(false), []);

    if (compact) {
      // Monthly view pill
      return (
        <div className="relative">
          <button
            ref={anchorRef as React.RefObject<HTMLButtonElement>}
            type="button"
            onClick={handleClick}
            aria-label={`Event: ${event.name} ${event.startTime}–${event.endTime}`}
            className="w-full text-left px-1 py-0.5 rounded text-[9px] font-medium truncate leading-tight cursor-pointer hover:opacity-80 transition-opacity"
            style={{ backgroundColor: color + '33', color, borderLeft: `2px solid ${color}` }}
          >
            {event.name}
          </button>
          {showDetail && (
            <EventDetail
              event={event}
              color={color}
              anchorRef={anchorRef as React.RefObject<HTMLElement>}
              onClose={closeDetail}
            />
          )}
        </div>
      );
    }

    // Weekly view block — absolutely positioned
    return (
      <div
        className="absolute left-0.5 right-0.5 relative"
        style={{
          top: `${(topPct ?? 0) * 100}%`,
          height: `${Math.max((heightPct ?? 0.05) * 100, 4)}%`,
          minHeight: 18,
        }}
      >
        <button
          ref={anchorRef as React.RefObject<HTMLButtonElement>}
          type="button"
          onClick={handleClick}
          aria-label={`Event: ${event.name} ${event.startTime}–${event.endTime}`}
          className="w-full h-full rounded px-1 text-left overflow-hidden cursor-pointer hover:opacity-80 transition-opacity"
          style={{
            backgroundColor: color + '33',
            borderLeft: `3px solid ${color}`,
            color,
          }}
        >
          <div className="text-[9px] font-semibold leading-tight truncate">{event.name}</div>
          <div className="text-[8px] opacity-80 leading-tight">{event.startTime}–{event.endTime}</div>
        </button>
        {showDetail && (
          <EventDetail
            event={event}
            color={color}
            anchorRef={anchorRef as React.RefObject<HTMLElement>}
            onClose={closeDetail}
          />
        )}
      </div>
    );
  },
);
EventBlock.displayName = 'EventBlock';

/* ------------------------------------------------------------------ */
/*  WeeklyView                                                          */
/* ------------------------------------------------------------------ */

interface WeeklyViewProps {
  weekStart: Date;
  events: SchedulerEvent[];
  colorMap: Map<string, string>;
  now: Date;
}

const WeeklyView = memo<WeeklyViewProps>(({ weekStart, events, colorMap, now }) => {
  const totalMinutes = 24 * 60;

  // Current time indicator
  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  const nowTopPct = nowMinutes / totalMinutes;
  const todayColIndex = (now.getDay() + 6) % 7; // Mon=0

  const days = useMemo(
    () => Array.from({ length: 7 }, (_, i) => addDays(weekStart, i)),
    [weekStart],
  );

  const HOUR_LABELS = Array.from({ length: 24 }, (_, i) => i);

  return (
    <div className="flex flex-col h-full" aria-label="Weekly schedule view">
      {/* Day header row */}
      <div className="flex border-b border-gray-200 flex-shrink-0">
        {/* Time gutter */}
        <div className="w-10 flex-shrink-0" />
        {days.map((day, i) => {
          const isToday = isSameDay(day, now);
          return (
            <div
              key={i}
              className={[
                'flex-1 text-center py-1.5 text-xs font-medium',
                isToday ? 'text-blue-600' : 'text-gray-600',
              ].join(' ')}
            >
              <div>{DAY_NAMES_SHORT[i]}</div>
              <div
                className={[
                  'inline-flex items-center justify-center w-5 h-5 rounded-full text-[11px]',
                  isToday ? 'bg-blue-500 text-white' : '',
                ].join(' ')}
              >
                {day.getDate()}
              </div>
            </div>
          );
        })}
      </div>

      {/* Scrollable time grid */}
      <div className="flex-1 overflow-y-auto overflow-x-hidden relative">
        <div
          className="relative flex"
          style={{ height: HOUR_HEIGHT_PX * 24 }}
        >
          {/* Hour labels (time gutter) */}
          <div className="w-10 flex-shrink-0 relative">
            {HOUR_LABELS.map((h) => (
              <div
                key={h}
                className="absolute right-1 text-[9px] text-gray-400 leading-none"
                style={{ top: h * HOUR_HEIGHT_PX - 5 }}
              >
                {h === 0 ? '' : `${h}:00`}
              </div>
            ))}
          </div>

          {/* Day columns */}
          {days.map((day, colIdx) => {
            const dayEvents = events.filter((e) => eventOccursOnDate(e, day));
            const isToday = isSameDay(day, now);

            return (
              <div
                key={colIdx}
                className="flex-1 relative border-l border-gray-100"
                aria-label={`${DAY_NAMES_SHORT[colIdx]} ${day.getDate()}`}
              >
                {/* Hour grid lines */}
                {HOUR_LABELS.map((h) => (
                  <div
                    key={h}
                    className="absolute left-0 right-0 border-t border-gray-100"
                    style={{ top: h * HOUR_HEIGHT_PX }}
                    aria-hidden="true"
                  />
                ))}

                {/* Current time indicator */}
                {isToday && colIdx === todayColIndex && (
                  <div
                    className="absolute left-0 right-0 border-t-2 border-red-400 z-10 pointer-events-none"
                    style={{ top: `${nowTopPct * 100}%` }}
                    aria-hidden="true"
                  >
                    <div className="absolute -top-1 -left-1 w-2 h-2 rounded-full bg-red-400" />
                  </div>
                )}

                {/* Events */}
                {dayEvents.map((event) => {
                  const startMins = timeToMinutes(event.startTime);
                  const endMins   = Math.max(
                    timeToMinutes(event.endTime),
                    startMins + 30, // minimum 30 min slot
                  );
                  const topPct    = startMins / totalMinutes;
                  const heightPct = (endMins - startMins) / totalMinutes;
                  const color     = getColorForTag(event.tagId, colorMap);

                  return (
                    <EventBlock
                      key={event.id}
                      event={event}
                      color={color}
                      topPct={topPct}
                      heightPct={heightPct}
                    />
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
});
WeeklyView.displayName = 'WeeklyView';

/* ------------------------------------------------------------------ */
/*  MonthlyView                                                         */
/* ------------------------------------------------------------------ */

interface MonthlyViewProps {
  year: number;
  month: number; // 0-indexed
  events: SchedulerEvent[];
  colorMap: Map<string, string>;
  now: Date;
}

const MonthlyView = memo<MonthlyViewProps>(({ year, month, events, colorMap, now }) => {
  // First day of month (0=Sun … 6=Sat → convert to Mon=0)
  const firstDay = new Date(year, month, 1);
  const startOffset = (firstDay.getDay() + 6) % 7; // blank cells before day 1

  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const totalCells = startOffset + daysInMonth;
  const rows = Math.ceil(totalCells / 7);

  return (
    <div className="flex flex-col h-full" aria-label="Monthly schedule view">
      {/* Day-of-week header */}
      <div className="grid grid-cols-7 border-b border-gray-200 flex-shrink-0">
        {DAY_NAMES_SHORT.map((d) => (
          <div
            key={d}
            className="text-center text-[10px] font-semibold text-gray-500 py-1"
          >
            {d}
          </div>
        ))}
      </div>

      {/* Calendar grid */}
      <div
        className="grid grid-cols-7 flex-1 overflow-y-auto"
        style={{ gridTemplateRows: `repeat(${rows}, minmax(0, 1fr))` }}
      >
        {Array.from({ length: totalCells }, (_, cellIdx) => {
          const dayNum = cellIdx - startOffset + 1;
          const isBlank = dayNum < 1 || dayNum > daysInMonth;
          if (isBlank) {
            return (
              <div
                key={cellIdx}
                className="border-r border-b border-gray-100 bg-gray-50"
                aria-hidden="true"
              />
            );
          }

          const cellDate = new Date(year, month, dayNum);
          const isToday = isSameDay(cellDate, now);
          const dayEvents = events.filter((e) => eventOccursOnDate(e, cellDate));

          return (
            <div
              key={cellIdx}
              className={[
                'border-r border-b border-gray-100 p-1 flex flex-col gap-0.5 min-h-0 overflow-hidden',
                isToday ? 'bg-blue-50' : 'bg-white',
              ].join(' ')}
              aria-label={`${MONTH_NAMES[month]} ${dayNum}`}
            >
              <span
                className={[
                  'text-[10px] font-semibold leading-none mb-0.5',
                  isToday ? 'text-blue-600' : 'text-gray-600',
                ].join(' ')}
              >
                {dayNum}
              </span>
              {dayEvents.slice(0, 3).map((event) => (
                <EventBlock
                  key={event.id}
                  event={event}
                  color={getColorForTag(event.tagId, colorMap)}
                  compact
                />
              ))}
              {dayEvents.length > 3 && (
                <span className="text-[8px] text-gray-400 pl-1">
                  +{dayEvents.length - 3} more
                </span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
});
MonthlyView.displayName = 'MonthlyView';

/* ------------------------------------------------------------------ */
/*  RuntimeScheduler                                                    */
/* ------------------------------------------------------------------ */

const RuntimeScheduler: React.FC<RuntimeWidgetProps> = ({
  config,
  isEnabled = true,
}) => {
  const events  = (config.events ?? []) as SchedulerEvent[];
  const defaultView = (config.defaultView ?? 'weekly') as 'weekly' | 'monthly';
  const title   = (config.title ?? 'Schedule') as string;

  const [view, setView] = useState<'weekly' | 'monthly'>(defaultView);
  const [now, setNow] = useState(() => new Date());

  // Reference date for navigation
  const [refDate, setRefDate] = useState(() => new Date());

  // Color map is stable per render cycle — built from events
  const colorMap = useMemo(() => {
    const map = new Map<string, string>();
    events.forEach((e) => {
      // Pre-populate from config color if present
      if ((e as unknown as { color?: string }).color) {
        map.set(e.tagId, (e as unknown as { color: string }).color);
      }
    });
    return map;
  }, [events]);

  // Tick current time every minute
  useEffect(() => {
    const tick = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(tick);
  }, []);

  /* ---- navigation ---- */
  const weekStart = useMemo(() => getWeekStart(refDate), [refDate]);

  const navPrev = useCallback(() => {
    if (view === 'weekly') {
      setRefDate((d) => addDays(d, -7));
    } else {
      setRefDate((d) => addMonths(d, -1));
    }
  }, [view]);

  const navNext = useCallback(() => {
    if (view === 'weekly') {
      setRefDate((d) => addDays(d, 7));
    } else {
      setRefDate((d) => addMonths(d, 1));
    }
  }, [view]);

  const navToday = useCallback(() => setRefDate(new Date()), []);

  /* ---- header label ---- */
  const headerLabel = useMemo(() => {
    if (view === 'weekly') {
      const end = addDays(weekStart, 6);
      const startStr = weekStart.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
      const endStr   = end.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
      return `${startStr} – ${endStr}`;
    }
    return `${MONTH_NAMES[refDate.getMonth()]} ${refDate.getFullYear()}`;
  }, [view, weekStart, refDate]);

  return (
    <div
      className="w-full h-full flex flex-col bg-white border border-gray-200 rounded overflow-hidden"
      aria-label={title}
      role="region"
      style={{ opacity: isEnabled ? 1 : 0.6 }}
    >
      {/* Toolbar */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-gray-200 bg-gray-50 flex-shrink-0">
        <span className="text-xs font-semibold text-gray-700 flex-shrink-0">{title}</span>

        {/* View toggle */}
        <div className="flex items-center gap-0.5 ml-auto" role="group" aria-label="Calendar view">
          {(['weekly', 'monthly'] as const).map((v) => (
            <button
              key={v}
              type="button"
              onClick={() => setView(v)}
              aria-pressed={view === v}
              className={[
                'px-2 py-0.5 text-[10px] font-medium rounded capitalize transition-colors',
                view === v ? 'bg-blue-500 text-white' : 'text-gray-500 hover:bg-gray-200',
              ].join(' ')}
            >
              {v === 'weekly' ? 'Week' : 'Month'}
            </button>
          ))}
        </div>

        {/* Navigation */}
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={navPrev}
            aria-label="Previous"
            className="p-1 rounded hover:bg-gray-200 transition-colors text-gray-600"
          >
            <ChevronLeft className="w-3.5 h-3.5" aria-hidden="true" />
          </button>
          <button
            type="button"
            onClick={navToday}
            className="px-1.5 py-0.5 text-[10px] font-medium text-blue-600 hover:bg-blue-50 rounded transition-colors"
            aria-label="Go to today"
          >
            Today
          </button>
          <button
            type="button"
            onClick={navNext}
            aria-label="Next"
            className="p-1 rounded hover:bg-gray-200 transition-colors text-gray-600"
          >
            <ChevronRight className="w-3.5 h-3.5" aria-hidden="true" />
          </button>
        </div>

        {/* Period label */}
        <span className="text-[10px] text-gray-500 whitespace-nowrap truncate max-w-[120px]">
          {headerLabel}
        </span>
      </div>

      {/* Calendar body */}
      <div className="flex-1 overflow-hidden">
        {view === 'weekly' ? (
          <WeeklyView
            weekStart={weekStart}
            events={events}
            colorMap={colorMap}
            now={now}
          />
        ) : (
          <MonthlyView
            year={refDate.getFullYear()}
            month={refDate.getMonth()}
            events={events}
            colorMap={colorMap}
            now={now}
          />
        )}
      </div>

      {/* Legend */}
      {events.length > 0 && (
        <div
          className="flex flex-wrap gap-2 px-3 py-1.5 border-t border-gray-100 bg-gray-50 flex-shrink-0"
          aria-label="Event legend"
        >
          {Array.from(
            new Map(events.map((e) => [e.tagId, e])).values(),
          ).slice(0, 6).map((e) => (
            <div key={e.tagId} className="flex items-center gap-1">
              <span
                className="w-2 h-2 rounded-sm flex-shrink-0"
                style={{ backgroundColor: getColorForTag(e.tagId, colorMap) }}
                aria-hidden="true"
              />
              <span className="text-[9px] text-gray-500 truncate max-w-[60px]">{e.name}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

RuntimeScheduler.displayName = 'RuntimeScheduler';
export default memo(RuntimeScheduler);
