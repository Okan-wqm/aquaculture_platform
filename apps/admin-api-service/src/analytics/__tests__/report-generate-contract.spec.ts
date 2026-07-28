/**
 * APA-146 — `POST /reports/generate` must not hand back a link that cannot
 * resolve.
 *
 * `generateReport` minted an ephemeral id `rpt_<ts>_<hex>` and, for csv and
 * pdf, advertised `/api/reports/download/${id}`. The only route that matches is
 * `GET reports/download/:reportType`, whose path parameter is a report TYPE
 * validated against the seven literals — an `rpt_…` segment always 400s. The
 * link was not merely broken but structurally unresolvable: the synchronous
 * result is never persisted, so no by-id route could be built for it either.
 *
 * The cure is removal, not repointing. Aiming it at
 * `/api/reports/download/${type}` would be a subtler lie — that route
 * re-generates a DIFFERENT report over a default 30-day window instead of
 * returning the one the caller just received.
 *
 * @see docs/reviews/claude/2026-07-20-admin-panel-e2e-audit/findings/analytics.md#APA-146
 */
import { REPORT_TYPES, ReportFormat } from '../entities/analytics-snapshot.entity';

import { buildReportsHarness, reportRequest, tenantFixture } from './support/reports-service-harness';

/** Every field the synchronous result contract carries. Asserted as a whole set
 *  so a re-added link is caught whatever it is named. */
const REPORT_RESULT_KEYS = ['data', 'format', 'generatedAt', 'id', 'summary', 'title', 'type'];

describe('synchronous report result contract (APA-146)', () => {
  it.each<ReportFormat>(['csv', 'pdf', 'json'])(
    'carries no download link for format %s',
    async (format) => {
      const { service } = await buildReportsHarness({ tenants: [tenantFixture(1)] });

      const result = await service.generateReport(reportRequest('tenant_overview', format));

      // csv and pdf are the two formats the dead link was special-cased to;
      // json is asserted too so the invariant covers the whole contract rather
      // than only the branch that used to set it.
      expect(Object.keys(result).sort()).toEqual(REPORT_RESULT_KEYS);
    },
  );

  it('keys the download route by report type, never by a generated result id', async () => {
    // This is why an `rpt_…` id could never resolve there: the route's
    // vocabulary is the report-type SSoT, and an ephemeral id is not a member
    // of it — nor can it become one, since nothing persists the result.
    expect(REPORT_TYPES).toHaveLength(7);
    expect(REPORT_TYPES).not.toContain('rpt_1700000000000_deadbeef');
  });
});
