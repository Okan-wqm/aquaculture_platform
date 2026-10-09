/**
 * RangeCalendar — one month of days for picking the first and last day of a
 * range, operable by keyboard (WAI-ARIA date grid pattern).
 *
 * Days are civil dates of the zone the chart is shown in; the calendar never
 * reads the browser zone. Month and weekday names come from `Intl` in the
 * active locale, so the grid speaks the user's language without a word list.
 */
import { ChevronLeft, ChevronRight } from 'lucide-react';
import React, { useEffect, useId, useMemo, useRef, useState } from 'react';

import { type SupportedLocale, useI18n } from '../i18n';
import {
  addDays,
  addMonths,
  type CivilDate,
  civilDateKey,
  compareCivilDates,
  weekdayOf,
} from './zonedTime';

/** The weekday a week starts on in each locale, 0 = Sunday. */
const FIRST_DAY_OF_WEEK: Readonly<Record<SupportedLocale, number>> = { tr: 1, en: 0 };

export interface RangeCalendarSelection {
  readonly start: CivilDate | null;
  readonly end: CivilDate | null;
}

export interface RangeCalendarProps {
  selection: RangeCalendarSelection;
  onSelect: (day: CivilDate) => void;
  /** Today in the chart's zone; later days cannot be picked. */
  today: CivilDate;
  /** A note read out with a day, e.g. that no data is stored for it. */
  describeDay?: (day: CivilDate) => string | undefined;
}

const utcNoon = (day: CivilDate): number => Date.UTC(day.year, day.month - 1, day.day, 12);
const sameDay = (a: CivilDate | null, b: CivilDate): boolean =>
  a !== null && compareCivilDates(a, b) === 0;

/** The same day `months` months away, clamped to that month's last day. */
function shiftMonths(day: CivilDate, months: number): CivilDate {
  const first = addMonths(day, months);
  const lastDay = new Date(Date.UTC(first.year, first.month, 0)).getUTCDate();
  return { ...first, day: Math.min(day.day, lastDay) };
}

const latest = (day: CivilDate, limit: CivilDate): CivilDate =>
  compareCivilDates(day, limit) > 0 ? { ...limit } : { ...day };

function monthGrid(month: CivilDate, firstDayOfWeek: number): CivilDate[][] {
  const lead = (weekdayOf(month) - firstDayOfWeek + 7) % 7;
  const first = addDays(month, -lead);
  const weeks: CivilDate[][] = [];
  for (let week = 0; week < 6; week += 1) {
    weeks.push(Array.from({ length: 7 }, (_, index) => addDays(first, week * 7 + index)));
  }
  return weeks;
}

export const RangeCalendar: React.FC<RangeCalendarProps> = ({
  selection,
  onSelect,
  today,
  describeDay,
}) => {
  const { locale, t } = useI18n();
  const titleId = useId();
  // A future day is disabled, so it can never hold the grid's tab stop.
  const [focused, setFocused] = useState<CivilDate>(() =>
    latest(selection.end ?? selection.start ?? today, today),
  );
  const [month, setMonth] = useState<CivilDate>(() => addMonths(focused, 0));
  // Each keyboard move asks for focus once; a counter (not a flag) so a move
  // that lands on the same day still asks, and a stale request never lingers.
  const [focusRequest, setFocusRequest] = useState(0);
  const gridRef = useRef<HTMLTableElement>(null);
  const firstDayOfWeek = FIRST_DAY_OF_WEEK[locale];

  const names = useMemo(() => {
    const monthTitle = new Intl.DateTimeFormat(locale, {
      month: 'long',
      year: 'numeric',
      timeZone: 'UTC',
    });
    const fullDate = new Intl.DateTimeFormat(locale, { dateStyle: 'full', timeZone: 'UTC' });
    const weekdayShort = new Intl.DateTimeFormat(locale, { weekday: 'short', timeZone: 'UTC' });
    const weekdayLong = new Intl.DateTimeFormat(locale, { weekday: 'long', timeZone: 'UTC' });
    return { monthTitle, fullDate, weekdayShort, weekdayLong };
  }, [locale]);

  const weeks = useMemo(() => monthGrid(month, firstDayOfWeek), [month, firstDayOfWeek]);

  // Keyboard moves focus to a day that may sit in another month: follow it,
  // then focus its button once rendered.
  const handledRequest = useRef(0);
  useEffect(() => {
    if (focusRequest === handledRequest.current) return;
    handledRequest.current = focusRequest;
    gridRef.current
      ?.querySelector<HTMLButtonElement>(`[data-day="${civilDateKey(focused)}"]`)
      ?.focus();
  }, [focusRequest, focused]);

  const moveFocus = (day: CivilDate): void => {
    const target = latest(day, today);
    setFocused(target);
    setFocusRequest((request) => request + 1);
    if (target.year !== month.year || target.month !== month.month) {
      setMonth(addMonths(target, 0));
    }
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLTableElement>): void => {
    const lead = (weekdayOf(focused) - firstDayOfWeek + 7) % 7;
    const moves: Record<string, () => CivilDate> = {
      ArrowLeft: () => addDays(focused, -1),
      ArrowRight: () => addDays(focused, 1),
      ArrowUp: () => addDays(focused, -7),
      ArrowDown: () => addDays(focused, 7),
      Home: () => addDays(focused, -lead),
      End: () => addDays(focused, 6 - lead),
      PageUp: () => shiftMonths(focused, event.shiftKey ? -12 : -1),
      PageDown: () => shiftMonths(focused, event.shiftKey ? 12 : 1),
    };
    const move = moves[event.key];
    if (move === undefined) return;
    event.preventDefault();
    moveFocus(move());
  };

  const inRange = (day: CivilDate): boolean =>
    selection.start !== null &&
    selection.end !== null &&
    compareCivilDates(day, selection.start) >= 0 &&
    compareCivilDates(day, selection.end) <= 0;

  const canGoForward = compareCivilDates(addMonths(month, 1), today) <= 0;

  // The month buttons keep a roving tab stop inside the shown month.
  const showMonth = (next: CivilDate): void => {
    setMonth(next);
    setFocused(next);
  };

  return (
    <div className="w-full">
      <div className="mb-2 flex items-center justify-between">
        <button
          type="button"
          className="rounded p-1 hover:bg-gray-100 dark:hover:bg-gray-700"
          aria-label={t('timeRange.picker.prevMonth')}
          onClick={() => showMonth(addMonths(month, -1))}
        >
          <ChevronLeft className="h-4 w-4" aria-hidden="true" />
        </button>
        <div id={titleId} className="text-sm font-semibold" aria-live="polite">
          {names.monthTitle.format(utcNoon(month))}
        </div>
        <button
          type="button"
          className="rounded p-1 hover:bg-gray-100 disabled:opacity-40 dark:hover:bg-gray-700"
          aria-label={t('timeRange.picker.nextMonth')}
          disabled={!canGoForward}
          onClick={() => showMonth(addMonths(month, 1))}
        >
          <ChevronRight className="h-4 w-4" aria-hidden="true" />
        </button>
      </div>
      <table
        ref={gridRef}
        role="grid"
        aria-labelledby={titleId}
        aria-multiselectable="true"
        className="w-full border-collapse text-center text-sm"
        onKeyDown={onKeyDown}
      >
        <thead>
          <tr>
            {(weeks[0] ?? []).map((day) => (
              <th
                key={civilDateKey(day)}
                scope="col"
                abbr={names.weekdayLong.format(utcNoon(day))}
                className="py-1 text-xs font-medium text-gray-500 dark:text-gray-400"
              >
                {names.weekdayShort.format(utcNoon(day))}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {weeks.map((week) => (
            <tr key={civilDateKey(week[0] ?? month)}>
              {week.map((day) => {
                const key = civilDateKey(day);
                const outside = day.month !== month.month;
                const future = compareCivilDates(day, today) > 0;
                const edge = sameDay(selection.start, day) || sameDay(selection.end, day);
                const within = inRange(day);
                // What a screen reader hears: the date, its place in the
                // selection, and any note (no data stored). Joined through the
                // locale, never with punctuation written here.
                const notes = [
                  sameDay(selection.start, day)
                    ? t('timeRange.picker.rangeStart')
                    : sameDay(selection.end, day)
                      ? t('timeRange.picker.rangeEnd')
                      : within
                        ? t('timeRange.picker.inRange')
                        : undefined,
                  describeDay?.(day),
                ].filter((entry): entry is string => entry !== undefined);
                const note = describeDay?.(day);
                const label = notes.reduce(
                  (text, entry) => t('timeRange.picker.dayNote', { day: text, note: entry }),
                  names.fullDate.format(utcNoon(day)),
                );
                return (
                  <td key={key} role="gridcell" aria-selected={edge || within}>
                    <button
                      type="button"
                      data-day={key}
                      tabIndex={sameDay(focused, day) ? 0 : -1}
                      disabled={future}
                      aria-label={label}
                      aria-current={sameDay(today, day) ? 'date' : undefined}
                      onClick={() => {
                        setFocused(day);
                        onSelect(day);
                      }}
                      className={[
                        'h-9 w-9 rounded-md transition-colors',
                        edge ? 'bg-primary-600 text-white' : '',
                        within && !edge ? 'bg-primary-100 dark:bg-primary-900/40' : '',
                        !edge && !within ? 'hover:bg-gray-100 dark:hover:bg-gray-700' : '',
                        outside && !edge ? 'text-gray-400 dark:text-gray-500' : '',
                        note && !edge ? 'opacity-60' : '',
                        future ? 'cursor-not-allowed opacity-30' : '',
                      ].join(' ')}
                    >
                      {day.day}
                    </button>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};
