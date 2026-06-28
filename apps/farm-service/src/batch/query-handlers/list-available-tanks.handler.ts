/**
 * ListAvailableTanksHandler
 *
 * Lists available tanks, ponds, and cages for batch allocation with capacity information.
 * Queries BOTH the `equipment` table AND the `tanks` table (unified lookup).
 *
 * Uses a dedicated queryRunner to ensure search_path is set on the same connection
 * that executes the queries (avoids connection pool search_path race conditions).
 *
 * @module Batch/QueryHandlers
 */
import { runInTenantRead } from '@aquaculture/backend-common/database';
import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { DataSource, QueryRunner } from 'typeorm';
import { QueryHandler, IQueryHandler } from '@platform/cqrs';
import { ListAvailableTanksQuery, AvailableTank } from '../queries/list-available-tanks.query';

/**
 * Shape of a row returned by `queryEquipmentRaw`. Mirrors the SELECT
 * column list below exactly — a column removed from the query OR a
 * new column added requires updating this interface so the mappers
 * don't silently read undefined.
 *
 * `specifications` comes back as either the parsed JSONB object
 * (when TypeORM's jsonb type detection kicks in) or the raw string
 * (when the driver hands the row through without parsing). The
 * mapper handles both.
 */
interface EquipmentRawRow {
  id: string;
  name: string;
  code: string;
  status: string;
  volume: string | number | null;
  currentBiomass: string | number | null;
  currentCount: number | null;
  specifications: string | Record<string, unknown> | null;
  departmentId: string | null;
  departmentName: string | null;
  siteId: string | null;
  siteName: string | null;
  category: string;
}

/** Shape of a row returned by `queryTanksRaw`. See EquipmentRawRow for the comment. */
interface TankRawRow {
  id: string;
  name: string;
  code: string;
  status: string;
  volume: string | number | null;
  maxBiomass: string | number | null;
  currentBiomass: string | number | null;
  maxDensity: string | number | null;
  currentCount: number | null;
  departmentId: string | null;
  departmentName: string | null;
  siteId: string | null;
  siteName: string | null;
}

/** Raw-SQL query parameter — always a string or a string array for `ANY($n)` matches. */
type RawQueryParam = string | string[];

/** UUID v4 format validation */
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Tank statuses considered available for batch allocation.
 * Only 'active' and 'preparing' are truly available - CreatePondBatchHandler
 * rejects MAINTENANCE tanks, and 'harvesting', 'cleaning', 'quarantine' are
 * not suitable for new batch allocation. */
const OPERATIONAL_TANK_STATUSES: string[] = [
  'active',
  'preparing',
  'fallow',
];

/** Equipment statuses considered operational */
const OPERATIONAL_EQUIPMENT_STATUSES: string[] = [
  'operational',
  ...OPERATIONAL_TANK_STATUSES,
];

/** Equipment categories that hold fish */
const FISH_HOLDING_CATEGORIES = ['tank', 'pond', 'cage'];

@Injectable()
@QueryHandler(ListAvailableTanksQuery)
export class ListAvailableTanksHandler implements IQueryHandler<ListAvailableTanksQuery, AvailableTank[]> {
  private readonly logger = new Logger('ListAvailableTanksHandler');

  constructor(
    private readonly dataSource: DataSource,
  ) {}

  async execute(query: ListAvailableTanksQuery): Promise<AvailableTank[]> {
    const { tenantId, siteId, departmentId, excludeFullTanks } = query;

    // SECURITY: Validate tenantId is a well-formed UUID before using it.
    if (!UUID_REGEX.test(tenantId)) {
      throw new BadRequestException('Invalid tenant ID format');
    }

    // Read through the fail-closed tenant boundary: it pins search_path + the
    // RLS GUC transaction-locally and asserts current_schema() before the raw
    // SELECTs run, so a lost/wrong tenant context raises TenantContextError
    // instead of silently resolving rows from the source `farm` schema. This
    // also replaces the hand-rolled createQueryRunner + SET/RESET search_path.
    return runInTenantRead(this.dataSource, 'farm', tenantId, async (queryRunner) => {
      const [equipmentRows, tankRows] = await Promise.all([
        this.queryEquipmentRaw(queryRunner, tenantId, siteId, departmentId),
        this.queryTanksRaw(queryRunner, tenantId, siteId, departmentId),
      ]);

      this.logger.debug(
        `Results: equipment=${equipmentRows.length}, tanks=${tankRows.length}`,
      );

      // Merge and deduplicate (equipment takes precedence)
      const seenIds = new Set(equipmentRows.map((r) => r.id));
      const merged: AvailableTank[] = [
        ...equipmentRows.map((r) => this.mapEquipmentRow(r)),
        ...tankRows.filter((r) => !seenIds.has(r.id)).map((r) => this.mapTankRow(r)),
      ];

      merged.sort((a, b) => (a.name || '').localeCompare(b.name || ''));

      return excludeFullTanks
        ? merged.filter((t) => t.availableCapacity > 0)
        : merged;
    });
  }

  private async queryEquipmentRaw(
    queryRunner: QueryRunner,
    tenantId: string,
    siteId?: string,
    departmentId?: string,
  ): Promise<EquipmentRawRow[]> {
    const params: RawQueryParam[] = [tenantId, FISH_HOLDING_CATEGORIES];
    let paramIdx = 3;

    let sql = `
      SELECT
        eq.id, eq.name, eq.code, eq.status, eq.volume,
        eq."currentBiomass", eq."currentCount",
        eq.specifications, eq."departmentId",
        dept.name AS "departmentName", dept."siteId",
        site.name AS "siteName",
        eqt.category
      FROM equipment eq
      LEFT JOIN departments dept ON dept.id = eq."departmentId"
      LEFT JOIN sites site ON site.id = dept."siteId"
      LEFT JOIN equipment_types eqt ON eqt.id = eq."equipmentTypeId"
      WHERE eq."tenantId" = $1
        AND eqt.category = ANY($2)
        AND eq."isActive" = true
        AND eq."isDeleted" = false
        AND eq.status = ANY($${paramIdx})
    `;
    params.push(OPERATIONAL_EQUIPMENT_STATUSES);
    paramIdx++;

    if (siteId) {
      sql += ` AND dept."siteId" = $${paramIdx}`;
      params.push(siteId);
      paramIdx++;
    }

    if (departmentId) {
      sql += ` AND eq."departmentId" = $${paramIdx}`;
      params.push(departmentId);
      paramIdx++;
    }

    sql += ` ORDER BY eq.name ASC`;

    return queryRunner.query(sql, params);
  }

  private async queryTanksRaw(
    queryRunner: QueryRunner,
    tenantId: string,
    siteId?: string,
    departmentId?: string,
  ): Promise<TankRawRow[]> {
    const params: RawQueryParam[] = [tenantId, OPERATIONAL_TANK_STATUSES];
    let paramIdx = 3;

    let sql = `
      SELECT
        tank.id, tank.name, tank.code, tank.status, tank.volume,
        tank."maxBiomass", tank."currentBiomass", tank."maxDensity",
        tank."currentCount", tank."departmentId",
        dept.name AS "departmentName", dept."siteId",
        site.name AS "siteName"
      FROM tanks tank
      LEFT JOIN departments dept ON dept.id = tank."departmentId"
      LEFT JOIN sites site ON site.id = dept."siteId"
      WHERE tank."tenantId" = $1
        AND tank."isActive" = true
        AND tank.status = ANY($2)
    `;

    if (siteId) {
      sql += ` AND dept."siteId" = $${paramIdx}`;
      params.push(siteId);
      paramIdx++;
    }

    if (departmentId) {
      sql += ` AND tank."departmentId" = $${paramIdx}`;
      params.push(departmentId);
      paramIdx++;
    }

    sql += ` ORDER BY tank.name ASC`;

    return queryRunner.query(sql, params);
  }

  private mapEquipmentRow(row: EquipmentRawRow): AvailableTank {
    const specs: Record<string, unknown> =
      typeof row.specifications === 'string'
        ? (JSON.parse(row.specifications) as Record<string, unknown>)
        : row.specifications ?? {};

    const volume = Number(row.volume) || Number(specs.volume) || 0;
    const maxBiomass = Number(specs.maxBiomass) || 0;
    const currentBiomass = Number(row.currentBiomass) || 0;
    const maxDensity = Number(specs.maxDensity) || 30;
    const availableCapacity = Math.max(0, maxBiomass - currentBiomass);
    const currentDensity = volume > 0 ? currentBiomass / volume : 0;

    return {
      id: row.id,
      code: row.code,
      name: row.name,
      volume,
      maxBiomass,
      currentBiomass,
      availableCapacity,
      currentCount: Number(row.currentCount) || 0,
      maxDensity,
      currentDensity,
      status: row.status,
      departmentId: row.departmentId || '',
      departmentName: row.departmentName || '',
      siteId: row.siteId || undefined,
      siteName: row.siteName || undefined,
    };
  }

  private mapTankRow(row: TankRawRow): AvailableTank {
    const volume = Number(row.volume) || 0;
    const maxBiomass = Number(row.maxBiomass) || 0;
    const currentBiomass = Number(row.currentBiomass) || 0;
    const maxDensity = Number(row.maxDensity) || 30;
    const availableCapacity = Math.max(0, maxBiomass - currentBiomass);
    const currentDensity = volume > 0 ? currentBiomass / volume : 0;

    return {
      id: row.id,
      code: row.code,
      name: row.name,
      volume,
      maxBiomass,
      currentBiomass,
      availableCapacity,
      currentCount: Number(row.currentCount) || 0,
      maxDensity,
      currentDensity,
      status: row.status,
      departmentId: row.departmentId || '',
      departmentName: row.departmentName || '',
      siteId: row.siteId || undefined,
      siteName: row.siteName || undefined,
    };
  }
}
