/**
 * Canonical calendar projection for an immutable instant and IANA timezone.
 * Callers own timezone authorization/resolution; this function owns only the
 * byte-stable YYYY-MM-DD projection used by plan and inventory authorities.
 */
export function calendarDateInTimezone(timezone: string, instant: Date): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(instant);
  const values = new Map(parts.map((part) => [part.type, part.value]));
  const year = values.get('year');
  const month = values.get('month');
  const day = values.get('day');
  if (!year || !month || !day) {
    throw new RangeError(`Timezone ${timezone} did not produce a calendar date`);
  }
  return `${year}-${month}-${day}`;
}
