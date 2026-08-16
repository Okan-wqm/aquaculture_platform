/**
 * System metrics & health types
 */

import type { AdminApiRouteResponse } from './generated/admin-route-contracts';

export interface SystemMetrics {
  timestamp: string;
  database: {
    totalConnections: number;
    activeConnections: number;
    idleConnections: number;
    databaseSize: string;
    tablesCount: number;
  };
  platform: {
    totalTenants: number;
    activeTenants: number;
    totalUsers: number;
    totalFarms: number;
    totalSensors: number;
    activeSensors: number;
    totalAlertRules: number;
    activeAlertRules: number;
    eventsLast24h: number;
    apiCallsLast24h: number;
  };
  resources: {
    memoryUsage: { heapUsed: number; heapTotal: number; rss: number };
    cpuUsage: { user: number; system: number };
    uptime: number;
    nodeVersion: string;
    platform: string;
  };
}

export type ServiceHealth = AdminApiRouteResponse<'GET /system/services/health'>[number];

export type CircuitBreakerStatus = AdminApiRouteResponse<'GET /health/circuit-breakers'>;
