import { describe, expect, it } from 'vitest';

import type { ChartLine } from '../../../types/scada-runtime.types';
import { toUPlotData } from '../trendChartData';

const line = (tagId: string): ChartLine => ({
  id: tagId,
  tagId,
  label: tagId,
  color: '#000',
  yAxis: 1,
  interpolation: 'linear',
  spanGaps: false,
});
const at = (minutes: number): number => minutes * 60_000;
const points = (...minutes: number[]) => minutes.map((m) => ({ timestamp: at(m), value: m }));

/**
 * uPlot breaks a line at `null` and draws through `undefined`. A series with
 * reported gaps must break exactly at them — not at a sibling's timestamps,
 * and not stay joined across an outage the server reported.
 */
describe('TrendChart data with reported gaps', () => {
  it('breaks a line at its reported gap, also when every channel went quiet together', () => {
    // One channel, quiet from minute 30 to 360 (a device outage).
    const [, row] = toUPlotData([line('t')], { t: points(0, 15, 360, 375) }, { t: [at(30)] });
    expect(row).toEqual([0, 15, null, 360, 375]);
  });

  it("draws through a sibling's timestamps instead of breaking at them", () => {
    const data = { fast: points(0, 15, 30, 45), slow: points(0, 30) };
    const [, fast, slow] = toUPlotData([line('fast'), line('slow')], data, { fast: [], slow: [] });
    expect(fast).toEqual([0, 15, 30, 45]);
    expect(slow).toEqual([0, undefined, 30, undefined]);
  });

  it('keeps the old behaviour for lines without reported gaps', () => {
    const data = { a: points(0, 30), b: points(15) };
    const [, a, b] = toUPlotData([line('a'), line('b')], data);
    expect(a).toEqual([0, null, 30]);
    expect(b).toEqual([null, 15, null]);
  });
});
