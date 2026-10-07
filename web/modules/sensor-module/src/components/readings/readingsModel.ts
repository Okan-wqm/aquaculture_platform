/**
 * Pure view-model helpers for /sensor/readings (SENSOR-HIGH-138). No React —
 * the formatting, freshness and export rules live here so they are tested
 * once and the page/cards only render.
 */
import {
  type RelativePresetKey,
  resolveTimeRange,
  type TimeRangeSpec,
} from '@aquaculture/shared-contracts';

import type { ChannelLatestValue, ChannelSeriesResponse } from '../../graphql/channelReadings';
import type { RegisteredSensor } from '../../hooks/useSensorList';

/** A value older than this is "stale": the device has stopped reporting. */
export const FRESH_WINDOW_MS = 5 * 60 * 1000;

export type Freshness = 'live' | 'stale' | 'none';

/**
 * The relative ranges the readings page offers. Durations and words come
 * from the shared time-range table (`@aquaculture/shared-contracts`) and the
 * locale maps; this list only chooses which presets the page shows.
 */
export const READINGS_PRESETS = [
  '1h',
  '6h',
  '24h',
  '7d',
  '30d',
  '90d',
  '365d',
] as const satisfies readonly RelativePresetKey[];

export type ReadingsPreset = (typeof READINGS_PRESETS)[number];

export const DEFAULT_READINGS_PRESET: ReadingsPreset = '24h';

/** A readings preset from untrusted input (a select's value), or null. */
export function parseReadingsPreset(value: unknown): ReadingsPreset | null {
  return READINGS_PRESETS.find((preset) => preset === value) ?? null;
}

/**
 * The sensors whose channels carry the data: parents and standalone sensors.
 * A child row (parentId set) mirrors one of its parent's channels for the
 * registration UI; ingestion reads the parent's channels (SENSOR-HIGH-117), so
 * rendering children too would show every parameter twice.
 */
export function readingOwners(sensors: readonly RegisteredSensor[]): RegisteredSensor[] {
  return sensors.filter((sensor) => !sensor.parentId);
}

/** The newest channel time of a sensor, or null when nothing has reported. */
export function lastReportedAt(channels: readonly ChannelLatestValue[]): number | null {
  let newest: number | null = null;
  for (const channel of channels) {
    if (!channel.time) continue;
    const time = new Date(channel.time).getTime();
    if (Number.isFinite(time) && (newest === null || time > newest)) newest = time;
  }
  return newest;
}

export function freshness(lastAt: number | null, now: number): Freshness {
  if (lastAt === null) return 'none';
  return now - lastAt <= FRESH_WINDOW_MS ? 'live' : 'stale';
}

/** Render a channel value with the channel's own precision (default 2). */
export function formatValue(channel: Pick<ChannelLatestValue, 'value' | 'precision'>): string {
  if (channel.value === null || channel.value === undefined) return '—';
  const digits = channel.precision ?? 2;
  return channel.value.toLocaleString('tr-TR', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

export function unitOf(channel: Pick<ChannelLatestValue, 'unitSymbol' | 'unit'>): string {
  return channel.unitSymbol ?? channel.unit ?? '';
}

/** "12 sn önce" / "3 dk önce" / "2 sa önce" / a date for anything older. */
export function formatAge(time: string | null | undefined, now: number): string {
  if (!time) return 'Veri yok';
  const at = new Date(time).getTime();
  if (!Number.isFinite(at)) return 'Veri yok';
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 60) return `${seconds} sn önce`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} dk önce`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} sa önce`;
  return new Date(at).toLocaleString('tr-TR');
}

export const ALERT_LABELS: Readonly<Record<'NORMAL' | 'WARNING' | 'CRITICAL', string>> = {
  NORMAL: 'Normal',
  WARNING: 'Uyarı',
  CRITICAL: 'Kritik',
};

/** Distinct channel keys present, labelled by their first display label. */
export function channelFilterOptions(
  channels: readonly ChannelLatestValue[],
): Array<{ value: string; label: string }> {
  const labels = new Map<string, string>();
  for (const channel of channels) {
    if (!labels.has(channel.channelKey)) labels.set(channel.channelKey, channel.displayLabel);
  }
  return [...labels.entries()]
    .map(([value, label]) => ({ value, label }))
    .sort((a, b) => a.label.localeCompare(b.label, 'tr'));
}

/** How a spreadsheet in the user's language reads a CSV: field separator and decimal mark. */
export interface CsvFormat {
  readonly separator: ';' | ',';
  readonly decimal: ',' | '.';
}

/** Turkish spreadsheets split on `;` and read `,` as the decimal mark; English ones the reverse. */
export function csvFormatFor(locale: string): CsvFormat {
  return locale.startsWith('tr')
    ? { separator: ';', decimal: ',' }
    : { separator: ',', decimal: '.' };
}

/** A CSV field: text, or a number written with the locale's decimal mark at full precision. */
type CsvField = string | number | null | undefined;

function csvCell(field: CsvField, format: CsvFormat): string {
  if (field === null || field === undefined) return '';
  if (typeof field === 'number') {
    return format.decimal === ',' ? String(field).replace('.', ',') : String(field);
  }
  // A spreadsheet runs a cell that starts with = + - @ (or a tab or return)
  // as a formula; sensor names, labels and units are typed by tenants, so
  // such text is written as text.
  const text = /^[=+\-@\t\r]/.test(field) ? `'${field}` : field;
  return text.includes('"') || text.includes(format.separator) || /[\r\n]/.test(text)
    ? `"${text.replace(/"/g, '""')}"`
    : text;
}

function csvText(rows: readonly CsvField[][], format: CsvFormat): string {
  return rows
    .map((row) => row.map((field) => csvCell(field, format)).join(format.separator))
    .join('\n');
}

/**
 * The current values as CSV, one row per channel, in the user's spreadsheet
 * format (separator and decimal mark) with full precision.
 */
export function latestValuesCsv(
  sensors: readonly RegisteredSensor[],
  bySensor: ReadonlyMap<string, readonly ChannelLatestValue[]>,
  locale: string,
): string {
  const rows: CsvField[][] = [['Cihaz', 'Kanal', 'Anahtar', 'Değer', 'Birim', 'Zaman', 'Durum']];
  for (const sensor of sensors) {
    for (const channel of bySensor.get(sensor.id) ?? []) {
      rows.push([
        sensor.name,
        channel.displayLabel,
        channel.channelKey,
        channel.value,
        unitOf(channel),
        channel.time ?? '',
        channel.alertLevel ? ALERT_LABELS[channel.alertLevel] : '',
      ]);
    }
  }
  return csvText(rows, csvFormatFor(locale));
}

/**
 * The window to jump to when a range holds no data: the same length as the
 * range shown, ending with the minute of the channel's last stored sample.
 */
export function rangeEndingAt(
  lastSampleMs: number,
  current: TimeRangeSpec,
  nowMs: number,
): TimeRangeSpec {
  const shown = resolveTimeRange(current, nowMs);
  if (!shown.ok) {
    throw new Error(`The range shown is not valid: ${shown.error}`);
  }
  const endMs = Math.floor(lastSampleMs / 60_000) * 60_000 + 60_000;
  return { kind: 'absolute', startMs: endMs - (shown.endMs - shown.startMs), endMs };
}

/** Column titles of a series export, in the user's language. */
export interface SeriesCsvHeaders {
  bucketUtc: string;
  bucketLocal: string;
  channel: string;
  unit: string;
  avg: string;
  min: string;
  max: string;
  count: string;
  badCount: string;
}

/**
 * A series as CSV: one row per channel bucket, its UTC instant and its time
 * in the series' display zone (so a spreadsheet and the chart agree), in the
 * user's spreadsheet format.
 */
export function seriesCsv(
  series: ChannelSeriesResponse,
  headers: SeriesCsvHeaders,
  locale: string,
  /** The channels the chart shows; all when omitted. */
  channelKeys?: ReadonlySet<string>,
): string {
  const local = new Intl.DateTimeFormat(locale, {
    timeZone: series.displayTimeZone,
    dateStyle: 'short',
    timeStyle: 'short',
  });
  const rows: CsvField[][] = [
    [
      headers.bucketUtc,
      headers.bucketLocal,
      headers.channel,
      headers.unit,
      headers.avg,
      headers.min,
      headers.max,
      headers.count,
      headers.badCount,
    ],
  ];
  for (const channel of series.channels) {
    if (channelKeys !== undefined && !channelKeys.has(channel.channelKey)) continue;
    for (const point of channel.points) {
      const bucket = new Date(point.bucket);
      rows.push([
        bucket.toISOString(),
        local.format(bucket),
        channel.displayLabel,
        channel.unitSymbol ?? channel.unit ?? '',
        point.avg,
        point.min,
        point.max,
        point.count,
        point.badCount,
      ]);
    }
  }
  return csvText(rows, csvFormatFor(locale));
}
