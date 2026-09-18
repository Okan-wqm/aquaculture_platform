/**
 * @module MonitoringStatsService
 * @description Cross-tenant messaging monitoring aggregates for the admin panel
 * (ADMIN-HIGH-009). Serves the `request.messaging.admin.getMonitoringStats` and
 * `request.messaging.admin.getTenantsOverview` NATS request-reply patterns via
 * MessagingAdminNatsHandler.
 *
 * # Architecture (architectural-arbiter ruling, ADMIN-HIGH-009)
 *
 * - Aggregates the AUTHORITATIVE `messaging.*` schema tables with a single
 *   `GROUP BY "tenantId"` pass per metric inside `BypassRlsService.withBypass()`
 *   (same cross-tenant read discipline as the compliance/ai services). It does
 *   NOT iterate `tenant_<uuid>` schema clones — those are vestigial post-ADR-013.
 * - Redis caching uses exactly two low-cardinality keys
 *   (`messaging:admin:monitoring-stats`, `messaging:admin:tenants-overview`,
 *   60s TTL). Per-tenant cache keys and per-request cross-schema iteration are
 *   forbidden by the ruling.
 * - Per-tenant storage bytes are intentionally NOT part of this contract:
 *   StorageQuotaService only exposes per-tenant reads (tenant-routed
 *   `SUM(fileSize)` + per-tenant Redis keys), so a cross-tenant storage column
 *   would require exactly the per-tenant iteration the ruling forbids. The
 *   arbiter ruling excludes storage from this endpoint's scope.
 *
 * # Metric semantics
 *
 * - `messageCount24h` / `messageCount7d` / `totalMessages`: physical rows in
 *   `messaging.messages` per tenant (soft-deleted rows included — the metric is
 *   write volume, not visible-message count).
 * - `activeChannels`: `messaging.channels` rows with `isArchived = false`.
 * - Outbox health reads the cross-tenant `messaging.messaging_outbox` table:
 *   `pendingCount` = unpublished and not dead-lettered, `failedCount` =
 *   dead-lettered, `oldestPendingAgeSeconds` = age of the oldest pending row
 *   (null when nothing is pending).
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import Redis from 'ioredis';
import { BypassRlsService } from '@aquaculture/backend-common/database';

import { REDIS_CLIENT } from '../../shared/redis.provider';

/** Cache TTL for both admin aggregates (arbiter ruling: 60 seconds). */
const CACHE_TTL_SECONDS = 60;

/** Single low-cardinality cache key for the platform monitoring stats. */
export const MONITORING_STATS_CACHE_KEY = 'messaging:admin:monitoring-stats';

/** Single low-cardinality cache key for the per-tenant overview. */
export const TENANTS_OVERVIEW_CACHE_KEY = 'messaging:admin:tenants-overview';

/** Per-tenant messaging activity row returned by the tenants overview. */
export interface TenantMessagingOverviewRow {
  tenantId: string;
  messageCount24h: number;
  messageCount7d: number;
  totalMessages: number;
  activeChannels: number;
}

/** Health snapshot of the cross-tenant messaging outbox. */
export interface MessagingOutboxHealth {
  pendingCount: number;
  failedCount: number;
  oldestPendingAgeSeconds: number | null;
}

/** Platform-wide messaging monitoring statistics. */
export interface MessagingMonitoringStats {
  totals: {
    totalMessages: number;
    messages24h: number;
    messages7d: number;
    activeChannels: number;
    tenantCount: number;
  };
  perTenant: TenantMessagingOverviewRow[];
  outbox: MessagingOutboxHealth;
  generatedAt: string;
}

/** Per-tenant messaging overview for the admin tenants table. */
export interface MessagingTenantsOverview {
  tenants: TenantMessagingOverviewRow[];
  generatedAt: string;
}

/** Raw row shape of the per-tenant message aggregate query. */
interface MessageAggregateRow {
  tenantId: string;
  count24h: string;
  count7d: string;
  totalCount: string;
}

/** Raw row shape of the per-tenant channel aggregate query. */
interface ChannelAggregateRow {
  tenantId: string;
  activeChannels: string;
}

/** Raw row shape of the outbox health aggregate query. */
interface OutboxAggregateRow {
  pendingCount: string;
  failedCount: string;
  oldestPendingAgeSeconds: string | null;
}

/** Parse a pg bigint aggregate (returned as string) into a safe integer. */
function toCount(value: string | null | undefined): number {
  const parsed = Number.parseInt(value ?? '0', 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

@Injectable()
export class MonitoringStatsService {
  private readonly logger = new Logger(MonitoringStatsService.name);

  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
    @Inject(REDIS_CLIENT)
    private readonly redis: Redis,
    private readonly bypassRls: BypassRlsService,
  ) {}

  /**
   * Platform-wide monitoring statistics: message volume totals, active channel
   * count, per-tenant breakdown, and outbox health. Cached for 60 seconds under
   * a single key so the admin panel never triggers a per-request full scan.
   */
  async getMonitoringStats(): Promise<MessagingMonitoringStats> {
    const cached = await this.readCache<MessagingMonitoringStats>(MONITORING_STATS_CACHE_KEY);
    if (cached !== null) {
      return cached;
    }

    const stats = await this.bypassRls.withBypass(
      'messaging-admin:monitoring-stats',
      async (): Promise<MessagingMonitoringStats> => {
        const [perTenant, outbox] = await Promise.all([
          this.aggregatePerTenant(),
          this.aggregateOutboxHealth(),
        ]);

        const totals = perTenant.reduce(
          (acc, row) => {
            acc.totalMessages += row.totalMessages;
            acc.messages24h += row.messageCount24h;
            acc.messages7d += row.messageCount7d;
            acc.activeChannels += row.activeChannels;
            return acc;
          },
          { totalMessages: 0, messages24h: 0, messages7d: 0, activeChannels: 0 },
        );

        return {
          totals: { ...totals, tenantCount: perTenant.length },
          perTenant,
          outbox,
          generatedAt: new Date().toISOString(),
        };
      },
    );

    await this.writeCache(MONITORING_STATS_CACHE_KEY, stats);
    return stats;
  }

  /**
   * Per-tenant messaging overview rows (message counts + active channels),
   * sorted by 24h volume descending. Cached for 60 seconds under a single key.
   */
  async getTenantsOverview(): Promise<MessagingTenantsOverview> {
    const cached = await this.readCache<MessagingTenantsOverview>(TENANTS_OVERVIEW_CACHE_KEY);
    if (cached !== null) {
      return cached;
    }

    const tenants = await this.bypassRls.withBypass(
      'messaging-admin:tenants-overview',
      (): Promise<TenantMessagingOverviewRow[]> => this.aggregatePerTenant(),
    );

    const overview: MessagingTenantsOverview = {
      tenants,
      generatedAt: new Date().toISOString(),
    };

    await this.writeCache(TENANTS_OVERVIEW_CACHE_KEY, overview);
    return overview;
  }

  /**
   * One `GROUP BY "tenantId"` pass over `messaging.messages` plus one over
   * `messaging.channels`, merged on tenantId. Explicit schema qualification
   * keeps the read on the authoritative source tables regardless of any
   * request-scoped search_path.
   */
  private async aggregatePerTenant(): Promise<TenantMessagingOverviewRow[]> {
    const [messageRows, channelRows] = await Promise.all([
      this.dataSource.query<MessageAggregateRow[]>(
        `SELECT
           m."tenantId" AS "tenantId",
           COUNT(*) FILTER (WHERE m."createdAt" >= NOW() - INTERVAL '24 hours') AS "count24h",
           COUNT(*) FILTER (WHERE m."createdAt" >= NOW() - INTERVAL '7 days') AS "count7d",
           COUNT(*) AS "totalCount"
         FROM "messaging"."messages" m
         GROUP BY m."tenantId"`,
      ),
      this.dataSource.query<ChannelAggregateRow[]>(
        `SELECT
           c."tenantId" AS "tenantId",
           COUNT(*) AS "activeChannels"
         FROM "messaging"."channels" c
         WHERE c."isArchived" = false
         GROUP BY c."tenantId"`,
      ),
    ]);

    const byTenant = new Map<string, TenantMessagingOverviewRow>();
    const ensureRow = (tenantId: string): TenantMessagingOverviewRow => {
      let row = byTenant.get(tenantId);
      if (!row) {
        row = {
          tenantId,
          messageCount24h: 0,
          messageCount7d: 0,
          totalMessages: 0,
          activeChannels: 0,
        };
        byTenant.set(tenantId, row);
      }
      return row;
    };

    for (const raw of messageRows) {
      const row = ensureRow(raw.tenantId);
      row.messageCount24h = toCount(raw.count24h);
      row.messageCount7d = toCount(raw.count7d);
      row.totalMessages = toCount(raw.totalCount);
    }
    for (const raw of channelRows) {
      ensureRow(raw.tenantId).activeChannels = toCount(raw.activeChannels);
    }

    return Array.from(byTenant.values()).sort(
      (a, b) =>
        b.messageCount24h - a.messageCount24h ||
        b.totalMessages - a.totalMessages ||
        a.tenantId.localeCompare(b.tenantId),
    );
  }

  /**
   * Outbox health from the cross-tenant `messaging.messaging_outbox` table.
   * `pendingCount`/`failedCount` mirror the outbox worker's polling predicate
   * (`publishedAt IS NULL AND isDeadLettered = false`) and dead-letter flag.
   */
  private async aggregateOutboxHealth(): Promise<MessagingOutboxHealth> {
    const rows = await this.dataSource.query<OutboxAggregateRow[]>(
      `SELECT
         COUNT(*) FILTER (WHERE "publishedAt" IS NULL AND "isDeadLettered" = false) AS "pendingCount",
         COUNT(*) FILTER (WHERE "isDeadLettered" = true) AS "failedCount",
         EXTRACT(EPOCH FROM (
           NOW() - MIN("createdAt") FILTER (WHERE "publishedAt" IS NULL AND "isDeadLettered" = false)
         )) AS "oldestPendingAgeSeconds"
       FROM "messaging"."messaging_outbox"`,
    );

    const row = rows[0];
    if (!row) {
      return { pendingCount: 0, failedCount: 0, oldestPendingAgeSeconds: null };
    }

    const oldestRaw = row.oldestPendingAgeSeconds;
    const oldestParsed = oldestRaw === null ? Number.NaN : Number.parseFloat(oldestRaw);

    return {
      pendingCount: toCount(row.pendingCount),
      failedCount: toCount(row.failedCount),
      oldestPendingAgeSeconds: Number.isFinite(oldestParsed)
        ? Math.max(0, Math.round(oldestParsed))
        : null,
    };
  }

  // ── Redis convenience wrappers — cache outage must not break the admin panel ──

  /**
   * Safe cached read. Returns null on Redis error or corrupt payload so the
   * caller falls through to the authoritative aggregate instead of crashing.
   */
  private async readCache<T>(key: string): Promise<T | null> {
    try {
      const cached = await this.redis.get(key);
      if (cached === null) {
        return null;
      }
      return JSON.parse(cached) as T;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Redis read failed for ${key}: ${message}`);
      return null;
    }
  }

  /** Best-effort cache write; failure is logged, the fresh aggregate is still returned. */
  private async writeCache(key: string, value: unknown): Promise<void> {
    try {
      await this.redis.setex(key, CACHE_TTL_SECONDS, JSON.stringify(value));
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Redis write failed for ${key}: ${message}`);
    }
  }
}
