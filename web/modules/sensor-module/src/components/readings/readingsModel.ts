/**
 * Pure view-model helpers for /sensor/readings (SENSOR-HIGH-138). No React —
 * the formatting, freshness and export rules live here so they are tested
 * once and the page/cards only render.
 */
import type { ChannelLatestValue } from '../../graphql/channelReadings';
import type { RegisteredSensor } from '../../hooks/useSensorList';

/** A value older than this is "stale": the device has stopped reporting. */
export const FRESH_WINDOW_MS = 5 * 60 * 1000;

export type Freshness = 'live' | 'stale' | 'none';

export const PERIODS = [
  { value: '1h', label: 'Son 1 Saat', ms: 60 * 60 * 1000 },
  { value: '6h', label: 'Son 6 Saat', ms: 6 * 60 * 60 * 1000 },
  { value: '24h', label: 'Son 24 Saat', ms: 24 * 60 * 60 * 1000 },
  { value: '7d', label: 'Son 7 Gün', ms: 7 * 24 * 60 * 60 * 1000 },
  { value: '30d', label: 'Son 30 Gün', ms: 30 * 24 * 60 * 60 * 1000 },
] as const;

export type PeriodValue = (typeof PERIODS)[number]['value'];

export function periodMs(period: PeriodValue): number {
  return PERIODS.find((entry) => entry.value === period)?.ms ?? PERIODS[2].ms;
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

function csvCell(value: string): string {
  return /[";\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/**
 * The current values as CSV (`;`-separated, the Turkish Excel default), one
 * row per channel. Values are written with a dot decimal and full precision so
 * the file round-trips into any tool.
 */
export function latestValuesCsv(
  sensors: readonly RegisteredSensor[],
  bySensor: ReadonlyMap<string, readonly ChannelLatestValue[]>,
): string {
  const rows = [['Cihaz', 'Kanal', 'Anahtar', 'Değer', 'Birim', 'Zaman', 'Durum']];
  for (const sensor of sensors) {
    for (const channel of bySensor.get(sensor.id) ?? []) {
      rows.push([
        sensor.name,
        channel.displayLabel,
        channel.channelKey,
        channel.value === null || channel.value === undefined ? '' : String(channel.value),
        unitOf(channel),
        channel.time ?? '',
        channel.alertLevel ? ALERT_LABELS[channel.alertLevel] : '',
      ]);
    }
  }
  return rows.map((row) => row.map(csvCell).join(';')).join('\n');
}
