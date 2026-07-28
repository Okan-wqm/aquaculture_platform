/**
 * APA-133 (report side) + APA-142 — the usage reports must never emit a corrupt
 * number, and must never emit a report at all when nothing was measured.
 *
 * APA-133: both summaries divided by `data.length`. That was invisible while
 * `getUsageMetrics()` fabricated a fully-keyed map (length 7 / 6), but the
 * moment the maps became honestly empty the averages evaluated to `NaN`, which
 * `JSON.stringify` serialises as `null` in some paths and renders as "NaN" in
 * others — corrupt either way. `mostUsedModule` likewise came from
 * `data.sort(...)[0]?.module` on an in-place sort of the returned rows.
 *
 * APA-142: the empty set no longer reaches those summary paths at all — a
 * report with no measurements is now rejected before it can be produced. So the
 * degenerate-averaging guards are exercised against a SINGLE measured row
 * instead, which is the smallest input that still reaches them; the
 * "nothing measured" cases assert the rejection and its reason.
 *
 * @see docs/reviews/claude/2026-07-20-admin-panel-e2e-audit/findings/analytics.md#APA-133
 * @see docs/reviews/claude/2026-07-20-admin-panel-e2e-audit/findings/analytics.md#APA-142
 */
import { ReportDataSourceUnavailableException } from '../services/reports.service';

import {
  MEASURED,
  MEASURED_SINGLE,
  NOTHING_MEASURED,
  buildReportsHarness,
  reportRequest,
} from './support/reports-service-harness';

describe('usage report integrity (APA-133, APA-142)', () => {
  it('usage_modules: an unmeasured platform produces no report at all', async () => {
    const { service } = await buildReportsHarness({ usage: NOTHING_MEASURED });

    const generate = service.generateReport(reportRequest('usage_modules'));

    await expect(generate).rejects.toBeInstanceOf(ReportDataSourceUnavailableException);
    await expect(generate).rejects.toMatchObject({
      unavailableReason: expect.stringContaining('no producer'),
    });
  });

  it('usage_features: an unmeasured platform produces no report at all', async () => {
    const { service } = await buildReportsHarness({ usage: NOTHING_MEASURED });

    const generate = service.generateReport(reportRequest('usage_features'));

    await expect(generate).rejects.toBeInstanceOf(ReportDataSourceUnavailableException);
    await expect(generate).rejects.toMatchObject({
      unavailableReason: expect.stringContaining('no producer'),
    });
  });

  it('usage_modules: a single measured row still aggregates to a number, not NaN', async () => {
    const { service } = await buildReportsHarness({ usage: MEASURED_SINGLE });

    const result = await service.generateReport(reportRequest('usage_modules'));

    // 5/50 = 10%. The degenerate branches (`avgOrNull` over one element,
    // `mostUsedModule` off a one-row ranking) stay covered now that the empty
    // set is rejected upstream.
    expect(result.summary?.['totalModules']).toBe(1);
    expect(result.summary?.['avgAdoptionRate']).toBe(10);
    expect(result.summary?.['mostUsedModule']).toBe('Alerts');
    expect(Number.isNaN(result.summary?.['avgAdoptionRate'])).toBe(false);
  });

  it('usage_features: a single measured row still aggregates to a number, not NaN', async () => {
    const { service } = await buildReportsHarness({ usage: MEASURED_SINGLE });

    const result = await service.generateReport(reportRequest('usage_features'));

    expect(result.summary?.['totalFeatures']).toBe(1);
    expect(result.summary?.['avgAdoptionRate']).toBe(80);
    expect(Number.isNaN(result.summary?.['avgAdoptionRate'])).toBe(false);
  });

  it('usage_modules: real measurements still aggregate, and row order is untouched', async () => {
    const { service } = await buildReportsHarness({ usage: MEASURED });

    const result = await service.generateReport(reportRequest('usage_modules'));

    // 5/50 = 10%, 25/50 = 50% -> mean 30.
    expect(result.summary?.['avgAdoptionRate']).toBe(30);
    expect(result.summary?.['mostUsedModule']).toBe('Farm Management');
    expect(result.summary?.['totalSessions']).toBe(71);

    // The summary's ranking must not reorder the rows the caller receives —
    // `data.sort()` sorted in place and silently permuted the report body.
    const rows: unknown = result.data;
    expect(Array.isArray(rows)).toBe(true);
    const modules = (Array.isArray(rows) ? rows : []).map((row) =>
      typeof row === 'object' && row !== null ? (row as Record<string, unknown>)['module'] : null,
    );
    expect(modules).toEqual(['Alerts', 'Farm Management']);
  });

  it('usage_features: real measurements still aggregate', async () => {
    const { service } = await buildReportsHarness({ usage: MEASURED });

    const result = await service.generateReport(reportRequest('usage_features'));

    expect(result.summary?.['totalFeatures']).toBe(2);
    expect(result.summary?.['avgAdoptionRate']).toBe(50);
  });
});
