const FEEDING_TIMEZONE_BRAND: unique symbol = Symbol('FEEDING_TIMEZONE_BRAND');

/** Canonical IANA timezone admitted by the feeding scheduling authority. */
export type FeedingTimezone = string & {
  readonly [FEEDING_TIMEZONE_BRAND]: 'canonical-iana-timezone';
};

export const FEEDING_LOCAL_TIME_POLICY_V1 = Object.freeze({
  schemaVersion: 'feeding-local-time-policy/v1',
  nonexistentLocalTime: 'next_valid_instant',
  ambiguousLocalTime: 'earlier_instant',
} as const);

/** Shared admission bound for assignment-level meal wall-time displacement. */
export const FEEDING_MAX_ABSOLUTE_MEAL_TIME_OFFSET_MINUTES = 12 * 60;

export class FeedingTimezoneValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FeedingTimezoneValidationError';
  }
}

const LOCAL_DATE_PATTERN = /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])$/;
const LOCAL_TIME_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const MINUTES_IN_DAY = 24 * 60;
const DAY_MS = 24 * 60 * 60 * 1000;

function assertFiniteInstant(at: Date): void {
  if (Number.isNaN(at.getTime())) {
    throw new FeedingTimezoneValidationError('Feeding clock requires a finite instant');
  }
}

function formatter(timezone: FeedingTimezone, includeTime: boolean): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat('en-US-u-ca-iso8601-nu-latn', {
    timeZone: timezone,
    calendar: 'iso8601',
    numberingSystem: 'latn',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    ...(includeTime
      ? {
          hour: '2-digit' as const,
          minute: '2-digit' as const,
          second: '2-digit' as const,
          hourCycle: 'h23' as const,
          weekday: 'short' as const,
        }
      : {}),
  });
}

/**
 * The sole raw-string admission boundary for feeding timezones.
 *
 * Aliases are rejected rather than silently canonicalized because scheduler
 * cuts are content-addressed in PostgreSQL before Node reads them. Accepting
 * two spellings for one zone would give the two verifiers different bytes.
 */
export function compileFeedingTimezone(value: unknown): FeedingTimezone {
  if (typeof value !== 'string' || value.length < 1 || value.length > 64) {
    throw new FeedingTimezoneValidationError('Feeding timezone must be a bounded IANA name');
  }
  let resolved: string;
  try {
    resolved = new Intl.DateTimeFormat('en-US', { timeZone: value }).resolvedOptions().timeZone;
  } catch {
    throw new FeedingTimezoneValidationError(`Unsupported feeding timezone ${value}`);
  }
  if (resolved !== value) {
    throw new FeedingTimezoneValidationError(
      `Feeding timezone ${value} is an alias; the canonical value is ${resolved}`,
    );
  }
  return value as FeedingTimezone;
}

export const FEEDING_UTC_TIMEZONE = compileFeedingTimezone('UTC');

export interface FeedingClockSnapshot {
  readonly at: Date;
  readonly timezone: FeedingTimezone;
  readonly localDate: string;
  readonly localTime: string;
  readonly localWeekday: 1 | 2 | 3 | 4 | 5 | 6 | 7;
}

function partMap(at: Date, timezone: FeedingTimezone): ReadonlyMap<string, string> {
  assertFiniteInstant(at);
  return new Map(
    formatter(timezone, true)
      .formatToParts(at)
      .map((part) => [part.type, part.value]),
  );
}

/** Deterministic calendar projection from an explicit instant and timezone. */
export function feedingClockSnapshot(at: Date, timezone: FeedingTimezone): FeedingClockSnapshot {
  const values = partMap(at, timezone);
  const year = values.get('year');
  const month = values.get('month');
  const day = values.get('day');
  const hour = values.get('hour');
  const minute = values.get('minute');
  const weekdayName = values.get('weekday');
  const weekdayByName: Readonly<Record<string, FeedingClockSnapshot['localWeekday']>> =
    Object.freeze({ Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 });
  const localWeekday = weekdayName ? weekdayByName[weekdayName] : undefined;
  if (!year || !month || !day || !hour || !minute || !localWeekday) {
    throw new FeedingTimezoneValidationError(`Unable to project feeding clock in ${timezone}`);
  }
  return Object.freeze({
    at,
    timezone,
    localDate: `${year}-${month}-${day}`,
    localTime: `${hour}:${minute}`,
    localWeekday,
  });
}

export function feedingCalendarDay(at: Date, timezone: FeedingTimezone): string {
  return feedingClockSnapshot(at, timezone).localDate;
}

function parseLocalDate(localDate: string): readonly [number, number, number] {
  if (!LOCAL_DATE_PATTERN.test(localDate)) {
    throw new FeedingTimezoneValidationError(`Invalid feeding local date ${localDate}`);
  }
  const parts = localDate.split('-').map(Number);
  const year = parts[0];
  const month = parts[1];
  const day = parts[2];
  if (year === undefined || month === undefined || day === undefined) {
    throw new FeedingTimezoneValidationError(`Invalid feeding local date ${localDate}`);
  }
  const candidate = new Date(Date.UTC(year, month - 1, day));
  if (candidate.toISOString().slice(0, 10) !== localDate) {
    throw new FeedingTimezoneValidationError(`Nonexistent feeding local date ${localDate}`);
  }
  return [year, month, day];
}

function parseLocalTime(localTime: string): readonly [number, number] {
  if (!LOCAL_TIME_PATTERN.test(localTime)) {
    throw new FeedingTimezoneValidationError(`Invalid feeding local time ${localTime}`);
  }
  const parts = localTime.split(':').map(Number);
  const hour = parts[0];
  const minute = parts[1];
  if (hour === undefined || minute === undefined) {
    throw new FeedingTimezoneValidationError(`Invalid feeding local time ${localTime}`);
  }
  return [hour, minute];
}

function timezoneOffsetAt(instantMs: number, timezone: FeedingTimezone): number {
  const values = partMap(new Date(instantMs), timezone);
  const value = (name: string): number => Number(values.get(name));
  const asUtc = Date.UTC(
    value('year'),
    value('month') - 1,
    value('day'),
    value('hour'),
    value('minute'),
    value('second'),
  );
  return asUtc - instantMs;
}

/**
 * Materializes one local feeding time under the immutable DST policy.
 * Ambiguous folds choose the earlier instant; gaps advance by the skipped
 * interval to the first representable instant after the discontinuity.
 */
export function feedingWallTimeToInstant(
  localDate: string,
  localTime: string,
  timezone: FeedingTimezone,
): Date {
  const [year, month, day] = parseLocalDate(localDate);
  const [hour, minute] = parseLocalTime(localTime);
  const utcGuess = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
  const offsets = [
    ...new Set([
      timezoneOffsetAt(utcGuess - DAY_MS, timezone),
      timezoneOffsetAt(utcGuess, timezone),
      timezoneOffsetAt(utcGuess + DAY_MS, timezone),
    ]),
  ];
  const offsetCandidates = offsets.map((offset) => utcGuess - offset);
  const validCandidates = offsetCandidates.filter(
    (candidate) => candidate + timezoneOffsetAt(candidate, timezone) === utcGuess,
  );
  if (validCandidates.length > 0) return new Date(Math.min(...validCandidates));

  const searchStart = Math.min(...offsetCandidates);
  const searchEnd = Math.max(...offsetCandidates);
  const targetMinute = hour * 60 + minute;
  for (let candidate = searchStart; candidate <= searchEnd; candidate += 60_000) {
    const projected = feedingClockSnapshot(new Date(candidate), timezone);
    if (
      projected.localDate === localDate &&
      feedingLocalMinute(projected.localTime) > targetMinute
    ) {
      return new Date(candidate);
    }
  }
  throw new FeedingTimezoneValidationError(
    `Unable to materialize feeding wall time ${localDate} ${localTime} in ${timezone}`,
  );
}

export function feedingLocalMinute(localTime: string): number {
  const [hour, minute] = parseLocalTime(localTime);
  return hour * 60 + minute;
}

export function feedingShiftLocalMinute(
  localTime: string,
  offsetMinutes: number,
): { readonly dayOffset: number; readonly localTime: string } {
  if (!Number.isSafeInteger(offsetMinutes)) {
    throw new FeedingTimezoneValidationError('Feeding local-time offset must be an integer');
  }
  const totalMinutes = feedingLocalMinute(localTime) + offsetMinutes;
  const normalized = ((totalMinutes % MINUTES_IN_DAY) + MINUTES_IN_DAY) % MINUTES_IN_DAY;
  const dayOffset = Math.floor(totalMinutes / MINUTES_IN_DAY);
  const hour = String(Math.floor(normalized / 60)).padStart(2, '0');
  const minute = String(normalized % 60).padStart(2, '0');
  return Object.freeze({ dayOffset, localTime: `${hour}:${minute}` });
}

/** Calendar-only shift for governed subject dates; independent of DST offsets. */
export function feedingShiftLocalDate(localDate: string, dayOffset: number): string {
  if (!Number.isSafeInteger(dayOffset)) {
    throw new FeedingTimezoneValidationError('Feeding local-date offset must be an integer');
  }
  const [year, month, day] = parseLocalDate(localDate);
  const shifted = new Date(Date.UTC(year, month - 1, day + dayOffset));
  return shifted.toISOString().slice(0, 10);
}
