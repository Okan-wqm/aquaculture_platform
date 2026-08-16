import {
  adminManualResponse,
  adminResponse,
  type AdminResponseProjection,
} from '@platform/admin-http-contracts';

const healthOkStatusContract = adminResponse.literal('ok');
const healthReadyStatusContract = adminResponse.union([
  healthOkStatusContract,
  adminResponse.literal('not_ready'),
] as const);

export const healthLivenessProfile = adminManualResponse.health(
  [200],
  adminResponse.object({ status: healthOkStatusContract }),
);

export const healthReadinessProfile = adminManualResponse.health(
  [200, 503],
  adminResponse.object({
    status: healthReadyStatusContract,
    checks: adminResponse.object({
      database: adminResponse.union([
        adminResponse.literal('ok'),
        adminResponse.literal('error'),
      ] as const),
      nats: adminResponse.union([
        adminResponse.literal('ok'),
        adminResponse.literal('error'),
      ] as const),
      smtp: adminResponse.union([
        adminResponse.literal('ok'),
        adminResponse.literal('error'),
      ] as const),
      draining: adminResponse.optional(adminResponse.literal('error')),
    }),
  }),
);

export const healthGeneralProfile = adminManualResponse.health(
  [200],
  adminResponse.object({
    status: healthOkStatusContract,
    timestamp: adminResponse.dateString(),
    uptime: adminResponse.number(),
    version: adminResponse.string(),
    service: adminResponse.string(),
    framework: adminResponse.object({
      nestjs: adminResponse.string(),
      express: adminResponse.string(),
      node: adminResponse.string(),
    }),
  }),
);

export const healthStartupProfile = adminManualResponse.health(
  [200, 503],
  adminResponse.object({
    status: healthReadyStatusContract,
    timestamp: adminResponse.dateString(),
  }),
);

export const healthMetricsResponseContract = adminResponse.object({
  uptime: adminResponse.number(),
  memory: adminResponse.object({
    heapUsed: adminResponse.number(),
    heapTotal: adminResponse.number(),
    external: adminResponse.number(),
    rss: adminResponse.number(),
  }),
  smtp: adminResponse.object({
    state: adminResponse.string(),
    consecutiveFailures: adminResponse.number(),
    lastFailureTime: adminResponse.number(),
  }),
  timestamp: adminResponse.string(),
});

export type HealthMetricsResponseDto = AdminResponseProjection<
  typeof healthMetricsResponseContract
>;

export const healthCircuitBreakerStatusContract = adminResponse.record(
  adminResponse.object({
    state: adminResponse.string(),
    consecutiveFailures: adminResponse.number(),
    lastFailureTime: adminResponse.number(),
  }),
);

export type HealthCircuitBreakerStatusDto = AdminResponseProjection<
  typeof healthCircuitBreakerStatusContract
>;

export const healthResetCircuitBreakerResponseContract = adminResponse.object({
  success: adminResponse.union([
    adminResponse.literal(false),
    adminResponse.literal(true),
  ] as const),
  name: adminResponse.string(),
  state: adminResponse.string(),
});

export type HealthResetCircuitBreakerResponseDto = AdminResponseProjection<
  typeof healthResetCircuitBreakerResponseContract
>;
