/**
 * TimeRangePicker — a preset ("last 7 days") or a fixed window picked on a
 * calendar with start and end times, in the zone the chart is shown in.
 *
 * Durations, the range shape and its checks come from the shared time-range
 * table (`@aquaculture/shared-contracts`); words from the locale maps. The
 * zone is a required input: the picker never falls back to the browser's.
 *
 * Times name whole minutes: the start is the first instant of its minute, the
 * end the last, so the default 00:00–23:59 covers every selected day fully.
 */
import {
  type RelativePresetKey,
  resolveTimeRange,
  type TimeRangeError,
  type TimeRangeSpec,
} from '@aquaculture/shared-contracts';
import { CalendarClock } from 'lucide-react';
import React, { useId, useState } from 'react';

import { Popover } from '../components/Menu/Popover';
import { useI18n } from '../i18n';
import { RangeCalendar } from './RangeCalendar';
import { useTimeRangeLabels } from './timeRangeLabels';
import {
  type CivilDate,
  civilDateAt,
  compareCivilDates,
  instantOfWallClock,
  wallClockAt,
} from './zonedTime';

const MINUTE_MS = 60_000;

/** Why a draft cannot be applied: a range check, or a day or time not filled in. */
type DraftError = TimeRangeError | 'incomplete';

export interface TimeRangeDataBounds {
  readonly firstMs: number;
  readonly lastMs: number;
}

export interface TimeRangePickerProps {
  value: TimeRangeSpec;
  onChange: (spec: TimeRangeSpec) => void;
  /** The presets this surface offers, shortest first. */
  presets: readonly RelativePresetKey[];
  /** IANA zone the chart is shown in; days and times are read in it. */
  timeZone: string;
  /** First and last stored sample, to mark days without data. */
  dataBounds?: TimeRangeDataBounds | null;
  disabled?: boolean;
  className?: string;
}

interface Draft {
  start: CivilDate | null;
  end: CivilDate | null;
  startTime: string;
  endTime: string;
}

const hhmm = (hour: number, minute: number): string =>
  `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;

function parseHhmm(value: string): { hour: number; minute: number } | null {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value);
  return match ? { hour: Number(match[1]), minute: Number(match[2]) } : null;
}

/** The draft a spec opens the picker with: its window, read in the zone. */
function draftOf(spec: TimeRangeSpec, timeZone: string, nowMs: number): Draft {
  const window = resolveTimeRange(spec, nowMs);
  if (!window.ok) {
    return { start: null, end: null, startTime: '00:00', endTime: '23:59' };
  }
  const start = wallClockAt(window.startMs, timeZone);
  const end = wallClockAt(window.endMs - MINUTE_MS, timeZone);
  return {
    start,
    end,
    startTime: hhmm(start.hour, start.minute),
    endTime: hhmm(end.hour, end.minute),
  };
}

/** The fixed window a complete draft names, or why it cannot be applied. */
function specOf(
  draft: Draft,
  timeZone: string,
  nowMs: number,
): { ok: true; spec: TimeRangeSpec } | { ok: false; error: DraftError } {
  const startTime = parseHhmm(draft.startTime);
  const endTime = parseHhmm(draft.endTime);
  if (draft.start === null || draft.end === null || startTime === null || endTime === null) {
    return { ok: false, error: 'incomplete' };
  }
  const spec: TimeRangeSpec = {
    kind: 'absolute',
    startMs: instantOfWallClock({ ...draft.start, ...startTime }, timeZone),
    endMs: instantOfWallClock({ ...draft.end, ...endTime }, timeZone) + MINUTE_MS,
  };
  const resolved = resolveTimeRange(spec, nowMs);
  return resolved.ok ? { ok: true, spec } : { ok: false, error: resolved.error };
}

export const TimeRangePicker: React.FC<TimeRangePickerProps> = ({
  value,
  onChange,
  presets,
  timeZone,
  dataBounds,
  disabled = false,
  className = '',
}) => {
  const { locale, t } = useI18n();
  const labels = useTimeRangeLabels();
  const ids = useId();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<Draft>(() => draftOf(value, timeZone, Date.now()));
  const [error, setError] = useState<DraftError | null>(null);

  const onOpenChange = (next: boolean): void => {
    if (next) {
      setDraft(draftOf(value, timeZone, Date.now()));
      setError(null);
    }
    setOpen(next);
  };

  const instantFormat = new Intl.DateTimeFormat(locale, {
    timeZone,
    dateStyle: 'medium',
    timeStyle: 'short',
  });
  const triggerLabel =
    value.kind === 'relative'
      ? labels.preset(value.preset)
      : `${instantFormat.format(value.startMs)} – ${instantFormat.format(value.endMs - MINUTE_MS)}`;

  const today = civilDateAt(Date.now(), timeZone);
  const firstDataDay = dataBounds ? civilDateAt(dataBounds.firstMs, timeZone) : null;
  const lastDataDay = dataBounds ? civilDateAt(dataBounds.lastMs, timeZone) : null;
  const describeDay = (day: CivilDate): string | undefined =>
    firstDataDay !== null &&
    lastDataDay !== null &&
    (compareCivilDates(day, firstDataDay) < 0 || compareCivilDates(day, lastDataDay) > 0)
      ? t('timeRange.picker.noData')
      : undefined;

  const selectDay = (day: CivilDate): void => {
    setError(null);
    setDraft((current) => {
      if (current.start === null || current.end !== null) {
        return { ...current, start: day, end: null };
      }
      return compareCivilDates(day, current.start) < 0
        ? { ...current, start: day, end: current.start }
        : { ...current, end: day };
    });
  };

  const apply = (close: () => void): void => {
    const result = specOf(draft, timeZone, Date.now());
    if (!result.ok) {
      setError(result.error);
      return;
    }
    onChange(result.spec);
    close();
  };

  return (
    <Popover
      className={className}
      align="start"
      open={open}
      onOpenChange={onOpenChange}
      aria-label={t('timeRange.picker.open')}
      panelClassName="w-[22rem] sm:w-[38rem]"
      trigger={(props) => (
        <button
          {...props}
          type="button"
          disabled={disabled}
          aria-label={`${t('timeRange.picker.open')}: ${triggerLabel}`}
          className="inline-flex items-center gap-2 rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-sm text-gray-900 hover:bg-gray-50 focus:outline-hidden focus:ring-2 focus:ring-primary-500 disabled:cursor-not-allowed disabled:opacity-50 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100 dark:hover:bg-gray-800"
        >
          <CalendarClock className="h-4 w-4 text-gray-500" aria-hidden="true" />
          <span>{triggerLabel}</span>
        </button>
      )}
    >
      {(close) => (
        <div className="flex flex-col gap-4 p-4 sm:flex-row">
          <div role="group" aria-labelledby={`${ids}-presets`} className="sm:w-40 sm:shrink-0">
            <div id={`${ids}-presets`} className="mb-2 text-xs font-medium text-gray-500">
              {t('timeRange.picker.presets')}
            </div>
            <div className="flex flex-wrap gap-1 sm:flex-col">
              {presets.map((preset) => {
                const current = value.kind === 'relative' && value.preset === preset;
                return (
                  <button
                    key={preset}
                    type="button"
                    aria-pressed={current}
                    onClick={() => {
                      onChange({ kind: 'relative', preset });
                      close();
                    }}
                    className={`rounded px-2 py-1.5 text-left text-sm hover:bg-primary-50 dark:hover:bg-primary-900/30 ${
                      current ? 'font-semibold text-primary-700 dark:text-primary-300' : ''
                    }`}
                  >
                    {labels.preset(preset)}
                  </button>
                );
              })}
            </div>
          </div>
          <div role="group" aria-labelledby={`${ids}-custom`} className="min-w-0 flex-1">
            <div id={`${ids}-custom`} className="mb-2 text-xs font-medium text-gray-500">
              {labels.custom}
            </div>
            <RangeCalendar
              selection={{ start: draft.start, end: draft.end }}
              onSelect={selectDay}
              today={today}
              describeDay={describeDay}
            />
            <p className="mt-2 text-xs text-gray-500" aria-live="polite">
              {draft.start === null
                ? t('timeRange.picker.pickStart')
                : draft.end === null
                  ? t('timeRange.picker.pickEnd')
                  : t('timeRange.picker.timeZone', { zone: timeZone })}
            </p>
            <div className="mt-2 grid grid-cols-2 gap-2">
              <label className="text-xs text-gray-600 dark:text-gray-300">
                {t('timeRange.picker.startTime')}
                <input
                  type="time"
                  step={60}
                  value={draft.startTime}
                  onChange={(event) => {
                    const startTime = event.currentTarget.value;
                    setDraft((current) => ({ ...current, startTime }));
                  }}
                  className="mt-1 block w-full rounded border border-gray-300 px-2 py-1 text-sm dark:border-gray-600 dark:bg-gray-800"
                />
              </label>
              <label className="text-xs text-gray-600 dark:text-gray-300">
                {t('timeRange.picker.endTime')}
                <input
                  type="time"
                  step={60}
                  value={draft.endTime}
                  onChange={(event) => {
                    const endTime = event.currentTarget.value;
                    setDraft((current) => ({ ...current, endTime }));
                  }}
                  className="mt-1 block w-full rounded border border-gray-300 px-2 py-1 text-sm dark:border-gray-600 dark:bg-gray-800"
                />
              </label>
            </div>
            {error !== null && (
              <p role="alert" className="mt-2 text-sm text-error-600 dark:text-error-400">
                {error === 'incomplete' ? t('timeRange.picker.incomplete') : labels.error(error)}
              </p>
            )}
            <div className="mt-3 flex justify-end gap-2">
              <button
                type="button"
                onClick={close}
                className="rounded px-3 py-1.5 text-sm hover:bg-gray-100 dark:hover:bg-gray-700"
              >
                {t('common.cancel')}
              </button>
              <button
                type="button"
                disabled={draft.start === null || draft.end === null}
                onClick={() => apply(close)}
                className="rounded bg-primary-600 px-3 py-1.5 text-sm text-white hover:bg-primary-700 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {labels.apply}
              </button>
            </div>
          </div>
        </div>
      )}
    </Popover>
  );
};
