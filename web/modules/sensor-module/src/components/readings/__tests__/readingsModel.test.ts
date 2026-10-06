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
  readingOwners,
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

  it('exports one CSV row per channel with full-precision values', () => {
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
    );
    expect(csv.split('\n')).toEqual([
      'Cihaz;Kanal;Anahtar;Değer;Birim;Zaman;Durum',
      'Codex Su Sıcaklığı Simülatörü;Su Sıcaklığı;temperature;24.1;°C;2026-10-06T10:32:07.803Z;Normal',
      'Codex Su Sıcaklığı Simülatörü;"Amonyak; NH3";ammonia;0.1137;mg/L;2026-10-06T10:32:07.803Z;Uyarı',
    ]);
  });
});
