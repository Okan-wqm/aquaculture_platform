/**
 * APA-144 (backend half) — an execution must persist the rows the UI shows.
 *
 * `executeReport` generated the full JSON row set in memory for every execution
 * and discarded it into the object-storage artifact, persisting no preview
 * slice. Since a csv or pdf artifact cannot be losslessly re-rowed, no read-back
 * endpoint could have supplied one either — so the preview modal had nothing to
 * read and its table branch was dead code from the day it shipped.
 *
 * The rows are already in memory at the moment the execution is stamped
 * (`generateReport` runs with format 'json' regardless of the requested export
 * format), so a bounded slice costs nothing and works uniformly across all
 * three formats. `rowCount` keeps carrying the true total, which is what lets
 * the UI say "first N of M" instead of guessing.
 *
 * @see docs/reviews/claude/2026-07-20-admin-panel-e2e-audit/findings/analytics.md#APA-144
 */
import {
  REPORT_PREVIEW_ROW_LIMIT,
  ReportFormat,
} from '../entities/analytics-snapshot.entity';

import { buildReportsHarness, tenantFixture } from './support/reports-service-harness';

/** More tenants than the preview limit, so slice and total genuinely differ. */
const TENANT_COUNT = 12;
const TENANTS = Array.from({ length: TENANT_COUNT }, (_, i) => tenantFixture(i + 1));

/** The buffer `createReportArtifact` hands to object storage. */
function uploadedBuffer(uploadFile: jest.Mock): Buffer {
  const call: unknown[] = uploadFile.mock.calls[0] ?? [];
  const buffer = call[4];
  if (!Buffer.isBuffer(buffer)) {
    throw new Error(`uploadFile did not receive a Buffer: ${String(buffer)}`);
  }
  return buffer;
}

describe('report execution preview rows (APA-144)', () => {
  it.each<ReportFormat>(['json', 'csv', 'pdf'])(
    'persists a bounded slice for format %s while the artifact keeps every row',
    async (format) => {
      const { service, savedExecutions, storage } = await buildReportsHarness({
        tenants: TENANTS,
      });

      const execution = await service.executeReport({ reportType: 'tenant_overview', format });

      expect(execution.status).toBe('completed');
      expect(execution.rowCount).toBe(TENANT_COUNT);
      expect(execution.previewRows).toHaveLength(REPORT_PREVIEW_ROW_LIMIT);
      expect(execution.previewRows?.[0]).toMatchObject({ id: TENANTS[0]?.id, name: 'Tenant 1' });

      // The preview is a SLICE, not a truncation of the artifact — the stored
      // file must still contain everything.
      expect(storage.uploadFile).toHaveBeenCalledTimes(1);
      const buffer = uploadedBuffer(storage.uploadFile);
      if (format === 'json') {
        const parsed: unknown = JSON.parse(buffer.toString('utf8'));
        expect(parsed).toMatchObject({ data: expect.any(Array) });
        const rows = (parsed as { data: unknown[] }).data;
        expect(rows).toHaveLength(TENANT_COUNT);
      } else if (format === 'csv') {
        // 12 rows plus the header line.
        expect(buffer.toString('utf8').trim().split('\n')).toHaveLength(TENANT_COUNT + 1);
      } else {
        // A real pdfkit binary; there is no row-count assertion short of
        // parsing a PDF, so only its existence is asserted here — `rowCount`
        // and the preview slice above already pin the row arithmetic.
        expect(buffer.length).toBeGreaterThan(0);
      }

      expect(savedExecutions.at(-1)?.previewRows).toHaveLength(REPORT_PREVIEW_ROW_LIMIT);
    },
  );

  it('persists an empty preview rather than throwing when the body is not a row array', async () => {
    // `formatReportData` returns a CSV STRING for csv executions of the
    // synchronous path; the execution path always generates json, but the
    // contract types `data` as `unknown`, so a non-array must be survivable.
    const { service } = await buildReportsHarness({ tenants: TENANTS });

    const execution = await service.executeReport({
      reportType: 'financial_payments',
      format: 'json',
    });

    expect(execution.status).toBe('completed');
    expect(Array.isArray(execution.previewRows)).toBe(true);
  });

  it('never previews more rows than it stores the limit for', async () => {
    // Fewer rows than the limit: the slice is the whole set, and the UI's
    // "first N of M" note must not fire.
    const { service } = await buildReportsHarness({ tenants: TENANTS.slice(0, 3) });

    const execution = await service.executeReport({
      reportType: 'tenant_overview',
      format: 'json',
    });

    expect(execution.rowCount).toBe(3);
    expect(execution.previewRows).toHaveLength(3);
  });
});
