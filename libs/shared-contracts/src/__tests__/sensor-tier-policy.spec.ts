import {
  AGGREGATION_INTERVAL_SQL,
  AGGREGATION_INTERVALS,
  AS_OF_LOOKBACK,
  DISPLAY_INTERVAL_LADDER,
  displayIntervalFor,
  MAX_SERIES_RANGE_MS,
  METRIC_TIERS,
  metricTier,
  tierForWindow,
} from '../sensor-readings/tier-policy';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * The sensor-reading tier policy (the single owner of the series window cap,
 * the tier choice, the display ladder, the interval whitelist and the rollup
 * windows). The golden tables pin the behaviour the hand-written copies had
 * before they were folded in here; the properties pin what the copies only
 * claimed in comments.
 */
describe('sensor-reading tier policy', () => {
  it('keeps the display ladder the series queries used (golden)', () => {
    const cases: Array<[number, string]> = [
      [30 * MINUTE, '1 minute'],
      [HOUR, '1 minute'],
      [HOUR + 1, '5 minutes'],
      [6 * HOUR, '5 minutes'],
      [DAY, '15 minutes'],
      [3 * DAY, '1 hour'],
      [7 * DAY, '4 hours'],
      [30 * DAY, '1 day'],
      [30 * DAY + 1, '1 week'],
      [MAX_SERIES_RANGE_MS, '1 week'],
    ];
    for (const [windowMs, interval] of cases) {
      expect([windowMs, displayIntervalFor(windowMs)]).toEqual([windowMs, interval]);
    }
  });

  it('keeps the store choice the series queries used (golden)', () => {
    const cases: Array<[number, string]> = [
      [HOUR, 'sensor_metrics'],
      [HOUR + 1, 'metrics_1min'],
      [DAY, 'metrics_1min'],
      [DAY + 1, 'metrics_1hour'],
      [30 * DAY, 'metrics_1hour'],
      [30 * DAY + 1, 'metrics_1day'],
      [MAX_SERIES_RANGE_MS, 'metrics_1day'],
    ];
    for (const [windowMs, table] of cases) {
      expect([windowMs, tierForWindow(windowMs).table]).toEqual([windowMs, table]);
    }
  });

  it('keeps the interval whitelist, rollup windows and limits the DDL and queries used', () => {
    expect(AGGREGATION_INTERVAL_SQL).toEqual([
      '1 minute',
      '5 minutes',
      '15 minutes',
      '1 hour',
      '4 hours',
      '1 day',
      '1 week',
    ]);
    expect(MAX_SERIES_RANGE_MS).toBe(365 * DAY);
    expect(AS_OF_LOOKBACK).toEqual({ sql: '7 days', ms: 7 * DAY });
    expect(METRIC_TIERS.map((tier) => [tier.table, tier.retention?.sql ?? null])).toEqual([
      ['sensor_metrics', null],
      ['metrics_1min', '1 year'],
      ['metrics_1hour', '5 years'],
      ['metrics_1day', null],
    ]);
    expect(
      METRIC_TIERS.map(
        (tier) => tier.refresh && [tier.refresh.startOffset.sql, tier.refresh.schedule.sql],
      ),
    ).toEqual([null, ['24 hours', '1 minute'], ['7 days', '1 hour'], ['30 days', '1 day']]);
  });

  it('never displays a series finer than the store it is read from', () => {
    // The guarantee metric-source relies on when it re-buckets a rollup: the
    // display interval is always at least the tier's native bucket.
    const probes = DISPLAY_INTERVAL_LADDER.flatMap(({ maxWindowMs }) =>
      Number.isFinite(maxWindowMs) ? [maxWindowMs - 1, maxWindowMs, maxWindowMs + 1] : [],
    ).concat([MAX_SERIES_RANGE_MS]);
    for (const windowMs of probes) {
      const { bucket } = tierForWindow(windowMs);
      const display = AGGREGATION_INTERVALS.find(
        (interval) => interval.sql === displayIntervalFor(windowMs),
      );
      expect(display).toBeDefined();
      expect([windowMs, (display?.ms ?? -1) >= (bucket?.ms ?? 0)]).toEqual([windowMs, true]);
    }
  });

  it('orders the tiers finest-first and keeps every refresh window inside its retention', () => {
    const windows = METRIC_TIERS.map((tier) => tier.maxWindowMs);
    expect([...windows].sort((a, b) => a - b)).toEqual(windows);
    for (const tier of METRIC_TIERS) {
      if (tier.refresh && tier.retention) {
        expect(tier.refresh.startOffset.ms).toBeLessThan(tier.retention.ms);
      }
    }
    // A coarser rollup is never dropped before the finer one it is built from.
    expect(metricTier('hour').retention.ms).toBeGreaterThanOrEqual(
      metricTier('minute').retention.ms,
    );
  });

  it('names every tier through one lookup', () => {
    for (const tier of METRIC_TIERS) {
      expect(metricTier(tier.tier)).toBe(tier);
    }
  });
});
