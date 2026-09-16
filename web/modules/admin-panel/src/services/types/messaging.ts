/**
 * Messaging Admin Types — the monitoring and tenant-overview aggregates, taken
 * from the contract (ADMIN-MEDIUM-152).
 *
 * These five shapes were hand-written here, because both routes
 * (`GET /messaging/monitoring/stats`, `GET /messaging/tenants`) were typed by
 * INTERFACES inside the controller and the `@nestjs/swagger` plugin describes
 * classes only — so the artifact carried `{"type": "object"}` for both and
 * there was nothing to derive from.
 *
 * Unusually, the hand-written copies were CORRECT: ADMIN-HIGH-009 wrote both
 * sides together and they still agreed field for field. That is exactly why
 * this was worth closing before it broke, rather than after — every other page
 * in this audit that hand-wrote a response type had already drifted from it
 * (ADMIN-HIGH-110, ADMIN-MEDIUM-111, ADMIN-CRITICAL-150, ADMIN-CRITICAL-151).
 *
 * `generatedAt` is the AGGREGATION timestamp, not the response timestamp:
 * messaging-service caches these for 60 seconds.
 */

import type { ApiSchema } from '../contract';

/** Per-tenant messaging activity row. */
export type TenantMessagingOverviewRow = ApiSchema<'TenantMessagingOverviewRowDto'>;

/**
 * Transactional-outbox health snapshot for the messaging service.
 *
 * `oldestPendingAgeSeconds` is `null` when nothing is pending — which is not
 * an age of zero, and the dashboard renders it as an em dash.
 */
export type MessagingOutboxHealth = ApiSchema<'MessagingOutboxHealthDto'>;

/** Platform-wide totals returned by `GET /messaging/monitoring/stats`. */
export type MessagingMonitoringTotals = ApiSchema<'MessagingMonitoringTotalsDto'>;

/** Response of `GET /messaging/monitoring/stats`. */
export type MessagingMonitoringStats = ApiSchema<'MessagingMonitoringStatsDto'>;

/** Response of `GET /messaging/tenants`. */
export type MessagingTenantsOverview = ApiSchema<'MessagingTenantsOverviewDto'>;
