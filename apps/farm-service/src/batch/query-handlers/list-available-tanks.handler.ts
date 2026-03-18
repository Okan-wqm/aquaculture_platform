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
import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { QueryHandler, IQueryHandler } from '@platform/cqrs';
import { ListAvailableTanksQuery, AvailableTank } from '../queries/list-available-tanks.query';

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

    // SECURITY: Validate tenantId is a well-formed UUID before using it in schema name
    if (!UUID_REGEX.test(tenantId)) {
      throw new BadRequestException('Invalid tenant ID format');
    }

    // Compute tenant schema name from tenantId (must match TenantSchemaMiddleware logic)
    const schemaName = `tenant_${tenantId.replace(/-/g, '').substring(0, 16).toLowerCase()}`;


    // Use a dedicated queryRunner so SET search_path and SELECT run on the SAME connection
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();

    try {
      await queryRunner.query(`SET search_path TO "${schemaName}", farm, public`);

      const [equipmentRows, tankRows] = await Promise.all([
        this.queryEquipmentRaw(queryRunner, tenantId, siteId, departmentId),
        this.queryTanksRaw(queryRunner, tenantId, siteId, departmentId),
      ]);

      this.logger.debug(`Results: equipment=${equipmentRows.length}, tanks=${tankRows.length}`);

      // Merge and deduplicate (equipment takes precedence)
      const seenIds = new Set(equipmentRows.map((r: any) => r.id));
      const merged: AvailableTank[] = [
        ...equipmentRows.map((r: any) => this.mapEquipmentRow(r)),
        ...tankRows.filter((r: any) => !seenIds.has(r.id)).map((r: any) => this.mapTankRow(r)),
      ];

      merged.sort((a, b) => (a.name || '').localeCompare(b.name || ''));

      if (excludeFullTanks) {
        return merged.filter(t => t.availableCapacity > 0);
      }

      return merged;
    } finally {
      await queryRunner.query('RESET search_path').catch(() => {});
      await queryRunner.release();
    }
  }

  private async queryEquipmentRaw(
    queryRunner: any,
    tenantId: string,
    siteId?: string,
    departmentId?: string,
  ): Promise<any[]> {
    const params: any[] = [tenantId, FISH_HOLDING_CATEGORIES];
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
    queryRunner: any,
    tenantId: string,
    siteId?: string,
    departmentId?: string,
  ): Promise<any[]> {
    const params: any[] = [tenantId, OPERATIONAL_TANK_STATUSES];
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

  private mapEquipmentRow(row: any): AvailableTank {
    const specs = typeof row.specifications === 'string'
      ? JSON.parse(row.specifications)
      : row.specifications || {};

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

  private mapTankRow(row: any): AvailableTank {
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
