/**
 * APA-142 — no artifact, hash or download link may exist over rows nobody
 * measured.
 *
 * APA-133 closed the FABRICATION half: `getUsageMetrics()` stopped emitting a
 * fully-keyed all-zeros map and the report rows derive from `measuredEntries`.
 * What stayed open is the PROVENANCE half. With nothing measured the usage
 * generators produced ZERO rows, and `executeReport` treated zero rows exactly
 * like a measured empty result: it uploaded a zero-byte CSV to object storage,
 * hashed it (the sha256 of the empty string), stamped `status='completed'`,
 * `rowCount=0` and a 7-day download link. The admin panel maps 'completed' to a
 * green "Ready" badge with a Download button, so a SUPER_ADMIN could not tell
 * "no module was used" from "no producer exists".
 *
 * The cure is two-part and both parts are load-bearing. The typed
 * `ReportBody<TRow>` discriminant (tier 1) makes a generator unable to hand
 * back rows without asserting they were measured. The `'unavailable'` execution
 * status plus ONE central throw in `generateReport` (tier 2) makes all twelve
 * callers correct with no code of their own, and — because the throw precedes
 * `createReportArtifact` — makes an artifact over unmeasured rows structurally
 * unreachable rather than merely guarded against.
 *
 * @see docs/reviews/claude/2026-07-20-admin-panel-e2e-audit/findings/analytics.md#APA-142
 */
import { ReportDataSourceUnavailableException } from '../services/reports.service';

import {
  MEASURED,
  NOTHING_MEASURED,
  buildReportsHarness,
  reportRequest,
} from './support/reports-service-harness';

const UNMEASURED_TYPES = ['usage_modules', 'usage_features'] as const;

describe('unmeasured reports produce no artifact (APA-142)', () => {
  describe.each(UNMEASURED_TYPES)('%s', (reportType) => {
    it('records an unavailable execution carrying no artifact provenance', async () => {
      const { service, savedExecutions, storage } = await buildReportsHarness({
        usage: NOTHING_MEASURED,
      });

      const execution = await service.executeReport({ reportType, format: 'csv' });

      expect(execution.status).toBe('unavailable');
      expect(execution.unavailableReason).toMatch(/no producer/i);

      // The load-bearing assertion: no object in storage means no sha256 and no
      // 7-day link can exist for an unmeasured report — not because a check
      // rejects them, but because the throw happens before they are computed.
      expect(storage.uploadFile).not.toHaveBeenCalled();
      expect(execution.artifactObjectKey).toBeUndefined();
      expect(execution.artifactSha256).toBeUndefined();
      expect(execution.artifactContentType).toBeUndefined();
      expect(execution.downloadUrl).toBeUndefined();
      expect(execution.downloadExpiresAt).toBeUndefined();
      expect(execution.rowCount).toBeUndefined();
      expect(execution.fileSizeBytes).toBeUndefined();

      // Persisted, not swallowed: the request is still audit-worthy.
      expect(savedExecutions.at(-1)?.status).toBe('unavailable');
      expect(savedExecutions.at(-1)?.errorMessage).toBeUndefined();
    });

    it('rejects the synchronous route with 422, not a resolved empty body', async () => {
      const { service } = await buildReportsHarness({ usage: NOTHING_MEASURED });

      const generate = service.generateReport(reportRequest(reportType));

      await expect(generate).rejects.toBeInstanceOf(ReportDataSourceUnavailableException);
      await expect(generate).rejects.toMatchObject({ unavailableReason: expect.any(String) });
      await generate.catch((error: unknown) => {
        expect(error).toBeInstanceOf(ReportDataSourceUnavailableException);
        if (error instanceof ReportDataSourceUnavailableException) {
          expect(error.getStatus()).toBe(422);
        }
      });
    });
  });

  it('still completes and uploads when the producer HAS written measurements', async () => {
    // The gate is availability-driven, not a blanket block on usage reports:
    // wiring the pipeline flips it with no code change.
    const { service, storage } = await buildReportsHarness({ usage: MEASURED });

    const execution = await service.executeReport({ reportType: 'usage_modules', format: 'csv' });

    expect(execution.status).toBe('completed');
    expect(storage.uploadFile).toHaveBeenCalledTimes(1);
    expect(execution.downloadUrl).toBe(`/api/reports/executions/${execution.id}/download`);
    expect(execution.artifactSha256).toEqual(expect.any(String));
  });

  it('treats a table of null metrics as unmeasured, not as a measured system', async () => {
    // Emptiness is not the signal — measuredness is. `generatePerformanceReport`
    // emits one honest all-null row per day when no snapshot exists (APA-143);
    // stamping those `measured: true` would earn the run a sha256 and a link
    // over telemetry nobody collected.
    const { service, storage } = await buildReportsHarness({ rawQueryRows: [] });

    const execution = await service.executeReport({
      reportType: 'system_performance',
      format: 'csv',
    });

    expect(execution.status).toBe('unavailable');
    expect(execution.unavailableReason).toMatch(/no producer/i);
    expect(storage.uploadFile).not.toHaveBeenCalled();
  });

  it('never renders a constant as an observation in a measured usage row', async () => {
    // Kills the two dormant fabrications that would go live the day a producer
    // lands: `trend: 'stable'` on every module and feature row, and
    // `avgUsagePerUser: 0` on every feature row.
    const { service } = await buildReportsHarness({ usage: MEASURED });

    const modules = await service.generateReport(reportRequest('usage_modules'));
    const features = await service.generateReport(reportRequest('usage_features'));

    const moduleRows = Array.isArray(modules.data) ? modules.data : [];
    const featureRows = Array.isArray(features.data) ? features.data : [];
    expect(moduleRows.length).toBeGreaterThan(0);
    expect(featureRows.length).toBeGreaterThan(0);

    for (const row of [...moduleRows, ...featureRows]) {
      expect(row).toMatchObject({ trend: null });
    }
    for (const row of featureRows) {
      expect(row).toMatchObject({ avgUsagePerUser: null });
    }
  });

  it('never caches unavailability, so a new producer is visible immediately', async () => {
    // Availability is a property of the WORLD, not of the report: the 1AM
    // snapshot cron makes `system_performance` producible. Caching "there is no
    // data" for the four-hour TTL would keep a request made at 00:59 answering
    // "no data source" until 04:59, long after the data landed.
    const { service, redis } = await buildReportsHarness({ rawQueryRows: [] });

    await expect(
      service.generateReport(reportRequest('system_performance')),
    ).rejects.toBeInstanceOf(ReportDataSourceUnavailableException);

    expect(redis.setJson).not.toHaveBeenCalled();
  });

  it('discards a cache entry written before the measured discriminant existed', async () => {
    // A four-hour TTL means every key warm at rollout would otherwise decode
    // with `measured === undefined` and report a healthy report as having no
    // data source. Validating the discriminant on read makes that a MISS.
    const { service, redis } = await buildReportsHarness({
      cachedPayload: { data: [{ module: 'Alerts' }], summary: { totalModules: 1 } },
    });

    const result = await service.generateReport(reportRequest('tenant_overview'));

    expect(redis.getJson).toHaveBeenCalledTimes(1);
    // Recomputed from the (empty) tenant repository rather than served stale.
    expect(result.data).toEqual([]);
    expect(result.summary?.['totalTenants']).toBe(0);
  });
});
