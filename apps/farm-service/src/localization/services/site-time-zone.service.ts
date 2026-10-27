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
import { InjectDataSource } from '@nestjs/typeorm';
import { runInTenantTransaction } from '@aquaculture/backend-common/database';
import { DataSource, EntityManager } from 'typeorm';

import { DEFAULT_TENANT_TIMEZONE } from '../entities/tenant-localization.entity';

/** A tenant's site → zone map plus its tenant zone (one batched read). */
export interface TenantZoneMap {
  tenantZone: string;
  zoneOf(siteId: string | null | undefined): string;
  /** The zone the site set itself; undefined when it inherits, is deleted or unknown. */
  ownZoneOf(siteId: string): string | undefined;
}

@Injectable()
export class SiteTimeZoneService {
  constructor(
    /**
     * `farm.tenant_localization` lives in the `farm` source schema keyed by
     * tenantId (never cloned into tenant schemas) but carries FORCED row-level
     * security: a read outside a tenant context sees no row at all, so every
     * tenant would silently get UTC. Reads therefore go through the tenant's
     * own transaction (`runInTenantTransaction`), never a bare repository.
     */
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  /** Each tenant's zone; a tenant that never set one gets UTC. */
  async tenantZones(tenantIds: string[]): Promise<Map<string, string>> {
    const zones = new Map<string, string>();
    for (const tenantId of tenantIds) {
      const rows: Array<{ timezone: string | null }> = await runInTenantTransaction(
        this.dataSource,
        'farm',
        tenantId,
        (queryRunner) =>
          queryRunner.query(`SELECT timezone FROM farm.tenant_localization WHERE "tenantId" = $1`, [
            tenantId,
          ]),
      );
      zones.set(tenantId, rows[0]?.timezone || DEFAULT_TENANT_TIMEZONE);
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
    // Both reads go through the caller's manager: inside a tenant read or
    // transaction a second pooled connection would only wait behind the first.
    const localization: Array<{ timezone: string | null }> = await manager.query(
      `SELECT timezone FROM farm.tenant_localization WHERE "tenantId" = $1`,
      [tenantId],
    );
    const tenantZone = localization[0]?.timezone || DEFAULT_TENANT_TIMEZONE;
    const rows: Array<{ id: string; timezone: string | null }> = await manager.query(
      `SELECT id, timezone FROM "sites" WHERE "tenantId" = $1 AND "isDeleted" = false`,
      [tenantId],
    );
    const bySite = new Map<string, string>();
    for (const row of rows) {
      // NULL or empty = inherit. A zone the site wrote itself wins.
      if (row.timezone) bySite.set(row.id, row.timezone);
    }
    return {
      tenantZone,
      zoneOf: (siteId) => (siteId ? (bySite.get(siteId) ?? tenantZone) : tenantZone),
      ownZoneOf: (siteId) => bySite.get(siteId),
    };
  }
}
