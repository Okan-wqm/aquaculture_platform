/**
 * ChartExport -- CSV and PNG export for chart data.
 *
 * CSV export:
 *   Builds a CSV file in-memory from series data and triggers a browser
 *   download via Blob + URL.createObjectURL.
 *
 * PNG export:
 *   Takes a ref to the chart container element, uses html2canvas-style
 *   approach via the Canvas API to capture the chart as a PNG image.
 *   For uPlot charts, grabs the internal canvas directly.
 *
 * Also exports standalone utility functions (exportCsv, exportPng)
 * for programmatic use outside the component.
 *
 * CSV format:
 *   Timestamp,<series1 label>,<series2 label>,...
 *   2024-01-15T12:00:00.000Z,23.4,6.8,...
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
  /** Ref to the chart container for PNG export. */
  chartRef?: React.RefObject<HTMLElement | null>;
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
  return s.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
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

/** Trigger a browser download for a Blob. */
function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  anchor.click();
  setTimeout(() => {
    URL.revokeObjectURL(url);
    document.body.removeChild(anchor);
  }, 100);
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

  // Index points per tagId -> map<timestamp, value>
  const seriesMaps: Map<number, number | string | boolean>[] = lines.map((line) => {
    const m = new Map<number, number | string | boolean>();
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
/*  Standalone export utilities                                         */
/* ------------------------------------------------------------------ */

/**
 * Export chart data as CSV. Triggers a browser download.
 */
export function exportCsv(
  lines: ChartLine[],
  data: Record<string, HistoricalDataPoint[]>,
  filename?: string,
): void {
  const csv = buildCsv(lines, data);
  if (!csv) return;
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  downloadBlob(blob, filename ?? 'chart_export.csv');
}

/**
 * Export a chart element as PNG. Takes a ref to either:
 *   - An HTMLCanvasElement (direct canvas export)
 *   - An HTMLElement containing a <canvas> child (e.g. uPlot container)
 *
 * Triggers a browser download.
 */
export async function exportPng(
  element: HTMLElement | HTMLCanvasElement | null,
  filename?: string,
): Promise<void> {
  if (!element) return;

  let canvas: HTMLCanvasElement | null = null;

  if (element instanceof HTMLCanvasElement) {
    canvas = element;
  } else {
    // Look for a canvas child (uPlot renders into a canvas inside the container)
    canvas = element.querySelector('canvas');
  }

  if (!canvas) {
    // Fallback: try to render the element to a canvas using DOM measurement
    // This is a simplified approach that works for SVG-based charts (recharts)
    const svgElement = element.querySelector('svg');
    if (svgElement) {
      canvas = await svgToCanvas(svgElement as SVGSVGElement, element);
    }
  }

  if (!canvas) return;

  canvas.toBlob((blob) => {
    if (!blob) return;
    downloadBlob(blob, filename ?? 'chart_export.png');
  }, 'image/png');
}

/**
 * Convert an SVG element to a canvas for PNG export.
 * Used for recharts-based charts that render as SVG.
 */
async function svgToCanvas(
  svgElement: SVGSVGElement,
  container: HTMLElement,
): Promise<HTMLCanvasElement | null> {
  const rect = container.getBoundingClientRect();
  const width = rect.width || 800;
  const height = rect.height || 400;

  // Serialize the SVG
  const serializer = new XMLSerializer();
  const svgString = serializer.serializeToString(svgElement);
  const svgBlob = new Blob([svgString], { type: 'image/svg+xml;charset=utf-8' });
  const svgUrl = URL.createObjectURL(svgBlob);

  return new Promise<HTMLCanvasElement | null>((resolve) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = width * 2; // 2x for retina
      canvas.height = height * 2;
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;

      const ctx = canvas.getContext('2d');
      if (!ctx) {
        URL.revokeObjectURL(svgUrl);
        resolve(null);
        return;
      }

      // White background
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      ctx.scale(2, 2);
      ctx.drawImage(img, 0, 0, width, height);
      URL.revokeObjectURL(svgUrl);
      resolve(canvas);
    };
    img.onerror = () => {
      URL.revokeObjectURL(svgUrl);
      resolve(null);
    };
    img.src = svgUrl;
  });
}

/* ------------------------------------------------------------------ */
/*  Component                                                           */
/* ------------------------------------------------------------------ */

export const ChartExport: React.FC<ChartExportProps> = ({
  lines,
  data,
  chartTitle,
  currentRange,
  chartRef,
  onClose,
}) => {
  const buildFilename = useCallback(
    (ext: string) => {
      const { from, to } = resolveRangeDates(currentRange);
      const titlePart = sanitiseFilename(chartTitle ?? 'chart');
      const fromPart = toFilenameDate(from);
      const toPart = toFilenameDate(to);
      return `${titlePart}_${fromPart}_${toPart}.${ext}`;
    },
    [chartTitle, currentRange],
  );

  const handleExportCsv = useCallback(() => {
    const csv = buildCsv(lines, data);
    if (!csv) return;
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    downloadBlob(blob, buildFilename('csv'));
    onClose();
  }, [lines, data, buildFilename, onClose]);

  const handleExportPng = useCallback(async () => {
    const element = chartRef?.current;
    if (!element) return;
    await exportPng(element, buildFilename('png'));
    onClose();
  }, [chartRef, buildFilename, onClose]);

  const hasData = lines.some((l) => (data[l.tagId]?.length ?? 0) > 0);
  const hasPngTarget = !!chartRef?.current;

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
        <span className="text-base leading-none">&#11015;</span>
        Export as CSV
      </button>

      <button
        type="button"
        role="menuitem"
        onClick={handleExportPng}
        disabled={!hasPngTarget}
        className="flex items-center gap-2 w-full text-left px-3 py-2 text-xs text-gray-700 hover:bg-blue-50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
      >
        <span className="text-base leading-none">&#128247;</span>
        Export as PNG
      </button>

      {!hasData && !hasPngTarget && (
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
