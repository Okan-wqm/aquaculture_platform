import { ServiceMetricsService } from '../metrics.service';
import {
  MODULE_ACCESS_DENIED_METRIC,
  bindModuleAccessService,
  moduleAccessServiceLabel,
  recordModuleAccessDenied,
} from '../module-access-denied.metrics';

/**
 * module_access_denied_total{service,spec_kind} (plan PKG-05, §7 "After each deploy"): every
 * service serves it from its one /metrics endpoint without wiring it, labelled by service and by
 * the access kind of the denied spec.
 */
describe('module_access_denied_total', () => {
  it('is served by every ServiceMetricsService, with service and spec_kind labels', async () => {
    const metrics = new ServiceMetricsService();
    metrics.onModuleInit();
    try {
      recordModuleAccessDenied('farm-service', 'module');
      recordModuleAccessDenied('farm-service', 'unclassified');
      const text = await metrics.getMetrics();
      expect(text).toContain(`# TYPE ${MODULE_ACCESS_DENIED_METRIC} counter`);
      expect(text).toMatch(
        new RegExp(
          `${MODULE_ACCESS_DENIED_METRIC}\\{service="farm-service",spec_kind="module"\\} \\d+`,
        ),
      );
      expect(text).toMatch(
        new RegExp(
          `${MODULE_ACCESS_DENIED_METRIC}\\{service="farm-service",spec_kind="unclassified"\\} \\d+`,
        ),
      );
    } finally {
      metrics.onModuleDestroy();
    }
  });

  it('labels the process with the service its access guards were registered for', () => {
    expect(bindModuleAccessService('sensor-service')).toBe('sensor-service');
    expect(moduleAccessServiceLabel()).toBe('sensor-service');
  });
});
