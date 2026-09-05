/**
 * Messaging Admin Types — monitoring + tenant overview contracts
 *
 * Mirrors the responses served by admin-api-service's MessagingAdminController
 * (GET /messaging/monitoring/stats and GET /messaging/tenants), which proxy
 * messaging-service's cross-tenant aggregates over NATS (ADMIN-HIGH-009).
 * The aggregates are cached backend-side for 60 seconds (`generatedAt` is the
 * aggregation timestamp, not the response timestamp).
 */

/** Per-tenant messaging activity row. */
export interface TenantMessagingOverviewRow {
  tenantId: string;
  /** Physical message rows created in the last 24 hours. */
  messageCount24h: number;
  /** Physical message rows created in the last 7 days. */
  messageCount7d: number;
  /** All-time physical message rows for the tenant. */
  totalMessages: number;
  /** Channels that are not archived. */
  activeChannels: number;
}

/** Transactional-outbox health snapshot for the messaging service. */
export interface MessagingOutboxHealth {
  /** Events enqueued but not yet published (and not dead-lettered). */
  pendingCount: number;
  /** Dead-lettered events that exhausted their retries. */
  failedCount: number;
  /** Age in seconds of the oldest pending event; null when nothing is pending. */
  oldestPendingAgeSeconds: number | null;
}

/** Platform-wide totals returned by GET /messaging/monitoring/stats. */
export interface MessagingMonitoringTotals {
  totalMessages: number;
  messages24h: number;
  messages7d: number;
  activeChannels: number;
  tenantCount: number;
}

/** Response of GET /messaging/monitoring/stats. */
export interface MessagingMonitoringStats {
  totals: MessagingMonitoringTotals;
  /** Per-tenant breakdown, sorted by 24h message volume descending. */
  perTenant: TenantMessagingOverviewRow[];
  outbox: MessagingOutboxHealth;
  /** ISO timestamp of when the aggregate was computed. */
  generatedAt: string;
}

/** Response of GET /messaging/tenants. */
export interface MessagingTenantsOverview {
  /** Per-tenant rows, sorted by 24h message volume descending. */
  tenants: TenantMessagingOverviewRow[];
  /** ISO timestamp of when the aggregate was computed. */
  generatedAt: string;
}
