/**
 * ChartExport — Exports chart data as CSV.
 *
 * Renders a small dropdown panel with an export button.
 * On click, builds a CSV file in-memory and triggers a browser download
 * via Blob + URL.createObjectURL.
 *
 * CSV format:
 *   Timestamp,<series1 label>,<series2 label>,...
 *   2024-01-15T12:00:00.000Z,23.4,6.8,...
 *
 * File name: <chartTitle>_<from>_<to>.csv  (sanitised)
 */

import React, { useCallback } from 'react';
import type { ChartLine, HistoricalDataPoint } from '../../types/scada-runtime.types';
import type { TrendTimeRange } from '../../hooks/useTrendData';

/* ------------------------------------------------------------------ */
/*  Props                                                               */
/* ------------------------------------------------------------------ */

export interface ChartExportProps {
  lines: ChartLine[];
  data: Record<string, HistoricalDataPoint[]>;
  chartTitle?: string;
  currentRange: TrendTimeRange;
  onClose: () => void;
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                             */
/* ------------------------------------------------------------------ */

/** Escape a CSV field value per RFC 4180. */
function escapeCsvField(value: string): string {
  if (value.includes(',') || value.includes('"') || value.includes('\n')) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

/** Format a Date for a filename segment (ISO-ish, filesystem-safe). */
function toFilenameDate(d: Date): string {
  return d.toISOString().slice(0, 19).replace(/[T:]/g, '-');
}

/** Sanitise a string for use in a filename. */
function sanitiseFilename(s: string): string {
  return s.replace(/[^a-zA-Z0-9_\-]/g, '_').slice(0, 64);
}

/** Resolve TrendTimeRange to absolute {from, to} for the filename. */
function resolveRangeDates(range: TrendTimeRange): { from: Date; to: Date } {
  if (typeof range === 'object' && 'from' in range) return range;
  const MS: Record<string, number> = {
    last1h:  3_600_000,
    last8h:  28_800_000,
    last1d:  86_400_000,
    last3d:  259_200_000,
    last1w:  604_800_000,
    last1m:  2_592_000_000,
  };
  const to = new Date();
  const fromMs = MS[range as string] ?? 3_600_000;
  return { from: new Date(to.getTime() - fromMs), to };
}

/* ------------------------------------------------------------------ */
/*  CSV builder                                                         */
/* ------------------------------------------------------------------ */

function buildCsv(lines: ChartLine[], data: Record<string, HistoricalDataPoint[]>): string {
  if (lines.length === 0) return '';

  // Collect all unique timestamps (ms) across all series
  const tsSet = new Set<number>();
  for (const line of lines) {
    const pts = data[line.tagId] ?? [];
    for (const pt of pts) tsSet.add(pt.timestamp);
  }

  const timestamps = [...tsSet].sort((a, b) => a - b);
  if (timestamps.length === 0) return 'Timestamp\n';

  // Index points per tagId → map<timestamp → value>
  const seriesMaps: Map<number, number | string>[] = lines.map((line) => {
    const m = new Map<number, number | string>();
    const pts = data[line.tagId] ?? [];
    for (const pt of pts) m.set(pt.timestamp, pt.value);
    return m;
  });

  // Header
  const header = ['Timestamp', ...lines.map((l) => escapeCsvField(l.label))].join(',');

  // Rows
  const rows = timestamps.map((ts) => {
    const isoTimestamp = new Date(ts).toISOString();
    const values = seriesMaps.map((m) => {
      const v = m.get(ts);
      return v == null ? '' : escapeCsvField(String(v));
    });
    return [isoTimestamp, ...values].join(',');
  });

  return [header, ...rows].join('\r\n') + '\r\n';
}

/* ------------------------------------------------------------------ */
/*  Component                                                           */
/* ------------------------------------------------------------------ */

export const ChartExport: React.FC<ChartExportProps> = ({
  lines,
  data,
  chartTitle,
  currentRange,
  onClose,
}) => {
  const handleExportCsv = useCallback(() => {
    const csv = buildCsv(lines, data);
    if (!csv) return;

    const { from, to } = resolveRangeDates(currentRange);
    const titlePart = sanitiseFilename(chartTitle ?? 'chart');
    const fromPart = toFilenameDate(from);
    const toPart = toFilenameDate(to);
    const filename = `${titlePart}_${fromPart}_${toPart}.csv`;

    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);

    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    anchor.style.display = 'none';
    document.body.appendChild(anchor);
    anchor.click();

    // Cleanup: revoke after the browser has had time to initiate the download
    setTimeout(() => {
      URL.revokeObjectURL(url);
      document.body.removeChild(anchor);
    }, 100);

    onClose();
  }, [lines, data, chartTitle, currentRange, onClose]);

  const hasData = lines.some((l) => (data[l.tagId]?.length ?? 0) > 0);

  return (
    <div
      className="bg-white border border-gray-200 rounded shadow-lg py-1 min-w-[160px] z-50"
      role="menu"
      aria-label="Export options"
    >
      <button
        type="button"
        role="menuitem"
        onClick={handleExportCsv}
        disabled={!hasData}
        className="flex items-center gap-2 w-full text-left px-3 py-2 text-xs text-gray-700 hover:bg-blue-50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
      >
        <span className="text-base leading-none">⬇</span>
        Export as CSV
      </button>

      {!hasData && (
        <p className="px-3 py-1 text-xs text-gray-400 italic">No data to export</p>
      )}

      <hr className="my-1 border-gray-100" />

      <button
        type="button"
        role="menuitem"
        onClick={onClose}
        className="flex items-center gap-2 w-full text-left px-3 py-2 text-xs text-gray-500 hover:bg-gray-50 transition-colors"
      >
        Cancel
      </button>
    </div>
  );
};
