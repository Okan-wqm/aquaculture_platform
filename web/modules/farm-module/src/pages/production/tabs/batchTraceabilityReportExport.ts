/**
 * Batch traceability report export (print-to-PDF path).
 *
 * WHY: operators hand the traceability report to auditors/buyers, so the tab
 * needs a self-contained printable document (tables only, no external assets).
 *
 * WHAT: `buildBatchTraceabilityReportHtml` is a PURE builder — traceability
 * data in, complete HTML document out, every interpolated value routed through
 * the shared `escapeHtml` (reused from waterChemistryReportExport so there is
 * one escaping SSoT). `printBatchTraceabilityReport` renders that HTML into a
 * hidden iframe and triggers the browser print dialog — same mechanism as
 * `printWaterChemistryReport`, with this report's own accessible title.
 */
import type {
  BatchFeedTotal,
  BatchResidency,
  BatchResidencyWaterSummary,
  BatchTraceability,
  BatchTraceabilityEvent,
} from '../../../hooks/useBatchTraceability';
import { escapeHtml } from '../../water-chemistry/waterChemistryReportExport';

/** Em-dash placeholder for absent values — matches the tabs' display idiom. */
const EMPTY_VALUE = '—';

/** Format an ISO date string as dd/mm/yyyy; em-dash when absent. */
export function formatTraceabilityDate(value: string | null | undefined): string {
  if (!value) return EMPTY_VALUE;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? EMPTY_VALUE : parsed.toLocaleDateString('en-GB');
}

/** Format an ISO date string as a local date-time; em-dash when absent. */
export function formatTraceabilityDateTime(value: string | null | undefined): string {
  if (!value) return EMPTY_VALUE;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? EMPTY_VALUE : parsed.toLocaleString('en-GB');
}

/** Fixed-decimal number; em-dash when the backend sent null. */
export function formatDecimal(value: number | null | undefined, digits = 1): string {
  return value === null || value === undefined ? EMPTY_VALUE : value.toFixed(digits);
}

/** Thousands-grouped integer quantity (en-US grouping to match the tab). */
export function formatQuantity(value: number | null | undefined): string {
  return value === null || value === undefined ? EMPTY_VALUE : value.toLocaleString('en-US');
}

/**
 * "min / avg / max" °C cell for one residency. A residency with zero
 * measurements shows a single em-dash — no fake zero temperatures.
 */
export function formatWaterTemperature(water: BatchResidencyWaterSummary): string {
  if (water.measurementCount === 0) return EMPTY_VALUE;
  return `${formatDecimal(water.temperatureMinC)} / ${formatDecimal(water.temperatureAvgC)} / ${formatDecimal(water.temperatureMaxC)}`;
}

/** "movedAt → exitedAt|current" period label for one residency. */
export function formatResidencyPeriod(residency: BatchResidency): string {
  const from = formatTraceabilityDate(residency.movedAt);
  const to = residency.isCurrent ? 'current' : formatTraceabilityDate(residency.exitedAt);
  return `${from} → ${to}`;
}

/**
 * Signed quantity/biomass delta (e.g. "+500", "-120.5") so timeline rows read
 * as movements; em-dash when the event carries no delta.
 */
export function formatSignedNumber(value: number | null | undefined, digits = 0): string {
  if (value === null || value === undefined) return EMPTY_VALUE;
  const formatted = value.toFixed(digits);
  return value > 0 ? `+${formatted}` : formatted;
}

/** Human label for the GraphQL enum KEY, e.g. 'STATUS_CHANGED' → 'status changed'. */
export function formatEventTypeLabel(eventType: string): string {
  return eventType.replace(/_/g, ' ').toLowerCase();
}

/** Escaped `<th>…</th><td>…</td>`-style label/value rows table. */
function summaryTableHtml(rows: ReadonlyArray<readonly [string, string]>): string {
  return `
    <table class="pairs">
      ${rows
        .map(
          ([label, value]) =>
            `<tr><td class="label">${escapeHtml(label)}</td><td>${escapeHtml(value)}</td></tr>`,
        )
        .join('')}
    </table>`;
}

/** Escaped headed data table with an honest empty-state row. */
function headedTableHtml(title: string, headers: readonly string[], rows: string[][]): string {
  const headerHtml = `<tr>${headers.map((header) => `<th>${escapeHtml(header)}</th>`).join('')}</tr>`;
  const bodyHtml =
    rows.length > 0
      ? rows
          .map((row) => `<tr>${row.map((cell) => `<td>${escapeHtml(cell)}</td>`).join('')}</tr>`)
          .join('')
      : `<tr><td class="empty" colspan="${headers.length}">No records</td></tr>`;
  return `
    <div class="section">
      <div class="section-title">${escapeHtml(title)}</div>
      <table class="data">${headerHtml}${bodyHtml}</table>
    </div>`;
}

function residencyRows(residencies: BatchResidency[]): string[][] {
  return residencies.map((residency) => [
    residency.tankName ?? EMPTY_VALUE,
    residency.tankCode ?? EMPTY_VALUE,
    formatResidencyPeriod(residency),
    formatDecimal(residency.durationDays, 0),
    formatQuantity(residency.quantityAtEntry),
    formatDecimal(residency.avgWeightAtEntryG),
    formatWaterTemperature(residency.water),
    formatDecimal(residency.feedTotalKg),
  ]);
}

function feedTotalRows(feedTotals: BatchFeedTotal[]): string[][] {
  return feedTotals.map((feed) => [
    feed.feedName ?? EMPTY_VALUE,
    feed.feedCode ?? EMPTY_VALUE,
    formatDecimal(feed.totalKg),
    formatDecimal(feed.totalCost, 2),
  ]);
}

function eventRows(events: BatchTraceabilityEvent[]): string[][] {
  // Reverse-chron so the printout reads the same way as the on-screen timeline.
  return [...events]
    .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
    .map((event) => [
      formatTraceabilityDateTime(event.timestamp),
      formatEventTypeLabel(event.eventType),
      event.description,
      event.tankCode ?? EMPTY_VALUE,
      formatSignedNumber(event.quantityChange),
      formatSignedNumber(event.biomassChangeKg, 1),
      event.performedBy ?? EMPTY_VALUE,
    ]);
}

/**
 * Pure HTML builder for the printable traceability report. `generatedAt` is a
 * parameter (defaulted at the print callsite) so specs can pin a fixed clock.
 */
export function buildBatchTraceabilityReportHtml(
  data: BatchTraceability,
  generatedAt: Date = new Date(),
): string {
  const { summary } = data;

  const summaryRows: ReadonlyArray<readonly [string, string]> = [
    ['Batch', summary.batchNumber],
    ['Status', summary.status],
    ['Species', summary.speciesName ?? EMPTY_VALUE],
    ['Feeding protocol', summary.protocolName ?? EMPTY_VALUE],
    ['Stocked at', formatTraceabilityDate(summary.stockedAt)],
    ['Harvested at', formatTraceabilityDate(summary.harvestedAt)],
    ['Days in production', String(summary.daysInProduction)],
    ['Initial quantity', formatQuantity(summary.initialQuantity)],
    ['Current quantity', formatQuantity(summary.currentQuantity)],
    ['Initial avg weight (g)', formatDecimal(summary.initialAvgWeightG)],
    ['Current avg weight (g)', formatDecimal(summary.currentAvgWeightG)],
    ['Survival rate (%)', formatDecimal(summary.survivalRatePercent)],
    ['Total feed (kg)', formatDecimal(summary.totalFeedKg)],
    ['Total feed cost', formatDecimal(summary.totalFeedCost, 2)],
    ['FCR (actual)', formatDecimal(summary.fcrActual, 2)],
  ];

  return `<!DOCTYPE html><html><head><title>Batch Traceability Report</title>
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
    <style>
      @page { size: A4; margin: 10mm; }
      * { box-sizing: border-box; margin: 0; padding: 0; }
      body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; font-size: 10px; color: #111; }
      .header { display: flex; justify-content: space-between; align-items: baseline; border-bottom: 2px solid #111; padding-bottom: 4px; margin-bottom: 8px; }
      .header h1 { font-size: 16px; }
      .header .date { font-size: 10px; color: #666; }
      .section { margin-bottom: 10px; }
      .section-title { font-size: 11px; font-weight: bold; margin-bottom: 3px; border-bottom: 1px solid #333; padding-bottom: 2px; }
      table.pairs { width: 100%; border-collapse: collapse; font-size: 10px; margin-bottom: 10px; }
      table.pairs td { padding: 2px 6px; border: 1px solid #ddd; }
      table.pairs td.label { background: #f9fafb; font-weight: 500; width: 28%; }
      table.data { width: 100%; border-collapse: collapse; font-size: 9.5px; }
      table.data th { padding: 2px 6px; border: 1px solid #ddd; background: #f3f4f6; text-align: left; font-weight: 600; }
      table.data td { padding: 2px 6px; border: 1px solid #ddd; }
      table.data td.empty { text-align: center; color: #666; }
      @media print {
        body { -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; }
      }
    </style></head><body>
      <div class="header">
        <div><h1>Batch Traceability Report</h1><div class="date">Generated ${escapeHtml(generatedAt.toLocaleString('en-GB'))}</div></div>
        <div style="text-align:right;font-size:11px;font-weight:600">${escapeHtml(summary.batchNumber)}</div>
      </div>
      <div class="section">
        <div class="section-title">Summary</div>
        ${summaryTableHtml(summaryRows)}
      </div>
      ${headedTableHtml(
        'Where the fish lived (tank residencies)',
        [
          'Tank',
          'Code',
          'Period',
          'Days',
          'Qty at entry',
          'Avg weight at entry (g)',
          'Water temp °C (min / avg / max)',
          'Feed (kg)',
        ],
        residencyRows(data.residencies),
      )}
      ${headedTableHtml(
        'Feed totals',
        ['Feed', 'Code', 'Total (kg)', 'Total cost'],
        feedTotalRows(data.feedTotals),
      )}
      ${headedTableHtml(
        'Events timeline',
        ['Timestamp', 'Event', 'Description', 'Tank', 'Qty change', 'Biomass change (kg)', 'Performed by'],
        eventRows(data.events),
      )}
    </body></html>`;
}

function printFrame(frameWindow: Window, cleanup: () => void): void {
  try {
    frameWindow.focus?.();
    frameWindow.print();
  } catch {
    // Some test and kiosk environments expose a non-callable native print shim.
  } finally {
    window.setTimeout(cleanup, 1000);
  }
}

/**
 * Build the report HTML for `data` and print it through a hidden iframe —
 * mirrors printWaterChemistryReport (same off-screen iframe mechanism) with
 * this report's own accessible frame title. No-ops when no document body
 * exists (SSR / detached environments).
 */
export function printBatchTraceabilityReport(data: BatchTraceability): void {
  if (!document?.body) {
    return;
  }

  const html = buildBatchTraceabilityReportHtml(data);

  const frame = document.createElement('iframe');
  frame.setAttribute('title', 'Batch Traceability Report');
  frame.style.position = 'fixed';
  frame.style.width = '1px';
  frame.style.height = '1px';
  frame.style.left = '-10000px';
  frame.style.top = '0';
  document.body.appendChild(frame);

  const frameWindow = frame.contentWindow;
  const frameDocument = frame.contentDocument ?? frameWindow?.document;
  if (!frameWindow || !frameDocument) {
    frame.remove();
    return;
  }

  frameDocument.open();
  frameDocument.write(html);
  frameDocument.close();
  window.setTimeout(() => printFrame(frameWindow, () => frame.remove()), 0);
}
