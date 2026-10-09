import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resolveTrendTimeRange } from '../../../hooks/useTrendData';
import {
  DEFAULT_TREND_WIDGET_PRESET,
  TREND_WIDGET_PRESETS,
  parseTrendWidgetPreset,
} from '../../scada-builder/widget-renderers/trendChartUtils';
import { AQUACULTURE_RAS_DEMO } from '../../../store/scada/templates';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = Date.parse('2026-10-07T12:00:00.000Z');

/**
 * The SCADA charts read their range durations from the shared time-range
 * table (SENSOR-MEDIUM-152); these pin the windows they resolve to.
 */
describe('SCADA trend time range', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('resolves each SCADA token to the window it always covered, ending now', () => {
    const spans = (['last1h', 'last8h', 'last1d', 'last3d', 'last1w', 'last1m'] as const).map(
      (token) => {
        const { from, to } = resolveTrendTimeRange(token);
        return [token, to.getTime() - from.getTime(), to.getTime()];
      },
    );
    expect(spans).toEqual([
      ['last1h', HOUR, NOW],
      ['last8h', 8 * HOUR, NOW],
      ['last1d', DAY, NOW],
      ['last3d', 3 * DAY, NOW],
      ['last1w', 7 * DAY, NOW],
      ['last1m', 30 * DAY, NOW],
    ]);
  });

  it('passes a fixed window through unchanged', () => {
    const window = { from: new Date(NOW - 2 * DAY), to: new Date(NOW - DAY) };
    expect(resolveTrendTimeRange(window)).toBe(window);
  });
});

describe('SCADA trend widget range', () => {
  it('accepts only the ranges the widget offers', () => {
    expect(TREND_WIDGET_PRESETS.map((preset) => parseTrendWidgetPreset(preset))).toEqual([
      ...TREND_WIDGET_PRESETS,
    ]);
    expect(TREND_WIDGET_PRESETS).toContain(DEFAULT_TREND_WIDGET_PRESET);
    // a preset the widget does not offer, a SCADA token, a typo, nothing
    for (const value of ['8h', 'last1h', '4h', undefined, 24]) {
      expect([value, parseTrendWidgetPreset(value)]).toEqual([value, null]);
    }
  });

  it('every built-in template stores a range its trend widgets offer', () => {
    const trendRanges = (AQUACULTURE_RAS_DEMO.screens ?? [])
      .flatMap((screen) => screen.widgets ?? [])
      .filter((widget) => widget.widgetType === 'trendChart')
      .map((widget) => widget.config?.defaultRange);
    expect(trendRanges.length).toBeGreaterThan(0);
    expect(trendRanges.filter((range) => parseTrendWidgetPreset(range) === null)).toEqual([]);
  });
});
