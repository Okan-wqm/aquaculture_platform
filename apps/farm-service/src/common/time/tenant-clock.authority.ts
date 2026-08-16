import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import type { EntityManager } from 'typeorm';

import { calendarDateInTimezone } from './calendar-date';

const DEFAULT_TENANT_TIMEZONE = 'UTC';

interface SiteTimezoneRow {
  timezone: string | null;
}

interface SiteClockRow extends SiteTimezoneRow {
  id: string;
}

export interface TenantClockV1 {
  readonly instant: Date;
  readonly timezone: string;
  readonly localDate: string;
}

function isResolvableIanaTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format();
    return true;
  } catch {
    return false;
  }
}

/**
 * Sole calendar authority for tenant-scoped farm operations.
 *
 * The operation instant is PostgreSQL's transaction timestamp, so every write
 * in one transaction observes one immutable clock value. Calendar semantics
 * come from the Site catalog. If an operation has no site, all active sites
 * must agree on one timezone; disagreement is ambiguous and fails closed.
 */
@Injectable()
export class TenantClockAuthority {
  async resolve(
    manager: EntityManager,
    tenantId: string,
    siteId?: string,
    requestedInstant?: Date,
  ): Promise<TenantClockV1> {
    const instant = requestedInstant ?? (await this.readTransactionInstant(manager));
    if (!Number.isFinite(instant.getTime())) {
      throw new ConflictException('Farm operation instant is invalid');
    }

    const timezones = siteId
      ? await this.readSiteTimezone(manager, tenantId, siteId)
      : await this.readTenantTimezones(manager, tenantId);
    if (timezones.length === 0) {
      throw new NotFoundException(
        siteId
          ? `Active site ${siteId} was not found for tenant ${tenantId}`
          : `Tenant ${tenantId} has no active site clock authority`,
      );
    }
    if (timezones.length > 1) {
      throw new ConflictException(
        `Tenant ${tenantId} has multiple site timezones; the operation must name its site`,
      );
    }

    return this.compileClock(timezones[0], instant);
  }

  /**
   * Resolves several site clocks at one immutable instant with one catalog
   * read. Set equality is enforced so an inactive, deleted, foreign-tenant,
   * or otherwise unknown site can never disappear into a fallback timezone.
   */
  async resolveSites(
    manager: EntityManager,
    tenantId: string,
    siteIds: readonly string[],
    requestedInstant?: Date,
  ): Promise<ReadonlyMap<string, TenantClockV1>> {
    const instant = requestedInstant ?? (await this.readTransactionInstant(manager));
    if (!Number.isFinite(instant.getTime())) {
      throw new ConflictException('Farm operation instant is invalid');
    }
    const requested = [...new Set(siteIds)].sort();
    if (requested.length === 0) return new Map();

    const rows: SiteClockRow[] = await manager.query(
      `SELECT id, timezone
         FROM sites
        WHERE "tenantId" = $1
          AND id = ANY($2::uuid[])
          AND "isActive" = true
          AND "isDeleted" = false
        ORDER BY id`,
      [tenantId, requested],
    );
    const byId = new Map(rows.map((row) => [row.id, row]));
    const missing = requested.filter((siteId) => !byId.has(siteId));
    if (missing.length > 0) {
      throw new NotFoundException(
        `Active site clock authority is missing for tenant ${tenantId}: ${missing.join(', ')}`,
      );
    }

    const clocks = new Map<string, TenantClockV1>();
    for (const siteId of requested) {
      clocks.set(siteId, this.compileClock(byId.get(siteId)?.timezone, instant));
    }
    return clocks;
  }

  /** All active Site catalog clocks for batch cron/forecast compilation. */
  async resolveActiveSites(
    manager: EntityManager,
    tenantId: string,
    requestedInstant?: Date,
  ): Promise<ReadonlyMap<string, TenantClockV1>> {
    const instant = requestedInstant ?? (await this.readTransactionInstant(manager));
    if (!Number.isFinite(instant.getTime())) {
      throw new ConflictException('Farm operation instant is invalid');
    }
    const rows: SiteClockRow[] = await manager.query(
      `SELECT id, timezone
         FROM sites
        WHERE "tenantId" = $1
          AND "isActive" = true
          AND "isDeleted" = false
        ORDER BY id`,
      [tenantId],
    );
    if (rows.length === 0) {
      throw new NotFoundException(`Tenant ${tenantId} has no active site clock authority`);
    }
    const clocks = new Map<string, TenantClockV1>();
    for (const row of rows) {
      clocks.set(row.id, this.compileClock(row.timezone, instant));
    }
    return clocks;
  }

  private async readTransactionInstant(manager: EntityManager): Promise<Date> {
    const rows: Array<{ instant: Date | string }> = await manager.query(
      'SELECT transaction_timestamp() AS instant',
    );
    const instant = new Date(rows[0]?.instant ?? Number.NaN);
    if (!Number.isFinite(instant.getTime())) {
      throw new ConflictException('PostgreSQL did not return a transaction timestamp');
    }
    return instant;
  }

  private compileClock(timezoneValue: string | null | undefined, instant: Date): TenantClockV1 {
    const timezone = timezoneValue ?? DEFAULT_TENANT_TIMEZONE;
    if (!isResolvableIanaTimezone(timezone)) {
      throw new ConflictException(`Site catalog contains an invalid IANA timezone: ${timezone}`);
    }
    return Object.freeze({
      instant: new Date(instant.getTime()),
      timezone,
      localDate: calendarDateInTimezone(timezone, instant),
    });
  }

  private async readSiteTimezone(
    manager: EntityManager,
    tenantId: string,
    siteId: string,
  ): Promise<string[]> {
    const rows: SiteTimezoneRow[] = await manager.query(
      `SELECT timezone
         FROM sites
        WHERE id = $1
          AND "tenantId" = $2
          AND "isActive" = true
          AND "isDeleted" = false`,
      [siteId, tenantId],
    );
    return rows.map((row) => row.timezone ?? DEFAULT_TENANT_TIMEZONE);
  }

  private async readTenantTimezones(manager: EntityManager, tenantId: string): Promise<string[]> {
    const rows: SiteTimezoneRow[] = await manager.query(
      `SELECT DISTINCT COALESCE(timezone, $2) AS timezone
         FROM sites
        WHERE "tenantId" = $1
          AND "isActive" = true
          AND "isDeleted" = false
        ORDER BY timezone`,
      [tenantId, DEFAULT_TENANT_TIMEZONE],
    );
    return rows.map((row) => row.timezone ?? DEFAULT_TENANT_TIMEZONE);
  }
}
