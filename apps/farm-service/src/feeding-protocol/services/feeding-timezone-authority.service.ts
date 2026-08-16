import { Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';

import {
  compileFeedingTimezone,
  type FeedingTimezone,
  type FeedingTimezoneSource,
} from '@aquaculture/feeding-contracts';
import { resolveTankSiteId } from '../../batch/utils/tank-lookup.util';

export type FeedingOperationTarget =
  | { readonly kind: 'tenant' }
  | { readonly kind: 'site'; readonly siteId: string }
  | { readonly kind: 'unit'; readonly unitId: string }
  | { readonly kind: 'meal'; readonly mealId: string }
  | { readonly kind: 'existing_feeding_record'; readonly feedingRecordId: string }
  | {
      readonly kind: 'feeding_record';
      readonly batchId: string;
      readonly tankId?: string;
      readonly pondId?: string;
      readonly batchLocationId?: string;
    };

export interface FeedingTimezoneResolution {
  readonly timezone: FeedingTimezone;
  readonly source: FeedingTimezoneSource;
  readonly siteId: string | null;
  readonly unitId: string | null;
}

export class FeedingTimezoneAuthorityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FeedingTimezoneAuthorityError';
  }
}

/**
 * Resolves feeding time only from the tenant's governed Site catalogue.
 *
 * There is deliberately no process timezone, Istanbul constant or UTC
 * fallback. A site-scoped operation reads that exact site's IANA value. A
 * tenant-wide operation is allowed only when all active sites agree on one
 * value; otherwise a single wall clock would be an invented authority and the
 * operation fails closed until it is split into site-scoped jobs.
 */
@Injectable()
export class FeedingTimezoneAuthorityService {
  async resolveTarget(
    manager: EntityManager,
    tenantId: string,
    target: FeedingOperationTarget,
  ): Promise<FeedingTimezoneResolution> {
    if (target.kind === 'tenant') return this.resolve(manager, tenantId);
    if (target.kind === 'site') return this.resolve(manager, tenantId, target.siteId);

    const unitId = await this.resolveUnitId(manager, tenantId, target);
    const siteId = await resolveTankSiteId(manager, unitId, tenantId);
    if (!siteId) {
      throw new FeedingTimezoneAuthorityError(
        `Feeding unit ${unitId} has no governed Site timezone authority`,
      );
    }
    return { ...(await this.resolve(manager, tenantId, siteId)), unitId };
  }

  async resolve(
    manager: EntityManager,
    tenantId: string,
    siteId?: string,
  ): Promise<FeedingTimezoneResolution> {
    const rows: Array<{ id: string; timezone: string | null }> = siteId
      ? await manager.query(
          `SELECT id, timezone
             FROM "sites"
            WHERE "tenantId" = $1::uuid
              AND id = $2::uuid
              AND "isActive" = true
              AND "isDeleted" = false`,
          [tenantId, siteId],
        )
      : await manager.query(
          `SELECT id, timezone
             FROM "sites"
            WHERE "tenantId" = $1::uuid
              AND "isActive" = true
              AND "isDeleted" = false
            ORDER BY id`,
          [tenantId],
        );

    if (rows.length === 0) {
      throw new FeedingTimezoneAuthorityError(
        `No active Site timezone authority exists for tenant ${tenantId}`,
      );
    }

    const zones = new Set<FeedingTimezone>();
    for (const row of rows) {
      if (!row.timezone) {
        throw new FeedingTimezoneAuthorityError(
          `Site ${row.id} has no valid IANA timezone; feeding time cannot be inferred`,
        );
      }
      try {
        zones.add(compileFeedingTimezone(row.timezone));
      } catch {
        throw new FeedingTimezoneAuthorityError(
          `Site ${row.id} has no canonical IANA timezone; feeding time cannot be inferred`,
        );
      }
    }
    if (zones.size !== 1) {
      throw new FeedingTimezoneAuthorityError(
        `Tenant ${tenantId} has ${zones.size} active feeding timezones; a tenant-wide job requires one`,
      );
    }
    const timezone = zones.values().next().value;
    if (typeof timezone !== 'string') {
      throw new FeedingTimezoneAuthorityError(`Timezone resolution failed for tenant ${tenantId}`);
    }
    return {
      timezone,
      source: 'tenant_site_catalog',
      siteId: siteId ?? null,
      unitId: null,
    };
  }

  private async resolveUnitId(
    manager: EntityManager,
    tenantId: string,
    target: Exclude<FeedingOperationTarget, { kind: 'tenant' } | { kind: 'site' }>,
  ): Promise<string> {
    if (target.kind === 'unit') return target.unitId;
    if (target.kind === 'meal') {
      const rows: Array<{ unitId: string }> = await manager.query(
        `SELECT "unitId"
           FROM "feeding_meals"
          WHERE id = $1::uuid AND "tenantId" = $2::uuid`,
        [target.mealId, tenantId],
      );
      const unitId = rows[0]?.unitId;
      if (!unitId) {
        throw new FeedingTimezoneAuthorityError(`Feeding meal ${target.mealId} has no unit`);
      }
      return unitId;
    }
    if (target.kind === 'existing_feeding_record') {
      const rows: Array<{
        batchId: string;
        tankId: string | null;
        pondId: string | null;
        batchLocationId: string | null;
      }> = await manager.query(
        `SELECT "batchId", "tankId", "pondId", "batchLocationId"
           FROM "feeding_records"
          WHERE id = $1::uuid AND "tenantId" = $2::uuid`,
        [target.feedingRecordId, tenantId],
      );
      const feedingRecord = rows[0];
      if (!feedingRecord) {
        throw new FeedingTimezoneAuthorityError(
          `Feeding record ${target.feedingRecordId} has no governed target`,
        );
      }
      return this.resolveUnitId(manager, tenantId, {
        kind: 'feeding_record',
        batchId: feedingRecord.batchId,
        tankId: feedingRecord.tankId ?? undefined,
        pondId: feedingRecord.pondId ?? undefined,
        batchLocationId: feedingRecord.batchLocationId ?? undefined,
      });
    }

    const explicit = [target.tankId, target.pondId].filter(
      (candidate): candidate is string => candidate !== undefined,
    );
    if (new Set(explicit).size > 1) {
      throw new FeedingTimezoneAuthorityError(
        'tankId and pondId cannot identify different feeding units',
      );
    }
    const rows: Array<{ tankId: string | null; pondId: string | null }> = target.batchLocationId
      ? await manager.query(
          `SELECT "tankId", "pondId"
             FROM "batch_locations"
            WHERE id = $1::uuid
              AND "tenantId" = $2::uuid
              AND "batchId" = $3::uuid`,
          [target.batchLocationId, tenantId, target.batchId],
        )
      : explicit.length === 0
        ? await manager.query(
            `SELECT "tankId", "pondId"
               FROM "batch_locations"
              WHERE "tenantId" = $1::uuid
                AND "batchId" = $2::uuid
                AND "isCurrentLocation" = true
              ORDER BY id`,
            [tenantId, target.batchId],
          )
        : [];
    if (target.batchLocationId && rows.length !== 1) {
      throw new FeedingTimezoneAuthorityError(
        `Batch location ${target.batchLocationId} does not belong to batch ${target.batchId}`,
      );
    }
    if (!target.batchLocationId && explicit.length === 0 && rows.length !== 1) {
      throw new FeedingTimezoneAuthorityError(
        `Batch ${target.batchId} requires one explicit tankId, pondId, or batchLocationId`,
      );
    }
    const locationUnitId = rows[0]?.tankId ?? rows[0]?.pondId ?? undefined;
    const explicitUnitId = explicit[0];
    if (explicitUnitId && locationUnitId && explicitUnitId !== locationUnitId) {
      throw new FeedingTimezoneAuthorityError(
        'Feeding unit does not match the selected batch location',
      );
    }
    const unitId = explicitUnitId ?? locationUnitId;
    if (!unitId) {
      throw new FeedingTimezoneAuthorityError('Feeding operation has no physical unit');
    }
    return unitId;
  }

}
