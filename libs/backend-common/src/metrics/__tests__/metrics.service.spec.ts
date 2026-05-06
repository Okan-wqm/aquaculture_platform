/**
 * Unit tests for ServiceMetricsService — registry isolation.
 *
 * Verifies the PLAT-HIGH-006 fix: ServiceMetricsService MUST NOT mutate
 * the global prom-client default registry. Each instance owns its own
 * dedicated `this.registry` and confines all clear/init operations
 * to that local registry.
 *
 * Closes: docs/reviews/platform-kernel-expert/2026-04-28-core-platform-review.md#PLAT-HIGH-006
 */

import * as client from 'prom-client';
import { ServiceMetricsService } from '../metrics.service';

describe('ServiceMetricsService — registry isolation (PLAT-HIGH-006)', () => {
  it('does NOT clear the global default prom-client registry on init', async () => {
    // Pre-arrange: register a metric against the GLOBAL default registry —
    // simulating what a third-party library or sibling module would do.
    // Use a unique name per test run so we don't collide with the
    // standard process metrics that prom-client may have registered.
    const sentinelName = `__plat_high_006_sentinel_${Date.now()}`;
    new client.Counter({
      name: sentinelName,
      help: 'Marker that the global default registry should retain across ServiceMetricsService init',
    });

    // Act: initialise a ServiceMetricsService.
    const svc = new ServiceMetricsService();
    svc.onModuleInit();

    // Assert: the sentinel metric is STILL registered on the global
    // default registry. Pre-fix the line `client.register.clear()` in
    // onModuleInit() would have wiped it out.
    const metric = client.register.getSingleMetric(sentinelName);
    expect(metric).toBeDefined();

    // Cleanup: remove the sentinel so subsequent test runs in the same
    // process do not see a "duplicate metric" error if the test re-runs.
    client.register.removeSingleMetric(sentinelName);
    svc.onModuleDestroy();
  });

  it('initialises HTTP metrics on its own dedicated registry', async () => {
    const svc = new ServiceMetricsService();
    svc.onModuleInit();
    const text = await svc.getMetrics();
    // The three HTTP metric families MUST be present in the service's
    // registry output.
    expect(text).toContain('http_request_duration_seconds');
    expect(text).toContain('http_requests_total');
    expect(text).toContain('http_requests_in_flight');
    svc.onModuleDestroy();
  });

  it('does not interfere when two service instances are created in the same process', async () => {
    // Two instances should NOT clobber each other (global registry was
    // the failure mode). Each owns its own private registry.
    const a = new ServiceMetricsService();
    const b = new ServiceMetricsService();
    a.onModuleInit();
    b.onModuleInit();
    const aText = await a.getMetrics();
    const bText = await b.getMetrics();
    // Both render the standard HTTP metric families on their own
    // registries — no "metric already registered" exception thrown.
    expect(aText).toContain('http_requests_total');
    expect(bText).toContain('http_requests_total');
    a.onModuleDestroy();
    b.onModuleDestroy();
  });
});
