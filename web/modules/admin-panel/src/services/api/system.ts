/**
 * System Metrics API
 */

import { apiFetch } from '../http-client';
import type { SystemMetrics, ServiceHealth, CircuitBreakerStatus } from '../types';

export const systemApi = {
  getMetrics: () => apiFetch<SystemMetrics>('/system/metrics'),
  getDatabaseMetrics: () => apiFetch<SystemMetrics['database']>('/system/metrics/database'),
  getPlatformMetrics: () => apiFetch<SystemMetrics['platform']>('/system/metrics/platform'),
  getResourceMetrics: () => apiFetch<SystemMetrics['resources']>('/system/metrics/resources'),
  getServicesHealth: () => apiFetch<ServiceHealth[]>('/system/services/health'),
  getMetricTrends: (metric: string, interval: string) =>
    apiFetch<Array<{ timestamp: string; value: number }>>(`/system/metrics/trends?metric=${metric}&interval=${interval}`),
  getCircuitBreakers: () =>
    apiFetch<CircuitBreakerStatus>('/health/circuit-breakers', {
      responseContract: 'raw-json',
    }),
  resetCircuitBreaker: (name: string) =>
    apiFetch<{ success: boolean; name: string; state: string }>(
      `/health/circuit-breakers/${name}/reset`,
      { method: 'POST', responseContract: 'raw-json' },
    ),
};
