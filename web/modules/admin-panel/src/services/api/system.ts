/**
 * System Metrics API
 */

import { apiFetch } from '../http-client';
import type { ServiceHealth, SystemMetrics } from '../types';

export const systemApi = {
  getMetrics: () => apiFetch<SystemMetrics>('/system/metrics'),
  getDatabaseMetrics: () => apiFetch<SystemMetrics['database']>('/system/metrics/database'),
  getPlatformMetrics: () => apiFetch<SystemMetrics['platform']>('/system/metrics/platform'),
  getResourceMetrics: () => apiFetch<SystemMetrics['resources']>('/system/metrics/resources'),
  getServicesHealth: () => apiFetch<ServiceHealth[]>('/system/services/health'),
  getMetricTrends: (metric: string, interval: string) =>
    apiFetch<Array<{ timestamp: string; value: number }>>(
      `/system/metrics/trends?metric=${metric}&interval=${interval}`,
    ),
};
