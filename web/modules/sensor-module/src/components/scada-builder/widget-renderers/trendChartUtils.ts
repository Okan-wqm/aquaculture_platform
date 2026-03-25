/**
 * Utility functions for TrendChartRenderer.
 * Extracted to keep the renderer component under 300 lines.
 */

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export interface SimPoint {
  t: number;
  values: Record<string, number>;
}

export type TimeRangeKey = '1h' | '6h' | '24h' | '7d' | '30d';

export const TRACE_COLORS = [
  '#3b82f6', '#22c55e', '#f59e0b', '#ef4444',
  '#8b5cf6', '#ec4899', '#06b6d4', '#f97316',
];

export const TIME_RANGES: { key: TimeRangeKey; label: string; ms: number }[] = [
  { key: '1h',  label: '1h',  ms: 3_600_000 },
  { key: '6h',  label: '6h',  ms: 21_600_000 },
  { key: '24h', label: '24h', ms: 86_400_000 },
  { key: '7d',  label: '7d',  ms: 604_800_000 },
  { key: '30d', label: '30d', ms: 2_592_000_000 },
];

/* ------------------------------------------------------------------ */
/*  Formatting                                                         */
/* ------------------------------------------------------------------ */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function formatTimeLabel(ms: number, rangeMs: number): string {
  const d = new Date(ms);
  if (rangeMs <= 86_400_000) {
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }
  return `${MONTHS[d.getMonth()]} ${d.getDate()}`;
}

/* ------------------------------------------------------------------ */
/*  Data generation                                                    */
/* ------------------------------------------------------------------ */

export function generateDemoTraces(tags: string[], count: number): SimPoint[] {
  const now = Date.now();
  const step = 86_400_000 / count;
  const pts: SimPoint[] = [];
  for (let i = 0; i < count; i++) {
    const values: Record<string, number> = {};
    tags.forEach((tag, idx) => {
      const phase = idx * 1.2;
      const noise = (Math.sin(i * 12.9898 + idx * 78.233) * 43758.5453) % 1;
      values[tag] = 50 + Math.sin(i * 0.3 + phase) * 20 + (noise - 0.5) * 5;
    });
    pts.push({ t: now - (count - 1 - i) * step, values });
  }
  return pts;
}

/* ------------------------------------------------------------------ */
/*  Domain / tick computation                                          */
/* ------------------------------------------------------------------ */

export function computeYDomain(data: SimPoint[], tags: string[]): { min: number; max: number } {
  let min = Infinity;
  let max = -Infinity;
  for (const pt of data) {
    for (const tag of tags) {
      const v = pt.values[tag];
      if (v !== undefined) {
        if (v < min) min = v;
        if (v > max) max = v;
      }
    }
  }
  if (!isFinite(min)) { min = 0; max = 100; }
  const pad = (max - min) * 0.1 || 5;
  return { min: min - pad, max: max + pad };
}

export function niceStep(range: number, targetTicks: number): number {
  const raw = range / targetTicks;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  const nice = norm < 1.5 ? 1 : norm < 3.5 ? 2 : norm < 7.5 ? 5 : 10;
  return nice * mag;
}

/* ------------------------------------------------------------------ */
/*  CSV Export                                                         */
/* ------------------------------------------------------------------ */

export function exportCsv(data: SimPoint[], tags: string[]): void {
  const header = ['timestamp', ...tags].join(',');
  const rows = data.map((pt) => {
    const ts = new Date(pt.t).toISOString();
    const vals = tags.map((tag) => pt.values[tag]?.toFixed(2) ?? '');
    return [ts, ...vals].join(',');
  });
  const csv = [header, ...rows].join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `trend_${Date.now()}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}
