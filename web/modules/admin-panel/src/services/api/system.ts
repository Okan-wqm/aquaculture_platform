/**
 * System Metrics API
 */

import { apiFetch } from '../http-client';
import type { SystemMetrics, ServiceHealth, CircuitBreakerStatus } from '../types';
import {
  ADMIN_API_ROUTES,
  type AdminApiRouteQuery,
} from '../types/generated/admin-route-contracts';

type MetricTrendQuery = AdminApiRouteQuery<'GET /system/metrics/trends'>;

export const systemApi = {
  getMetrics: () => apiFetch(ADMIN_API_ROUTES['GET /system/metrics']),
  getDatabaseMetrics: () => apiFetch(ADMIN_API_ROUTES['GET /system/metrics/database']),
  getPlatformMetrics: () => apiFetch(ADMIN_API_ROUTES['GET /system/metrics/platform']),
  getResourceMetrics: () => apiFetch(ADMIN_API_ROUTES['GET /system/metrics/resources']),
  getServicesHealth: () => apiFetch(ADMIN_API_ROUTES['GET /system/services/health']),
  getMetricTrends: (metric: MetricTrendQuery['metric'], interval: MetricTrendQuery['interval']) =>
    apiFetch(ADMIN_API_ROUTES['GET /system/metrics/trends'], {
      query: { metric: metric, interval: interval },
    }),
  getCircuitBreakers: () => apiFetch(ADMIN_API_ROUTES['GET /health/circuit-breakers']),
  resetCircuitBreaker: (name: string) =>
    apiFetch(ADMIN_API_ROUTES['POST /health/circuit-breakers/:name/reset'], {
      path: { name: name },
    }),
};
