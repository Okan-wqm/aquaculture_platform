/**
 * Wall clock ↔ instant in a named IANA time zone, with `Intl` only.
 *
 * WHY: a range the user picks ("12 Sep 14:00 – 19 Sep 08:00") is a wall-clock
 * reading in the zone the chart is shown in — the site's, not the browser's.
 * `Date` only knows the browser zone and UTC, so a picker built on it shifts
 * the range by the difference between the two, and once a year it lands an
 * hour off at a daylight-saving change. Everything here takes the zone as an
 * argument; nothing reads the browser zone.
 *
 * Disambiguation follows Temporal's `'compatible'`: a wall-clock time that
 * does not exist (spring-forward gap) moves forward by the gap; one that
 * occurs twice (fall-back overlap) is the earlier of the two.
 */

/** A calendar day: month is 1–12. */
export interface CivilDate {
  readonly year: number;
  readonly month: number;
  readonly day: number;
}

/** A wall-clock reading: a calendar day plus hour (0–23) and minute. */
export interface WallClock extends CivilDate {
  readonly hour: number;
  readonly minute: number;
}

const DAY_MS = 86_400_000;
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timeZone);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
    formatters.set(timeZone, formatter);
  }
  return formatter;
}

/** Whether `timeZone` is an IANA zone this runtime knows. */
export function isValidTimeZone(timeZone: string): boolean {
  try {
    formatterFor(timeZone);
    return true;
  } catch {
    return false;
  }
}

function partsAt(ms: number, timeZone: string): WallClock & { second: number } {
  const values: Record<string, number> = {};
  for (const part of formatterFor(timeZone).formatToParts(ms)) {
    if (part.type !== 'literal') {
      values[part.type] = Number(part.value);
    }
  }
  return {
    year: values['year'] ?? Number.NaN,
    month: values['month'] ?? Number.NaN,
    day: values['day'] ?? Number.NaN,
    hour: values['hour'] ?? Number.NaN,
    minute: values['minute'] ?? Number.NaN,
    second: values['second'] ?? Number.NaN,
  };
}

/** The wall clock in `timeZone` at the instant `ms`. */
export function wallClockAt(ms: number, timeZone: string): WallClock {
  const { year, month, day, hour, minute } = partsAt(ms, timeZone);
  return { year, month, day, hour, minute };
}

/** The zone's offset from UTC at the instant `ms`, in milliseconds. */
function offsetAt(ms: number, timeZone: string): number {
  const parts = partsAt(ms, timeZone);
  const asUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
  return asUtc - (ms - (((ms % 1000) + 1000) % 1000));
}

function sameWallClock(a: WallClock, b: WallClock): boolean {
  return (
    a.year === b.year &&
    a.month === b.month &&
    a.day === b.day &&
    a.hour === b.hour &&
    a.minute === b.minute
  );
}

/** The instant a wall-clock reading in `timeZone` names (see disambiguation above). */
export function instantOfWallClock(wall: WallClock, timeZone: string): number {
  const asUtc = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute);
  // The offsets a day either side bracket any transition on that day.
  const before = offsetAt(asUtc - DAY_MS, timeZone);
  const after = offsetAt(asUtc + DAY_MS, timeZone);
  const matches = [asUtc - before, asUtc - after]
    .filter((candidate) => sameWallClock(wallClockAt(candidate, timeZone), wall))
    .sort((a, b) => a - b);
  // A gap has no match: keep the offset in force before it, which moves the
  // reading forward by the gap's length.
  return matches[0] ?? asUtc - before;
}

/** The calendar day in `timeZone` at the instant `ms`. */
export function civilDateAt(ms: number, timeZone: string): CivilDate {
  const { year, month, day } = wallClockAt(ms, timeZone);
  return { year, month, day };
}

/** `date` moved by `days` calendar days (zone-free civil arithmetic). */
export function addDays(date: CivilDate, days: number): CivilDate {
  const moved = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
  return { year: moved.getUTCFullYear(), month: moved.getUTCMonth() + 1, day: moved.getUTCDate() };
}

/** The first day of `date`'s month moved by `months`. */
export function addMonths(date: CivilDate, months: number): CivilDate {
  const moved = new Date(Date.UTC(date.year, date.month - 1 + months, 1));
  return { year: moved.getUTCFullYear(), month: moved.getUTCMonth() + 1, day: 1 };
}

/** Day of week, 0 = Sunday. */
export function weekdayOf(date: CivilDate): number {
  return new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay();
}

/** Negative, zero or positive as `a` is before, equal to or after `b`. */
export function compareCivilDates(a: CivilDate, b: CivilDate): number {
  return Date.UTC(a.year, a.month - 1, a.day) - Date.UTC(b.year, b.month - 1, b.day);
}

/** `yyyy-mm-dd`, for keys and `<input type="date">`-style values. */
export function civilDateKey(date: CivilDate): string {
  return `${String(date.year).padStart(4, '0')}-${String(date.month).padStart(2, '0')}-${String(
    date.day,
  ).padStart(2, '0')}`;
}
