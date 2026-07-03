/**
 * CSV builder for persisted submissions (FARM-LOW-119).
 */
import { describe, expect, it } from 'vitest';
import { buildSubmissionsCsv, periodLabelForCsv } from '../submissionsCsv';
import type { RegulatoryReportRow } from '../../../../hooks/useRegulatoryReports';

function row(overrides: Partial<RegulatoryReportRow> = {}): RegulatoryReportRow {
  return {
    id: 'rr-1',
    reportType: 'SEA_LICE',
    klientReferanse: 'ref-1',
    siteId: 'site-1',
    lokalitetsnummer: 12345,
    reportYear: 2026,
    reportWeek: 26,
    reportMonth: null,
    status: 'SUBMITTED',
    referanse: 'MT-9',
    feilmelding: null,
    submittedBy: 'user-1',
    submittedAt: '2026-06-30T10:00:00.000Z',
    createdAt: '2026-06-30T09:59:00.000Z',
    ...overrides,
  };
}

describe('periodLabelForCsv', () => {
  it('labels weekly periods as YYYY-Www', () => {
    expect(periodLabelForCsv(row())).toBe('2026-W26');
  });

  it('labels monthly periods as YYYY-MM', () => {
    expect(periodLabelForCsv(row({ reportWeek: null, reportMonth: 6 }))).toBe('2026-06');
  });

  it('falls back to the creation date for immediate reports', () => {
    expect(
      periodLabelForCsv(row({ reportWeek: null, reportYear: null, reportMonth: null })),
    ).toBe('2026-06-30');
  });
});

describe('buildSubmissionsCsv', () => {
  it('emits a header plus one line per row', () => {
    const csv = buildSubmissionsCsv([row(), row({ id: 'rr-2', klientReferanse: 'ref-2' })]);
    const lines = csv.trimEnd().split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain('reportType,period,klientReferanse,status');
    expect(lines[1]).toContain('SEA_LICE,2026-W26,ref-1,SUBMITTED,12345,site-1,MT-9');
  });

  it('escapes commas and quotes in failure messages', () => {
    const csv = buildSubmissionsCsv([
      row({ status: 'FAILED', referanse: null, feilmelding: 'felt: "x", ugyldig' }),
    ]);
    expect(csv).toContain('"felt: ""x"", ugyldig"');
  });

  it('produces only the header for an empty list', () => {
    const csv = buildSubmissionsCsv([]);
    expect(csv.trimEnd().split('\n')).toHaveLength(1);
  });
});
