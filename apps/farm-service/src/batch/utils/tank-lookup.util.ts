/**
 * Tank Lookup Utility
 *
 * Unified lookup across both `equipment` and `tanks` tables.
 * Equipment table is the primary source (new schema); tanks table is legacy fallback.
 *
 * @module Batch/Utils
 */
import { Repository, EntityManager, FindOneOptions } from 'typeorm';
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
 * Adapt a Tank entity to an Equipment-like object for uniform handling.
 * Exported so bulk-fetch call sites (e.g. CreateBatchHandler after the
 * P-H3 N+1 fix) can reuse the same adaptation logic without duplicating
 * the legacy compatibility mapping.
 */
export function adaptTankToEquipment(tank: Tank): Equipment {
  const adapted = new Equipment();
  adapted.id = tank.id;
  adapted.tenantId = tank.tenantId;
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
