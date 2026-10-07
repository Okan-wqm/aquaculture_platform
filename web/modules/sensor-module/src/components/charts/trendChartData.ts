/**
 * The flat data uPlot draws, built from per-line points. Kept apart from the
 * chart component so it is pure and tested without a canvas.
 */
import type uPlot from 'uplot';

import type { ChartLine, HistoricalDataPoint } from '../../types/scada-runtime.types';

/** Per line (by tagId), the instants (ms) where its data stops — its reported gaps. */
export type LineBreaks = Readonly<Record<string, readonly number[]>>;

/**
 * Convert HistoricalDataPoint arrays into the flat uPlot data format.
 * uPlot expects [timestamps, series1Values, series2Values, …]
 * where each array has the same length and timestamps are ascending.
 */
export function toUPlotData(
  lines: ChartLine[],
  data: Record<string, HistoricalDataPoint[]>,
  breaks?: LineBreaks,
): uPlot.AlignedData {
  if (lines.length === 0) return [[], ...lines.map(() => [])];

  // Collect and sort all unique timestamps
  const tsSet = new Set<number>();
  for (const line of lines) {
    const pts = data[line.tagId] ?? [];
    for (const pt of pts) tsSet.add(pt.timestamp / 1000); // uPlot uses seconds
    for (const at of breaks?.[line.tagId] ?? []) tsSet.add(at / 1000);
  }

  const timestamps = [...tsSet].sort((a, b) => a - b);
  if (timestamps.length === 0) return [[], ...lines.map(() => [])];

  const tsIndex = new Map<number, number>();
  timestamps.forEach((t, i) => tsIndex.set(t, i));

  const series: (number | null | undefined)[][] = lines.map((line) => {
    // A line with known breaks (a series whose gaps the server reports) leaves
    // the other lines' timestamps `undefined` — uPlot draws through those —
    // and marks each break `null`, where uPlot stops the line. Without breaks
    // every missing timestamp is `null`, as before.
    const lineBreaks = breaks?.[line.tagId];
    const row: (number | null | undefined)[] = new Array(timestamps.length).fill(
      lineBreaks === undefined ? null : undefined,
    );
    for (const at of lineBreaks ?? []) {
      const idx = tsIndex.get(at / 1000);
      if (idx != null) row[idx] = null;
    }
    const pts = data[line.tagId] ?? [];
    for (const pt of pts) {
      const ts = pt.timestamp / 1000;
      const idx = tsIndex.get(ts);
      if (idx == null) continue;
      const v = typeof pt.value === 'number' ? pt.value : parseFloat(String(pt.value));
      row[idx] = isNaN(v) ? null : v;
    }
    return row;
  });

  return [timestamps as number[], ...series] as uPlot.AlignedData;
}
