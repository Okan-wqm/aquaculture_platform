/**
 * CSV export for persisted regulatory report submissions (FARM-LOW-119).
 *
 * The Reports page Export button previously rendered with no onClick.
 * It now downloads the active tab's real submission rows as CSV via
 * these helpers: a pure builder (unit-testable) and a Blob download.
 */
import type { RegulatoryReportRow } from '../../../hooks/useRegulatoryReports';

const HEADER = [
  'reportType',
  'period',
  'klientReferanse',
  'status',
  'lokalitetsnummer',
  'siteId',
  'referanse',
  'feilmelding',
  'submittedAt',
  'createdAt',
] as const;

function csvEscape(value: string): string {
  // SEC-MEDIUM-002 — CSV formula/injection neutralisation. A cell whose value
  // (e.g. a Mattilsynet `feilmelding` echoed back) begins with a character a
  // spreadsheet would evaluate as a formula — '=', '+', '-', '@', tab, or CR —
  // is prefixed with a single quote so it opens as literal text and never
  // executes (OWASP CSV Injection). RFC-4180 quoting still applies.
  const guarded = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  if (/[",\n\r]/.test(guarded)) {
    return `"${guarded.replace(/"/g, '""')}"`;
  }
  return guarded;
}

export function periodLabelForCsv(row: RegulatoryReportRow): string {
  if (row.reportWeek && row.reportYear) return `${row.reportYear}-W${row.reportWeek}`;
  if (row.reportMonth && row.reportYear) {
    return `${row.reportYear}-${String(row.reportMonth).padStart(2, '0')}`;
  }
  return row.createdAt.slice(0, 10);
}

export function buildSubmissionsCsv(rows: RegulatoryReportRow[]): string {
  const lines = [HEADER.join(',')];
  for (const row of rows) {
    lines.push(
      [
        row.reportType,
        periodLabelForCsv(row),
        row.klientReferanse,
        row.status,
        String(row.lokalitetsnummer),
        row.siteId ?? '',
        row.referanse ?? '',
        row.feilmelding ?? '',
        row.submittedAt ?? '',
        row.createdAt,
      ]
        .map(csvEscape)
        .join(','),
    );
  }
  return lines.join('\n') + '\n';
}

export function downloadCsv(filename: string, csv: string): void {
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);
}
