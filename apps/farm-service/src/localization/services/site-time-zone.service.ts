/**
 * SiteTimeZoneService — the one answer to "which zone is this site's day
 * counted in".
 *
 * Order, named once: the site's own `sites.timezone` (NULL = inherit) → the
 * tenant's `farm.tenant_localization.timezone` → `'UTC'`.
 *
 * WHY here: feeding (plans, crons, day summaries) and sensor charts (local-day
 * buckets) both need it. It lived inside feeding as part of the feeding clock,
 * so a second reader would have meant a second copy. Feeding's clock and the
 * `request.farm.resolveTimeZones` responder now both read this service, so a
 * feeding day and a chart day cannot disagree.
 *
 * A soft-deleted site has no zone of its own: anything still pointing at it
 * falls back to the tenant zone, as for an unknown site.
 */
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, In, Repository } from 'typeorm';

import {
  DEFAULT_TENANT_TIMEZONE,
  TenantLocalization,
} from '../entities/tenant-localization.entity';

/** A tenant's site → zone map plus its tenant zone (one batched read). */
export interface TenantZoneMap {
  tenantZone: string;
  zoneOf(siteId: string | null | undefined): string;
  /** Whether the site exists and is not deleted. */
  knows(siteId: string): boolean;
}

@Injectable()
export class SiteTimeZoneService {
  constructor(
    /**
     * CROSS-TENANT ledger: `tenant_localization` lives in the `farm` source
     * schema keyed by tenantId (never cloned into tenant schemas). The entity
     * declares `schema: 'farm'`, so the injected repository qualifies its SQL;
     * `getScopedRepository` would be wrong — cron ticks read it before any
     * tenant transaction exists.
     */
    @InjectRepository(TenantLocalization)
    private readonly localizationRepository: Repository<TenantLocalization>,
  ) {}

  /** Each tenant's zone; a tenant that never set one gets UTC. */
  async tenantZones(tenantIds: string[]): Promise<Map<string, string>> {
    const zones = new Map<string, string>();
    if (tenantIds.length === 0) return zones;
    const rows = await this.localizationRepository.find({
      where: { tenantId: In(tenantIds) },
      select: ['tenantId', 'timezone'],
    });
    for (const row of rows) {
      zones.set(row.tenantId, row.timezone || DEFAULT_TENANT_TIMEZONE);
    }
    for (const tenantId of tenantIds) {
      if (!zones.has(tenantId)) zones.set(tenantId, DEFAULT_TENANT_TIMEZONE);
    }
    return zones;
  }

  async tenantZone(tenantId: string): Promise<string> {
    return (await this.tenantZones([tenantId])).get(tenantId) ?? DEFAULT_TENANT_TIMEZONE;
  }

  /**
   * The tenant's site → zone map: every live site and the tenant zone in one
   * read. `manager` must be bound to the tenant's schema (a tenant
   * transaction or read).
   */
  async siteZones(manager: EntityManager, tenantId: string): Promise<TenantZoneMap> {
    const tenantZone = await this.tenantZone(tenantId);
    const rows: Array<{ id: string; timezone: string | null }> = await manager.query(
      `SELECT id, timezone FROM "sites" WHERE "tenantId" = $1 AND "isDeleted" = false`,
      [tenantId],
    );
    const live = new Set(rows.map((row) => row.id));
    const bySite = new Map<string, string>();
    for (const row of rows) {
      // NULL or empty = inherit. A zone the site wrote itself wins.
      if (row.timezone) bySite.set(row.id, row.timezone);
    }
    return {
      tenantZone,
      zoneOf: (siteId) => (siteId ? (bySite.get(siteId) ?? tenantZone) : tenantZone),
      knows: (siteId) => live.has(siteId),
    };
  }
}
