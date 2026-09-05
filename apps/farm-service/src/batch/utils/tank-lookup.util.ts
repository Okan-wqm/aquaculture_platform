/**
 * Tank Lookup Utility
 *
 * Unified lookup across both `equipment` and `tanks` tables.
 * Equipment table is the primary source (new schema); tanks table is legacy fallback.
 *
 * @module Batch/Utils
 */
import { Repository, EntityManager, FindOneOptions } from 'typeorm';
import { Department } from '../../department/entities/department.entity';
import { Equipment, EquipmentStatus } from '../../equipment/entities/equipment.entity';
import { Tank } from '../../tank/entities/tank.entity';
import { EquipmentType, EquipmentCategory } from '../../equipment/entities/equipment-type.entity';

/**
 * Result of a unified tank/equipment lookup.
 * `equipment` is always populated (Tank data is adapted to Equipment shape when from tanks table).
 */
export interface TankLookupResult {
  /** The equipment entity (or Tank adapted as Equipment-like object) */
  equipment: Equipment;
  /** Whether the record was found in the `tanks` table (legacy) */
  isFromTanksTable: boolean;
  /** The original Tank entity if found from tanks table */
  originalTank?: Tank;
}

/**
 * Find a tank/equipment by ID, checking both equipment and tanks tables.
 * Equipment table is checked first. Uses individual repositories (no transaction).
 */
export async function findTankOrEquipment(
  equipmentRepository: Repository<Equipment>,
  tankRepository: Repository<Tank>,
  equipmentTypeRepository: Repository<EquipmentType>,
  tankId: string,
  tenantId: string,
): Promise<TankLookupResult | null> {
  // 1. Check equipment table first (primary)
  const equipment = await equipmentRepository.findOne({
    where: { id: tankId, tenantId, isActive: true, isDeleted: false },
    relations: ['equipmentType'],
  });

  if (equipment) {
    return { equipment, isFromTanksTable: false };
  }

  // 2. Fallback to tanks table (legacy)
  const tank = await tankRepository.findOne({
    where: { id: tankId, tenantId, isActive: true },
  });

  if (tank) {
    const adapted = adaptTankToEquipment(tank);
    return { equipment: adapted, isFromTanksTable: true, originalTank: tank };
  }

  return null;
}

/**
 * Find a tank/equipment by ID using an EntityManager (transaction-safe).
 * Equipment table is checked first.
 */
export async function findTankOrEquipmentWithManager(
  manager: EntityManager,
  tankId: string,
  tenantId: string,
  lock?: FindOneOptions<Equipment>['lock'],
): Promise<TankLookupResult | null> {
  // 1. Check equipment table first (primary)
  // Existence/biomass updates only need the equipment row itself. Avoid joining
  // reference tables here so tenant-schema writes do not depend on optional
  // lookup-table provisioning during critical stock operations.
  const equipment = await manager.findOne(Equipment, {
    where: { id: tankId, tenantId, isActive: true, isDeleted: false },
    ...(lock ? { lock } : {}),
  });

  if (equipment) {
    return { equipment, isFromTanksTable: false };
  }

  // 2. Fallback to tanks table (legacy)
  const tank = await manager.findOne(Tank, {
    where: { id: tankId, tenantId, isActive: true },
    ...(lock ? { lock } : {}),
  });

  if (tank) {
    const adapted = adaptTankToEquipment(tank);
    return { equipment: adapted, isFromTanksTable: true, originalTank: tank };
  }

  return null;
}

/**
 * Update biomass and count on the correct entity (Equipment or Tank) based on lookup result.
 * Uses EntityManager for transaction safety.
 */
export async function updateTankBiomass(
  manager: EntityManager,
  lookupResult: TankLookupResult,
  biomassKg: number,
  count: number,
): Promise<void> {
  if (lookupResult.isFromTanksTable && lookupResult.originalTank) {
    await manager
      .createQueryBuilder()
      .update(Tank)
      .set({ currentBiomass: biomassKg, currentCount: count })
      .where('id = :id', { id: lookupResult.originalTank.id })
      .execute();
  } else {
    lookupResult.equipment.currentBiomass = biomassKg;
    lookupResult.equipment.currentCount = count;
    await manager.save(Equipment, lookupResult.equipment);
  }
}

/**
 * SEC-HIGH-051: resolve a tank's owning Site id (the ONE tank site-resolver).
 *
 * WHY: object-level site authorization needs the site a batch/tank belongs to.
 * A tank (equipment OR legacy tanks table) carries `departmentId`; the
 * Department carries the nullable `siteId`. Resolving inside the caller's open
 * transaction `manager` serializes the lookup with the handler's existing
 * pessimistic locks, so a concurrent department re-home cannot race the check.
 *
 * WHAT: returns the Site id, or `null` when the tank, its department, or the
 * department's site cannot be resolved. `null` drives the fail-closed deny in
 * {@link SiteAuthorizationService} — a site-less department is NOT an implicit
 * allow. Department.siteId is intentionally nullable, so a department without a
 * site correctly yields `null`.
 */
export async function resolveTankSiteId(
  manager: EntityManager,
  tankId: string,
  tenantId: string,
): Promise<string | null> {
  const lookup = await findTankOrEquipmentWithManager(manager, tankId, tenantId);
  return resolveSiteIdFromDepartment(manager, lookup?.equipment.departmentId, tenantId);
}

/**
 * Bulk counterpart of {@link resolveTankSiteId} for read paths that authorize a
 * LIST of units (W8 — FARM-MEDIUM-274).
 *
 * Same fail-closed contract, same two-table union (`equipment` primary, `tanks`
 * legacy), same "site-less department is not an implicit allow" rule — a unit
 * that resolves to nothing is simply ABSENT from the returned map, which
 * `SiteAuthorizationService.assertSiteAssignment(undefined)` denies. Existing
 * per-unit callers keep using the singular helper; this exists so a bulk read
 * does not become N+1 (and therefore does not get skipped for being expensive,
 * which is exactly how `effectiveUnitTemperatures` ended up unguarded).
 */
export async function resolveUnitSiteIds(
  manager: EntityManager,
  unitIds: string[],
  tenantId: string,
): Promise<Map<string, string>> {
  const resolved = new Map<string, string>();
  if (unitIds.length === 0) {
    return resolved;
  }

  const rows: Array<{ unitId: string; siteId: string | null }> = await manager.query(
    `SELECT DISTINCT ON (u."unitId")
            u."unitId"  AS "unitId",
            d."siteId"  AS "siteId"
       FROM (
         SELECT "id" AS "unitId", "departmentId" FROM equipment
          WHERE "id" = ANY($1) AND "tenantId" = $2
         UNION ALL
         SELECT "id" AS "unitId", "departmentId" FROM tanks
          WHERE "id" = ANY($1) AND "tenantId" = $2
       ) u
       JOIN departments d ON d."id" = u."departmentId" AND d."tenantId" = $2
      WHERE u."departmentId" IS NOT NULL
      ORDER BY u."unitId"`,
    [unitIds, tenantId],
  );

  for (const row of rows) {
    if (row.siteId !== null) {
      resolved.set(row.unitId, row.siteId);
    }
  }
  return resolved;
}

/**
 * SEC-HIGH-051: resolve a Site id from an already-known departmentId (the inner
 * half of {@link resolveTankSiteId}). Call sites that already loaded+locked the
 * tank (e.g. allocate-to-tank) use this to avoid a redundant tank re-lookup.
 * Returns `null` when the departmentId is absent or its department has no site —
 * the fail-closed posture (a site-less department is never an implicit allow).
 */
export async function resolveSiteIdFromDepartment(
  manager: EntityManager,
  departmentId: string | null | undefined,
  tenantId: string,
): Promise<string | null> {
  if (!departmentId) {
    return null;
  }
  const department = await manager.findOne(Department, {
    where: { id: departmentId, tenantId },
  });
  return department?.siteId ?? null;
}

/**
 * Adapt a Tank entity to an Equipment-like object for uniform handling.
 * Exported so bulk-fetch call sites (e.g. CreateBatchHandler after the
 * P-H3 N+1 fix) can reuse the same adaptation logic without duplicating
 * the legacy compatibility mapping.
 */
export function adaptTankToEquipment(tank: Tank): Equipment {
  const adapted = new Equipment();
  adapted.id = tank.id;
  adapted.tenantId = tank.tenantId;
  // SEC-HIGH-051: carry departmentId so site resolution works for the legacy
  // tanks table too (Tank.departmentId is NOT NULL → Department.siteId). Without
  // this the adapted equipment would have an undefined departmentId and a
  // legitimately-sited legacy tank would resolve to null → fail-closed deny.
  adapted.departmentId = tank.departmentId;
  adapted.name = tank.name;
  adapted.code = tank.code;
  adapted.volume = Number(tank.volume) || 0;
  adapted.currentBiomass = Number(tank.currentBiomass) || 0;
  adapted.currentCount = tank.currentCount || 0;
  adapted.status = (tank.status as string) as EquipmentStatus;
  adapted.isTank = true;
  adapted.isActive = tank.isActive;
  adapted.isDeleted = false;
  adapted.specifications = {
    tankType: tank.tankType || 'circular',
    material: (tank.material as string) || 'fiberglass',
    waterType: (tank.waterType as string) || 'freshwater',
    volume: Number(tank.volume) || 0,
    maxBiomass: Number(tank.maxBiomass) || 0,
    maxDensity: Number(tank.maxDensity) || 30,
    dimensions: {
      diameter: tank.diameter ? Number(tank.diameter) : undefined,
      length: tank.length ? Number(tank.length) : undefined,
      width: tank.width ? Number(tank.width) : undefined,
      depth: Number(tank.depth) || 0,
    },
  } as Record<string, unknown>;
  return adapted;
}
