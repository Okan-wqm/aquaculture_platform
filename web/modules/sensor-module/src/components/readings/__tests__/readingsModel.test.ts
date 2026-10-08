import { describe, expect, it } from 'vitest';

import type { ChannelLatestValue } from '../../../graphql/channelReadings';
import type { RegisteredSensor } from '../../../hooks/useSensorList';
import {
  FRESH_WINDOW_MS,
  channelFilterOptions,
  formatAge,
  formatValue,
  freshness,
  lastReportedAt,
  latestValuesCsv,
  rangeEndingAt,
  readingOwners,
  seriesCsv,
} from '../readingsModel';

const NOW = Date.parse('2026-10-06T10:32:17.000Z');

function channel(overrides: Partial<ChannelLatestValue>): ChannelLatestValue {
  return {
    sensorId: 's-1',
    channelId: `c-${overrides.channelKey ?? 'temperature'}`,
    channelKey: 'temperature',
    displayLabel: 'Su Sıcaklığı',
    unit: '°C',
    unitSymbol: '°C',
    displayOrder: 1,
    precision: 1,
    value: 24.1,
    time: '2026-10-06T10:32:07.803Z',
    qualityCode: 192,
    alertLevel: 'NORMAL',
    ...overrides,
  };
}

function sensor(overrides: Partial<RegisteredSensor>): RegisteredSensor {
  return {
    id: 's-1',
    name: 'Codex Su Sıcaklığı Simülatörü',
    type: 'temperature',
    protocolCode: 'MQTT',
    protocolConfiguration: { topic: 'sensors/codex-test/water-temp-01' },
    registrationStatus: 'draft',
    tenantId: 't-1',
    createdAt: '',
    updatedAt: '',
    ...overrides,
  };
}

describe('readingsModel', () => {
  it('shows parents and standalone sensors but not child rows (no duplicated parameters)', () => {
    const owners = readingOwners([
      sensor({ id: 'parent', isParentDevice: true }),
      sensor({ id: 'child', parentId: 'parent' }),
      sensor({ id: 'standalone' }),
    ]);
    expect(owners.map((entry) => entry.id)).toEqual(['parent', 'standalone']);
  });

  it('formats with the channel precision and marks a missing value', () => {
    expect(formatValue({ value: 7.3456, precision: 2 })).toBe('7,35');
    expect(formatValue({ value: 0.114, precision: 3 })).toBe('0,114');
    expect(formatValue({ value: null, precision: 2 })).toBe('—');
  });

  it('classifies freshness from the newest channel time', () => {
    const channels = [
      channel({ time: '2026-10-06T10:20:00.000Z' }),
      channel({ channelKey: 'ph', time: '2026-10-06T10:32:07.803Z' }),
      channel({ channelKey: 'orp', time: null, value: null }),
    ];
    const lastAt = lastReportedAt(channels);
    expect(lastAt).toBe(Date.parse('2026-10-06T10:32:07.803Z'));
    expect(freshness(lastAt, NOW)).toBe('live');
    expect(freshness(lastAt, (lastAt ?? 0) + FRESH_WINDOW_MS + 1)).toBe('stale');
    expect(freshness(lastReportedAt([channel({ time: null })]), NOW)).toBe('none');
  });

  it('renders ages in Turkish', () => {
    expect(formatAge('2026-10-06T10:32:07.000Z', NOW)).toBe('10 sn önce');
    expect(formatAge('2026-10-06T10:20:17.000Z', NOW)).toBe('12 dk önce');
    expect(formatAge(null, NOW)).toBe('Veri yok');
  });

  it('offers each channel key once, labelled and sorted', () => {
    expect(
      channelFilterOptions([
        channel({ channelKey: 'ph', displayLabel: 'pH' }),
        channel({ channelKey: 'ammonia', displayLabel: 'Amonyak (NH3-N)' }),
        channel({ channelKey: 'ph', displayLabel: 'pH', sensorId: 's-2' }),
      ]),
    ).toEqual([
      { value: 'ammonia', label: 'Amonyak (NH3-N)' },
      { value: 'ph', label: 'pH' },
    ]);
  });

  it('exports one CSV row per channel, full precision, in the Turkish spreadsheet format', () => {
    const csv = latestValuesCsv(
      [sensor({})],
      new Map([
        [
          's-1',
          [
            channel({}),
            channel({
              channelKey: 'ammonia',
              displayLabel: 'Amonyak; NH3',
              unit: 'mg/L',
              unitSymbol: null,
              value: 0.1137,
              alertLevel: 'WARNING',
            }),
          ],
        ],
      ]),
      'tr',
    );
    expect(csv.split('\n')).toEqual([
      'Cihaz;Kanal;Anahtar;Değer;Birim;Zaman;Durum',
      'Codex Su Sıcaklığı Simülatörü;Su Sıcaklığı;temperature;24,1;°C;2026-10-06T10:32:07.803Z;Normal',
      'Codex Su Sıcaklığı Simülatörü;"Amonyak; NH3";ammonia;0,1137;mg/L;2026-10-06T10:32:07.803Z;Uyarı',
    ]);
  });

  it('writes text that a spreadsheet would run as a formula as text, but keeps numbers numbers', () => {
    const csv = latestValuesCsv(
      [sensor({ name: '=HYPERLINK("http://x","click")' })],
      new Map([['s-1', [channel({ displayLabel: '@SUM(A1)', unit: '-1', value: -0.02 })]]]),
      'en',
    );
    const row = csv.split('\n')[1] ?? '';
    expect(row.startsWith(`"'=HYPERLINK(""http://x"",""click"")"`)).toBe(true);
    expect(row).toContain(",'@SUM(A1),");
    // A negative reading stays a number; an English spreadsheet reads ',' and '.'.
    expect(row).toContain(',-0.02,');
  });
});

describe('rangeEndingAt', () => {
  it('keeps the length of the range shown and ends with the last sample minute', () => {
    const last = Date.parse('2026-09-19T14:02:30Z');
    expect(rangeEndingAt(last, { kind: 'relative', preset: '7d' }, NOW)).toEqual({
      kind: 'absolute',
      startMs: Date.parse('2026-09-12T14:03:00Z'),
      endMs: Date.parse('2026-09-19T14:03:00Z'),
    });
    const fixed = { kind: 'absolute', startMs: 0, endMs: 6 * 3_600_000 } as const;
    expect(rangeEndingAt(last, fixed, NOW)).toEqual({
      kind: 'absolute',
      startMs: Date.parse('2026-09-19T08:03:00Z'),
      endMs: Date.parse('2026-09-19T14:03:00Z'),
    });
  });
});

describe('seriesCsv', () => {
  it('writes each bucket with its UTC instant and its time in the series zone', () => {
    const csv = seriesCsv(
      {
        sensorId: 's-1',
        interval: '1 hour',
        resolution: 'ONE_HOUR',
        sourceTier: 'HOUR',
        bucketTimeZone: 'Europe/Istanbul',
        displayTimeZone: 'Europe/Istanbul',
        displayTimeZoneSource: 'SITE',
        maxRangeSeconds: 31_536_000,
        startTime: '2026-09-16T00:00:00Z',
        endTime: '2026-09-17T00:00:00Z',
        channels: [
          {
            channelId: 'c-1',
            channelKey: 'temperature',
            displayLabel: 'Su Sıcaklığı',
            unit: '°C',
            unitSymbol: '°C',
            precision: 1,
            enabled: true,
            gaps: [],
            points: [
              {
                bucket: '2026-09-16T21:00:00.000Z',
                avg: 24.1,
                min: 24,
                max: 24.3,
                count: 60,
                badCount: 2,
              },
            ],
          },
        ],
      },
      {
        bucketUtc: 'UTC',
        bucketLocal: 'Yerel',
        channel: 'Kanal',
        unit: 'Birim',
        avg: 'Ort',
        min: 'Min',
        max: 'Maks',
        count: 'Örnek',
        badCount: 'Düşük',
      },
      'tr',
    );
    const [header, row] = csv.split('\n');
    expect(header).toBe('UTC;Yerel;Kanal;Birim;Ort;Min;Maks;Örnek;Düşük');
    // 21:00 UTC is midnight of the next day in Istanbul (UTC+3).
    expect(row).toBe('2026-09-16T21:00:00.000Z;17.09.2026 00:00;Su Sıcaklığı;°C;24,1;24;24,3;60;2');
  });
});
