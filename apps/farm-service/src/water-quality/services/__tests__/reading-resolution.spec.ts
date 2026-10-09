import type { SensorChannelDescription } from '@platform/event-contracts';

import { ChannelSourcePriority } from '../../entities/water-quality-param-equipment.entity';
import type { MeasurementPoint } from '../parameter-sources';
import {
  type ChannelCandidateFacts,
  type ReadingAsk,
  type ReadingLevel,
  resolveReading,
} from '../reading-resolution';

const AS_OF = new Date('2026-10-08T12:00:00Z');
const TANK: MeasurementPoint = { kind: 'tank', id: 'tank-1' };
const SYSTEM: MeasurementPoint = { kind: 'system', id: 'system-1' };
const SITE: MeasurementPoint = { kind: 'site', id: 'site-1' };

const temperature = (overrides: Partial<ReadingAsk> = {}): ReadingAsk => ({
  parameter: { quantity: 'temperature', unit: '°C' },
  unit: '°C',
  asOf: AS_OF,
  maxAgeMs: null,
  ...overrides,
});

function described(
  channelKey: string,
  facts: Partial<SensorChannelDescription> = {},
): SensorChannelDescription {
  return {
    sensorId: 'sensor-1',
    channelKey,
    presence: 'FOUND',
    sensorActive: true,
    siteId: 'site-1',
    systemId: null,
    tankId: 'tank-1',
    equipmentId: null,
    channelId: 'channel-1',
    enabled: true,
    quantity: 'temperature',
    quantityFamily: null,
    unit: '°C',
    calibrationDueAt: null,
    configuredAt: null,
    latestValue: 14.5,
    latestAt: '2026-10-08T11:59:00Z',
    latestQuality: 'GOOD',
    ...facts,
  };
}

function channel(
  sourceId: string,
  priority: ChannelSourcePriority,
  facts: Partial<SensorChannelDescription> = {},
  bindingProblems: ChannelCandidateFacts['bindingProblems'] = [],
): ChannelCandidateFacts {
  return { sourceId, priority, description: described(sourceId, facts), bindingProblems };
}

const level = (
  point: MeasurementPoint,
  parts: Partial<Omit<ReadingLevel, 'point'>> = {},
): ReadingLevel => ({
  point,
  inherited: point.kind !== 'tank',
  channels: [],
  manual: null,
  ...parts,
});

describe('resolveReading', () => {
  it('answers from the primary channel, carried into the asked unit through the registry', () => {
    const reading = resolveReading(temperature(), [
      level(TANK, {
        channels: [
          channel('backup', ChannelSourcePriority.BACKUP, { latestValue: 99 }),
          channel('primary', ChannelSourcePriority.PRIMARY, { unit: '°F', latestValue: 59 }),
        ],
      }),
    ]);
    expect(reading.value).toBeCloseTo(15, 10);
    expect(reading.chosen).toMatchObject({
      kind: 'CHANNEL_PRIMARY',
      point: TANK,
      inherited: false,
      sourceId: 'primary',
      sensorId: 'sensor-1',
      channelKey: 'primary',
      quality: 'GOOD',
    });
    expect(reading.ageMs).toBe(60_000);
    expect(reading.skipped).toEqual([]);
    expect(reading.unresolved).toBeNull();
  });

  it('skips a primary the bind would refuse now, and says why; the backup answers', () => {
    const reading = resolveReading(temperature(), [
      level(TANK, {
        channels: [
          channel('primary', ChannelSourcePriority.PRIMARY, {}, ['NOT_AT_POINT']),
          channel('backup', ChannelSourcePriority.BACKUP, { latestValue: 13 }),
        ],
      }),
    ]);
    expect(reading.value).toBe(13);
    expect(reading.chosen?.kind).toBe('CHANNEL_BACKUP');
    expect(reading.skipped).toEqual([
      expect.objectContaining({
        kind: 'CHANNEL_PRIMARY',
        sourceId: 'primary',
        bindingProblems: ['NOT_AT_POINT'],
        readingProblems: [],
      }),
    ]);
  });

  it('skips a channel with no sample or a BAD one, and falls back to the manual sample', () => {
    const reading = resolveReading(temperature(), [
      level(TANK, {
        channels: [
          channel('primary', ChannelSourcePriority.PRIMARY, { latestValue: null, latestAt: null }),
          channel('backup', ChannelSourcePriority.BACKUP, { latestQuality: 'BAD' }),
        ],
        manual: {
          measurementId: 'm-1',
          measuredAt: new Date('2026-10-08T09:00:00Z'),
          value: '12.25',
        },
      }),
    ]);
    expect(reading.value).toBe(12.25);
    expect(reading.chosen).toMatchObject({
      kind: 'MANUAL',
      measurementId: 'm-1',
      quality: null,
      sourceId: null,
    });
    expect(reading.ageMs).toBe(3 * 3_600_000);
    expect(reading.skipped.map((skipped) => skipped.readingProblems)).toEqual([
      ['NO_SAMPLE'],
      ['SAMPLE_QUALITY_BAD'],
    ]);
  });

  it('passes over a value older than the caller’s window, and only then', () => {
    const levels = [
      level(TANK, {
        channels: [
          channel('primary', ChannelSourcePriority.PRIMARY, { latestAt: '2026-10-08T06:00:00Z' }),
        ],
        manual: { measurementId: 'm-1', measuredAt: new Date('2026-10-08T11:00:00Z'), value: 13 },
      }),
    ];
    expect(resolveReading(temperature(), levels).chosen?.kind).toBe('CHANNEL_PRIMARY');
    const windowed = resolveReading(temperature({ maxAgeMs: 4 * 3_600_000 }), levels);
    expect(windowed.chosen?.kind).toBe('MANUAL');
    expect(windowed.skipped[0]?.readingProblems).toEqual(['OLDER_THAN_WINDOW']);
  });

  it('reads an inherited level only when the chain carries one, labelled with where', () => {
    const reading = resolveReading(temperature(), [
      level(TANK),
      level(SYSTEM, { channels: [channel('loop', ChannelSourcePriority.PRIMARY)] }),
      level(SITE, { channels: [channel('site', ChannelSourcePriority.PRIMARY)] }),
    ]);
    expect(reading.chosen).toMatchObject({ point: SYSTEM, inherited: true, sourceId: 'loop' });
  });

  it('keeps a manual value in its parameter’s unit, converted only through the registry', () => {
    const manual = {
      measurementId: 'm-1',
      measuredAt: new Date('2026-10-08T11:00:00Z'),
      value: 15,
    };
    const h2s: ReadingAsk = {
      parameter: { quantity: 'h2s', unit: 'mg/L' },
      unit: 'µg/L',
      asOf: AS_OF,
      maxAgeMs: null,
    };
    expect(resolveReading(h2s, [level(TANK, { manual })]).value).toBeCloseTo(15_000, 6);
    const transparency: ReadingAsk = {
      parameter: { quantity: null, unit: 'cm' },
      unit: 'cm',
      asOf: AS_OF,
      maxAgeMs: null,
    };
    expect(resolveReading(transparency, [level(TANK, { manual })]).value).toBe(15);
    const misread = resolveReading({ ...transparency, unit: 'm' }, [level(TANK, { manual })]);
    expect(misread.value).toBeNull();
    expect(misread.skipped[0]?.readingProblems).toEqual(['UNIT_NOT_CONVERTIBLE']);
  });

  it('refuses a manual entry that is not a number', () => {
    const reading = resolveReading(temperature(), [
      level(TANK, {
        manual: {
          measurementId: 'm-1',
          measuredAt: new Date('2026-10-08T11:00:00Z'),
          value: 'n/a',
        },
      }),
    ]);
    expect(reading.skipped[0]?.readingProblems).toEqual(['VALUE_NOT_NUMERIC']);
    expect(reading.unresolved).toBe('NO_USABLE_SOURCE');
  });

  it('says NO_SOURCE when nothing is bound or sampled, and ages a sample stamped ahead as 0', () => {
    expect(resolveReading(temperature(), [level(TANK)])).toMatchObject({
      value: null,
      chosen: null,
      ageMs: null,
      unresolved: 'NO_SOURCE',
    });
    const ahead = resolveReading(temperature(), [
      level(TANK, {
        channels: [
          channel('primary', ChannelSourcePriority.PRIMARY, { latestAt: '2026-10-08T12:00:05Z' }),
        ],
      }),
    ]);
    expect(ahead.ageMs).toBe(0);
  });
});
