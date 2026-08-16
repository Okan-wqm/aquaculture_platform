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
  it('does NOT clear the global default prom-client registry on init', () => {
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

describe('ServiceMetricsService — contributor registries (OBS-HIGH-001)', () => {
  it('serves contributor registry metrics alongside its own on the scrape output', async () => {
    const svc = new ServiceMetricsService();
    svc.onModuleInit();

    // Simulate a domain module's private registry (farm-service pattern).
    const domainRegistry = new client.Registry();
    new client.Counter({
      name: 'farm_capacity_block_total',
      help: 'domain counter held in a private registry',
      registers: [domainRegistry],
    });

    svc.registerContributor('farm-domain', domainRegistry);
    const text = await svc.getMetrics();

    // Both the platform HTTP families AND the contributed domain family
    // appear in ONE exposition document — Prometheus scrapes a single
    // endpoint per service.
    expect(text).toContain('http_requests_total');
    expect(text).toContain('farm_capacity_block_total');
    // Exposition document stays well-formed: exactly one trailing newline.
    expect(text.endsWith('\n')).toBe(true);
    expect(text.endsWith('\n\n')).toBe(false);

    svc.onModuleDestroy();
  });

  it('invalidates the scrape cache when a contributor registers between scrapes', async () => {
    const svc = new ServiceMetricsService();
    svc.onModuleInit();

    // Prime the 5s output cache BEFORE the contributor exists.
    const before = await svc.getMetrics();
    expect(before).not.toContain('late_domain_counter_total');

    const domainRegistry = new client.Registry();
    new client.Counter({
      name: 'late_domain_counter_total',
      help: 'registered after the first scrape',
      registers: [domainRegistry],
    });
    svc.registerContributor('late-domain', domainRegistry);

    // WITHOUT cache invalidation in registerContributor this scrape would
    // serve the stale pre-contributor document for up to cacheTtlMs.
    const after = await svc.getMetrics();
    expect(after).toContain('late_domain_counter_total');

    svc.onModuleDestroy();
  });

  it('re-registering the same contributor name replaces, not duplicates', async () => {
    const svc = new ServiceMetricsService();
    svc.onModuleInit();

    const first = new client.Registry();
    new client.Counter({ name: 'replaced_total', help: 'first', registers: [first] });
    const second = new client.Registry();
    new client.Counter({ name: 'kept_total', help: 'second', registers: [second] });

    svc.registerContributor('domain', first);
    svc.registerContributor('domain', second);
    const text = await svc.getMetrics();

    expect(text).toContain('kept_total');
    expect(text).not.toContain('replaced_total');

    svc.onModuleDestroy();
  });
});
