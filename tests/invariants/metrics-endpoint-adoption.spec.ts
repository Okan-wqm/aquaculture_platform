/**
 * Metrics Endpoint Adoption Invariant (OBS-HIGH-001)
 * ============================================================================
 *
 * SSoT chain:
 *
 *   platform/libs/service-catalog/src/index.ts  → metricsExposure (scrape on containerPort)
 *   libs/backend-common/src/metrics/            → canonical ServiceMetricsModule
 *   THIS FILE                                   → enforces adoption per service
 *
 * # What this spec enforces
 *
 *   1. Every catalog entry with the Prometheus endpoint capability registers
 *      a metrics module in its apps/<serviceId>/src module graph. Without registration the
 *      service boots with NO Prometheus scrape surface — the exact blind
 *      spot OBS-HIGH-001 closed: 10 of 15 NestJS services (alert-engine,
 *      billing, hr, hydroponics, notification, config, event-store, ai,
 *      admin-api, farm) shipped without one.
 *
 *   2. The registered module actually provides a reachable GET /metrics
 *      endpoint. A module whose NAME matches *MetricsModule is not enough
 *      — pre-fix, admin-api-service registered SystemMetricsModule (a JSON
 *      analytics API at /system/metrics) and farm-service registered
 *      FarmMetricsModule (domain counters with no controller at all); both
 *      passed any name-level check while Prometheus had nothing to scrape.
 *      The service tree must therefore contain EITHER a local
 *      @Controller('metrics') (bespoke endpoints: auth, gateway, sensor,
 *      messaging, observability) OR an import of the canonical
 *      ServiceMetricsModule from '@aquaculture/backend-common/metrics'
 *      (whose controller is structurally @Public() + @Controller('metrics')).
 *
 *   3. Every Prometheus-capable catalog entry declares metricsExposure
 *      'prom-endpoint' — a new backend service cannot silently opt out of
 *      observability. (validateServiceCatalog enforces the same rule at
 *      generator time; this assertion makes the failure visible at PR test
 *      time even when no artifact is regenerated.)
 *
 * # When this spec fails
 *
 *   - New backend service without a metrics module → add
 *     `ServiceMetricsModule` (from '@aquaculture/backend-common/metrics')
 *     to the AppModule imports array. That single line provides the
 *     @Public() GET /metrics controller AND self-applies MetricsMiddleware.
 *
 *   - Service has a domain registry that must appear in scrape output →
 *     keep ServiceMetricsModule and call
 *     `serviceMetrics.registerContributor(name, registry)` from the domain
 *     module's onModuleInit (reference: farm-service FarmMetricsModule).
 *
 *   - Prometheus-capable entry declares metricsExposure 'none' → that state is
 *     forbidden; fix the catalog entry (or the buildKind, if the service
 *     genuinely is not a Node HTTP service).
 *
 * # References
 *
 *   - docs/reviews/observability-expert/2026-06-11-metrics-completeness.md
 *   - libs/backend-common/src/metrics/metrics.module.ts (canonical module)
 *   - tests/invariants/adoption-invariants.spec.ts (pattern source)
 */

import * as fs from 'fs';
import * as path from 'path';

// Relative import (not the @platform/service-catalog alias): the invariants
// jest project has no moduleNameMapper for @platform scopes, and the sibling
// platform-service-catalog-parity.spec.ts uses the same relative path.
import {
  PLATFORM_SERVICE_CATALOG,
  metricsEndpointServices,
  supportsPrometheusEndpoint,
  validateServiceCatalog,
} from '../../platform/libs/service-catalog/src';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const APPS_DIR = path.join(REPO_ROOT, 'apps');

const promEndpointServices = metricsEndpointServices();

// Matches any registered metrics-flavored module token in app.module.ts —
// canonical (ServiceMetricsModule), bespoke (AuthMetricsModule,
// SensorMetricsModule, MetricsModule, FarmMetricsModule) and the
// observability-service PrometheusModule.
const METRICS_MODULE_TOKEN = /\b\w*(?:Metrics|Prometheus)\w*Module\b/;

const SCRAPE_CONTROLLER_DECORATOR = /@Controller\(\s*['"]\/?metrics['"]\s*\)/;

/** Recursively list production .ts sources of a service (tests excluded). */
function listServiceSources(serviceId: string): string[] {
  const srcDir = path.join(APPS_DIR, serviceId, 'src');
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const dirent of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, dirent.name);
      if (dirent.isDirectory()) {
        if (dirent.name === '__tests__' || dirent.name === 'node_modules') continue;
        walk(full);
        continue;
      }
      if (dirent.name.endsWith('.ts') && !dirent.name.endsWith('.spec.ts')) {
        out.push(full);
      }
    }
  };
  walk(srcDir);
  return out;
}

describe('Metrics endpoint adoption (OBS-HIGH-001)', () => {
  it('catalog passes its own validation (capable Node runtime ⇒ prom-endpoint)', () => {
    expect(validateServiceCatalog()).toEqual([]);
  });

  it('every Prometheus-capable service kind exposes a Prometheus endpoint', () => {
    const optedOut = PLATFORM_SERVICE_CATALOG.filter(
      (entry) =>
        supportsPrometheusEndpoint(entry.buildKind) && entry.metricsExposure !== 'prom-endpoint',
    ).map((entry) => entry.serviceId);
    expect(optedOut).toEqual([]);
  });

  it('covers the full expected backend fleet (guard against silent catalog shrinkage)', () => {
    // WHY a pinned floor instead of an exact list: the catalog is the SSoT
    // for membership; this spec only guards against the failure mode where
    // a refactor accidentally reclassifies backends out of node-service and
    // the per-service assertions below silently stop running.
    expect(promEndpointServices.length).toBeGreaterThanOrEqual(16);
    expect(promEndpointServices.map((entry) => entry.serviceId)).toContain(
      'farm-feeding-scheduler',
    );
  });

  describe.each(promEndpointServices.map((entry) => [entry.serviceId] as const))(
    'prom-endpoint service %s',
    (serviceId) => {
      it('registers a metrics module in its production module graph', () => {
        const moduleSources = listServiceSources(serviceId).filter((file) =>
          file.endsWith('.module.ts'),
        );
        expect(
          moduleSources.some((file) => METRICS_MODULE_TOKEN.test(fs.readFileSync(file, 'utf-8'))),
        ).toBe(true);
      });

      it('has a reachable GET /metrics scrape surface (local controller or canonical module import)', () => {
        const sources = listServiceSources(serviceId);
        const hasLocalScrapeController = sources.some((file) =>
          SCRAPE_CONTROLLER_DECORATOR.test(fs.readFileSync(file, 'utf-8')),
        );
        const importsCanonicalModule = sources.some((file) => {
          const content = fs.readFileSync(file, 'utf-8');
          return (
            content.includes('ServiceMetricsModule') &&
            content.includes("'@aquaculture/backend-common/metrics'")
          );
        });
        expect(hasLocalScrapeController || importsCanonicalModule).toBe(true);
      });
    },
  );
});
