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
  if (/[",\n\r]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
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
