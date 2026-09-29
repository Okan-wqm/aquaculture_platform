/**
 * Get Spare-Part Criticality Query Handler (FARM-24) — fail-closed tenant read.
 *
 * WHY: the rules below are pinned to what the schema and its writers actually
 * do, not to what the entity comments suggest. Each one names its evidence.
 *
 * 1. COMPATIBLE TYPE — `spare_parts.equipmentTypeId` when set, otherwise
 *    `compatibleEquipmentTypes` (SparePart.compatibleEquipmentTypes doc: the
 *    list applies "equipmentTypeId NULL ise"). The list is a `simple-array`
 *    TEXT column whose DTO admits any string (`@IsString({ each: true })` in
 *    spare-part.dto.ts), so it is compared as text: a non-id entry matches
 *    nothing instead of failing the read.
 * 2. SAME SITE — equipment has no siteId. Its site is its non-deleted
 *    department's `siteId` (the site create-equipment enforces and emits,
 *    create-equipment.handler.ts:100-104,221), else subSystem → system.siteId
 *    (equipment.entity.ts:141-156). The served system must be at the site too.
 * 3. SERVES A SYSTEM — an `equipment_systems` row: the only place a
 *    criticalityLevel exists. Candidate equipment is not deleted, active and
 *    not DECOMMISSIONED (a unit in repair still needs the part).
 * 4. ACTIVE STOCK — a `tank_batches` row with live fish (`totalQuantity > 0`,
 *    the count SSoT per tank-batch.entity.ts:116-149, or cleaner fish > 0 as
 *    equipment.resolver.ts:322-323 counts them) on a fish-holding unit in the
 *    served system OR any of its non-deleted same-site descendants (a system's
 *    contents include its child systems, get-system-delete-preview.handler.ts
 *    :51-58). Units come from BOTH container sources, as the farm-stock
 *    projection reads them (farm-stock-projection.service.ts:66-68,121-124):
 *    an active `tanks` row via `tanks.systemId` (create-equipment routes
 *    tank-like types there, create-equipment.handler.ts:57-58, and the
 *    equipment API presents `tanks.systemId` as the unit's system link,
 *    tank-equipment-adapter.service.ts:177-190), and an active isTank
 *    `equipment` row via `equipment_systems` or subSystem → system.
 * 5. NO BACKUP — the (equipment, system) link is covered when ANOTHER
 *    equipment of the SAME type serves the same system, is not deleted, is
 *    active, is OPERATIONAL or STANDBY, and either that link or the
 *    candidate's own link has role "backup" (free text, compared trimmed and
 *    case-folded). Symmetric on purpose: a type-level part fits the primary
 *    and its backup alike, so an operational primary must also cover the
 *    backup's link or a fully redundant pair would still read as critical.
 * WHAT: returns the max criticality plus every qualifying equipment/system id.
 */
import { runInTenantRead } from '@aquaculture/backend-common/database';
import { NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { QueryHandler, IQueryHandler } from '@platform/cqrs';
import { DataSource } from 'typeorm';

import { EquipmentStatus } from '../../equipment/entities/equipment.entity';
import { SparePart } from '../entities/spare-part.entity';
import {
  GetSparePartCriticalityQuery,
  SparePartCriticalityResult,
} from '../queries/get-spare-part-criticality.query';

/** equipment_systems.role value that marks a standby unit (equipment-system.entity.ts:55-60). */
const BACKUP_ROLE = 'backup';

/** Statuses in which a backup can take over (STANDBY = "Yedek/Beklemede"). */
const BACKUP_READY_STATUSES: readonly EquipmentStatus[] = [
  EquipmentStatus.OPERATIONAL,
  EquipmentStatus.STANDBY,
];

interface QualifyingLinkRow {
  equipmentId: string;
  systemId: string;
  criticalityLevel: number;
}

// Params: $1 tenantId, $2 siteId, $3 type ids (text[]), $4 excluded candidate
// status, $5 backup-ready statuses (text[]), $6 backup role.
const SPARE_PART_CRITICALITY_SQL = `
WITH RECURSIVE candidate AS (
  SELECT es."equipmentId", es."systemId", es."criticalityLevel", e."equipmentTypeId",
         (es."role" IS NOT NULL AND lower(btrim(es."role")) = $6) AS "isBackupLink"
    FROM "equipment_systems" es
    JOIN "equipment" e ON e."id" = es."equipmentId" AND e."tenantId" = es."tenantId"
    JOIN "systems" s ON s."id" = es."systemId" AND s."tenantId" = es."tenantId"
    LEFT JOIN "departments" d
      ON d."id" = e."departmentId" AND d."tenantId" = e."tenantId" AND d."isDeleted" = false
    LEFT JOIN "sub_systems" ss
      ON ss."id" = e."subSystemId" AND ss."tenantId" = e."tenantId" AND ss."isDeleted" = false
    LEFT JOIN "systems" sss
      ON sss."id" = ss."systemId" AND sss."tenantId" = e."tenantId" AND sss."isDeleted" = false
   WHERE es."tenantId" = $1
     AND e."isDeleted" = false AND e."isActive" = true AND e."status"::text <> $4
     AND e."equipmentTypeId"::text = ANY($3::text[])
     AND s."isDeleted" = false AND s."siteId" = $2
     AND COALESCE(d."siteId", sss."siteId") = $2
), system_tree AS (
  SELECT DISTINCT c."systemId" AS "rootId", c."systemId" AS "memberId" FROM candidate c
  UNION
  SELECT t."rootId", child."id"
    FROM system_tree t
    JOIN "systems" child
      ON child."parentSystemId" = t."memberId" AND child."tenantId" = $1
     AND child."isDeleted" = false AND child."siteId" = $2
), live_unit_system AS (
  SELECT tk."systemId" AS "memberId"
    FROM "tank_batches" tb
    JOIN "tanks" tk ON tk."id" = tb."tankId" AND tk."tenantId" = tb."tenantId"
   WHERE tb."tenantId" = $1 AND tk."isActive" = true
     AND (tb."totalQuantity" > 0 OR tb."cleanerFishQuantity" > 0)
  UNION
  SELECT tes."systemId"
    FROM "tank_batches" tb
    JOIN "equipment" et ON et."id" = tb."tankId" AND et."tenantId" = tb."tenantId"
    JOIN "equipment_systems" tes ON tes."equipmentId" = et."id" AND tes."tenantId" = et."tenantId"
   WHERE tb."tenantId" = $1 AND et."isTank" = true AND et."isDeleted" = false AND et."isActive" = true
     AND (tb."totalQuantity" > 0 OR tb."cleanerFishQuantity" > 0)
  UNION
  SELECT tss."systemId"
    FROM "tank_batches" tb
    JOIN "equipment" et ON et."id" = tb."tankId" AND et."tenantId" = tb."tenantId"
    JOIN "sub_systems" tss
      ON tss."id" = et."subSystemId" AND tss."tenantId" = et."tenantId" AND tss."isDeleted" = false
   WHERE tb."tenantId" = $1 AND et."isTank" = true AND et."isDeleted" = false AND et."isActive" = true
     AND (tb."totalQuantity" > 0 OR tb."cleanerFishQuantity" > 0)
), stocked_root AS (
  SELECT DISTINCT t."rootId"
    FROM system_tree t JOIN live_unit_system l ON l."memberId" = t."memberId"
)
SELECT c."equipmentId", c."systemId", c."criticalityLevel"
  FROM candidate c
  JOIN stocked_root sr ON sr."rootId" = c."systemId"
 WHERE NOT EXISTS (
   SELECT 1
     FROM "equipment_systems" bes
     JOIN "equipment" b ON b."id" = bes."equipmentId" AND b."tenantId" = bes."tenantId"
    WHERE bes."tenantId" = $1 AND bes."systemId" = c."systemId"
      AND bes."equipmentId" <> c."equipmentId" AND b."equipmentTypeId" = c."equipmentTypeId"
      AND b."isDeleted" = false AND b."isActive" = true AND b."status"::text = ANY($5::text[])
      AND (c."isBackupLink" OR (bes."role" IS NOT NULL AND lower(btrim(bes."role")) = $6))
 )`;

@QueryHandler(GetSparePartCriticalityQuery)
export class GetSparePartCriticalityHandler
  implements IQueryHandler<GetSparePartCriticalityQuery, SparePartCriticalityResult>
{
  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  // WHY: one read-only boundary pins + asserts the tenant schema before the
  // part lookup and the criticality scan. WHAT: NotFound for an unknown part;
  // an empty result without running the scan when the part fits no type.
  async execute(query: GetSparePartCriticalityQuery): Promise<SparePartCriticalityResult> {
    const { tenantId, sparePartId, siteId } = query;
    return runInTenantRead(this.dataSource, 'farm', tenantId, async (queryRunner) => {
      const sparePart = await queryRunner.manager.findOne(SparePart, {
        where: { id: sparePartId, tenantId },
      });
      if (!sparePart) {
        throw new NotFoundException(`Yedek parça bulunamadı: ${sparePartId}`);
      }
      const typeIds = compatibleTypeIds(sparePart);
      if (typeIds.length === 0) {
        return summarize(sparePartId, siteId, []);
      }
      const rows: QualifyingLinkRow[] = await queryRunner.manager.query(
        SPARE_PART_CRITICALITY_SQL,
        [
          tenantId,
          siteId,
          typeIds,
          EquipmentStatus.DECOMMISSIONED,
          [...BACKUP_READY_STATUSES],
          BACKUP_ROLE,
        ],
      );
      return summarize(sparePartId, siteId, rows);
    });
  }
}

// WHY: the entity documents the list as the NULL-equipmentTypeId case, so a
// set single type wins. WHAT: the distinct type ids the part fits.
function compatibleTypeIds(
  sparePart: Pick<SparePart, 'equipmentTypeId' | 'compatibleEquipmentTypes'>,
): string[] {
  if (sparePart.equipmentTypeId) {
    return [sparePart.equipmentTypeId];
  }
  return [...new Set(sparePart.compatibleEquipmentTypes ?? [])];
}

// WHY: callers need the max AND the evidence behind it. WHAT: max level (null
// when empty) plus distinct, sorted ids so the output is deterministic.
function summarize(
  sparePartId: string,
  siteId: string,
  rows: readonly QualifyingLinkRow[],
): SparePartCriticalityResult {
  return {
    sparePartId,
    siteId,
    maxCriticalityLevel:
      rows.length === 0 ? null : Math.max(...rows.map((row) => row.criticalityLevel)),
    contributingEquipmentIds: [...new Set(rows.map((row) => row.equipmentId))].sort(),
    contributingSystemIds: [...new Set(rows.map((row) => row.systemId))].sort(),
  };
}
