/**
 * Canonical HR calendar-date operations.
 *
 * PostgreSQL `date` values and GraphQL date-only inputs have no time zone.
 * JavaScript Date does, so every calendar operation must use one coordinate
 * system. HR stores and exchanges dates in ISO form; UTC is that system.
 */

function assertValidDate(value: Date): Date {
  if (Number.isNaN(value.getTime())) {
    throw new RangeError('Invalid calendar date');
  }
  return value;
}

export function toUtcCalendarDate(value: Date | string): Date {
  if (typeof value === 'string') {
    const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    if (dateOnly) {
      const year = Number(dateOnly[1]);
      const monthIndex = Number(dateOnly[2]) - 1;
      const day = Number(dateOnly[3]);
      const parsed = new Date(Date.UTC(year, monthIndex, day));
      if (
        parsed.getUTCFullYear() !== year ||
        parsed.getUTCMonth() !== monthIndex ||
        parsed.getUTCDate() !== day
      ) {
        throw new RangeError('Invalid calendar date');
      }
      return parsed;
    }
  }

  const parsed = assertValidDate(new Date(value));
  return new Date(Date.UTC(parsed.getUTCFullYear(), parsed.getUTCMonth(), parsed.getUTCDate()));
}

export function toIsoCalendarDate(value: Date | string): string {
  return toUtcCalendarDate(value).toISOString().slice(0, 10);
}

export function addUtcCalendarDays(value: Date, days: number): Date {
  if (!Number.isInteger(days)) {
    throw new RangeError('Calendar-day increment must be an integer');
  }
  const result = toUtcCalendarDate(value);
  result.setUTCDate(result.getUTCDate() + days);
  return result;
}

export function getUtcCalendarWeekday(value: Date): number {
  return toUtcCalendarDate(value).getUTCDay();
}

export function formatUtcCalendarYearMonth(value: Date | string): string {
  const date = toUtcCalendarDate(value);
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  return `${date.getUTCFullYear()}${month}`;
}
