/**
 * System Metrics API
 */

import { apiFetch } from '../http-client';
import type { SystemMetrics, ServiceHealth, CircuitBreakerStatus } from '../types';

export const systemApi = {
  getMetrics: (signal?: AbortSignal) => apiFetch<SystemMetrics>('/system/metrics', { signal }),
  getDatabaseMetrics: () => apiFetch<SystemMetrics['database']>('/system/metrics/database'),
  getPlatformMetrics: () => apiFetch<SystemMetrics['platform']>('/system/metrics/platform'),
  getResourceMetrics: () => apiFetch<SystemMetrics['resources']>('/system/metrics/resources'),
  getServicesHealth: (signal?: AbortSignal) =>
    apiFetch<ServiceHealth[]>('/system/services/health', { signal }),
  getMetricTrends: (metric: string, interval: string) =>
    apiFetch<Array<{ timestamp: string; value: number }>>(`/system/metrics/trends?metric=${metric}&interval=${interval}`),
  getCircuitBreakers: (signal?: AbortSignal) =>
    apiFetch<CircuitBreakerStatus>('/health/circuit-breakers', { signal }),
  resetCircuitBreaker: (name: string) =>
    apiFetch<{ success: boolean; name: string; state: string }>(`/health/circuit-breakers/${name}/reset`, { method: 'POST' }),
};
