import { adminResponse, type AdminResponseProjection } from '@platform/admin-http-contracts';

export const systemMetricsSystemMetricsContract = adminResponse.object({
  timestamp: adminResponse.string(),
  database: adminResponse.object({
    totalConnections: adminResponse.number(),
    activeConnections: adminResponse.number(),
    idleConnections: adminResponse.number(),
    databaseSize: adminResponse.string(),
    tablesCount: adminResponse.number(),
  }),
  platform: adminResponse.object({
    totalTenants: adminResponse.number(),
    activeTenants: adminResponse.number(),
    totalUsers: adminResponse.number(),
    totalFarms: adminResponse.number(),
    totalSensors: adminResponse.number(),
    activeSensors: adminResponse.number(),
    totalAlertRules: adminResponse.number(),
    activeAlertRules: adminResponse.number(),
    eventsLast24h: adminResponse.number(),
    apiCallsLast24h: adminResponse.number(),
  }),
  resources: adminResponse.object({
    memoryUsage: adminResponse.object({
      heapUsed: adminResponse.number(),
      heapTotal: adminResponse.number(),
      rss: adminResponse.number(),
    }),
    cpuUsage: adminResponse.object({
      user: adminResponse.number(),
      system: adminResponse.number(),
    }),
    uptime: adminResponse.number(),
    nodeVersion: adminResponse.string(),
    platform: adminResponse.string(),
  }),
});

export type SystemMetricsSystemMetricsDto = AdminResponseProjection<
  typeof systemMetricsSystemMetricsContract
>;

export const systemMetricsGetDatabaseMetricsResponseContract = adminResponse.object({
  totalConnections: adminResponse.number(),
  activeConnections: adminResponse.number(),
  idleConnections: adminResponse.number(),
  databaseSize: adminResponse.string(),
  tablesCount: adminResponse.number(),
});

export type SystemMetricsGetDatabaseMetricsResponseDto = AdminResponseProjection<
  typeof systemMetricsGetDatabaseMetricsResponseContract
>;

export const systemMetricsGetPlatformMetricsResponseContract = adminResponse.object({
  totalTenants: adminResponse.number(),
  activeTenants: adminResponse.number(),
  totalUsers: adminResponse.number(),
  totalFarms: adminResponse.number(),
  totalSensors: adminResponse.number(),
  activeSensors: adminResponse.number(),
  totalAlertRules: adminResponse.number(),
  activeAlertRules: adminResponse.number(),
  eventsLast24h: adminResponse.number(),
  apiCallsLast24h: adminResponse.number(),
});

export type SystemMetricsGetPlatformMetricsResponseDto = AdminResponseProjection<
  typeof systemMetricsGetPlatformMetricsResponseContract
>;

export const systemMetricsGetResourceMetricsResponseContract = adminResponse.object({
  memoryUsage: adminResponse.object({
    heapUsed: adminResponse.number(),
    heapTotal: adminResponse.number(),
    rss: adminResponse.number(),
  }),
  cpuUsage: adminResponse.object({
    user: adminResponse.number(),
    system: adminResponse.number(),
  }),
  uptime: adminResponse.number(),
  nodeVersion: adminResponse.string(),
  platform: adminResponse.string(),
});

export type SystemMetricsGetResourceMetricsResponseDto = AdminResponseProjection<
  typeof systemMetricsGetResourceMetricsResponseContract
>;

export const systemMetricsServiceHealthContract = adminResponse.object({
  name: adminResponse.string(),
  status: adminResponse.union([
    adminResponse.literal('healthy'),
    adminResponse.literal('degraded'),
    adminResponse.literal('unhealthy'),
  ] as const),
  responseTime: adminResponse.optional(adminResponse.number()),
  lastCheck: adminResponse.dateString(),
  details: adminResponse.optional(
    adminResponse.record(adminResponse.json('security-audit-context')),
  ),
});

export type SystemMetricsServiceHealthDto = AdminResponseProjection<
  typeof systemMetricsServiceHealthContract
>;

export const systemMetricsGetMetricTrendsResponseContract = adminResponse.object({
  timestamp: adminResponse.dateString(),
  value: adminResponse.number(),
});

export type SystemMetricsGetMetricTrendsResponseDto = AdminResponseProjection<
  typeof systemMetricsGetMetricTrendsResponseContract
>;

export const systemMetricsGetMetricTrendsResponseArrayContract = adminResponse.array(
  systemMetricsGetMetricTrendsResponseContract,
);

export const systemMetricsServiceHealthArrayContract = adminResponse.array(
  systemMetricsServiceHealthContract,
);
