import { MAX_SERIES_RANGE_MS } from '../sensor-readings/tier-policy';
import {
  MAX_TIME_RANGE_MS,
  parsePresetKey,
  parseTimeRangeParams,
  presetDurationMs,
  RELATIVE_TIME_RANGE_PRESETS,
  resolveTimeRange,
  SCADA_RANGE_TOKENS,
  scadaRangeDurationMs,
  timeRangeToParams,
  type TimeRangeSpec,
} from '../sensor-readings/time-range';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const NOW = Date.UTC(2026, 9, 7, 12, 0, 0);

/**
 * The sensor-reading time range: one table of preset durations behind the
 * readings page, the widget dashboard, the heatmap and the SCADA charts.
 */
describe('sensor-reading time range', () => {
  it('keeps every duration the surfaces used before (golden)', () => {
    // The dashboard / readings vocabulary.
    expect(
      (['live', '1h', '6h', '24h', '7d', '30d'] as const).map((key) => presetDurationMs(key)),
    ).toEqual([5 * MINUTE, HOUR, 6 * HOUR, DAY, 7 * DAY, 30 * DAY]);
    // The SCADA chart vocabulary, by its stored tokens.
    expect(SCADA_RANGE_TOKENS.map(({ token }) => [token, scadaRangeDurationMs(token)])).toEqual([
      ['last1h', HOUR],
      ['last8h', 8 * HOUR],
      ['last1d', DAY],
      ['last3d', 3 * DAY],
      ['last1w', 7 * DAY],
      ['last1m', 30 * DAY],
    ]);
  });

  it('lists presets shortest first and never past the backend cap', () => {
    const durations = RELATIVE_TIME_RANGE_PRESETS.map((preset) => preset.ms);
    expect([...durations].sort((a, b) => a - b)).toEqual(durations);
    expect(Math.max(...durations)).toBeLessThanOrEqual(MAX_TIME_RANGE_MS);
    expect(MAX_TIME_RANGE_MS).toBe(MAX_SERIES_RANGE_MS);
  });

  it('parses a preset key from untrusted input, and nothing else', () => {
    expect(parsePresetKey('7d')).toBe('7d');
    expect(parsePresetKey('last1h')).toBeNull();
    expect(parsePresetKey(undefined)).toBeNull();
    expect(parsePresetKey(7)).toBeNull();
  });

  it('resolves a relative range at now and checks an absolute one', () => {
    expect(resolveTimeRange({ kind: 'relative', preset: '24h' }, NOW)).toEqual({
      ok: true,
      startMs: NOW - DAY,
      endMs: NOW,
    });
    expect(resolveTimeRange({ kind: 'absolute', startMs: NOW, endMs: NOW }, NOW)).toEqual({
      ok: false,
      error: 'empty',
    });
    expect(
      resolveTimeRange({ kind: 'absolute', startMs: NOW - 400 * DAY, endMs: NOW }, NOW),
    ).toEqual({ ok: false, error: 'too-long' });
    expect(resolveTimeRange({ kind: 'absolute', startMs: Number.NaN, endMs: NOW }, NOW)).toEqual({
      ok: false,
      error: 'invalid',
    });
  });

  it('round-trips a range through URL parameters', () => {
    const specs: TimeRangeSpec[] = [
      { kind: 'relative', preset: '90d' },
      { kind: 'absolute', startMs: Date.UTC(2026, 8, 16), endMs: Date.UTC(2026, 8, 20) },
    ];
    for (const spec of specs) {
      expect(parseTimeRangeParams(timeRangeToParams(spec))).toEqual({ ok: true, spec });
    }
  });

  it('reads only instants with an explicit offset, so a link means one window everywhere', () => {
    expect(
      parseTimeRangeParams({ from: '2026-09-16T00:00:00+03:00', to: '2026-09-17T00:00:00Z' }),
    ).toEqual({
      ok: true,
      spec: {
        kind: 'absolute',
        startMs: Date.UTC(2026, 8, 15, 21),
        endMs: Date.UTC(2026, 8, 17),
      },
    });
    for (const from of ['2026-09-16T00:00', '2026-09-16', 'Sep 16 2026', '2026-09-16T00:00+0300']) {
      expect([from, parseTimeRangeParams({ from, to: '2026-09-17T00:00:00Z' })]).toEqual([
        from,
        { ok: false, error: 'invalid' },
      ]);
    }
  });

  it('reports a malformed link instead of showing something else', () => {
    expect(parseTimeRangeParams({})).toBeNull();
    expect(parseTimeRangeParams({ range: 'forever' })).toEqual({ ok: false, error: 'invalid' });
    expect(
      parseTimeRangeParams({ from: '2026-09-20T00:00:00Z', to: '2026-09-16T00:00:00Z' }),
    ).toEqual({
      ok: false,
      error: 'empty',
    });
    expect(parseTimeRangeParams({ from: 'yesterday', to: '2026-09-16T00:00:00Z' })).toEqual({
      ok: false,
      error: 'invalid',
    });
  });
});
