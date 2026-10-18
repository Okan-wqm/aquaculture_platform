/**
 * The kind of a stock unit: tank, pond or cage.
 *
 * Tanks, ponds and cages share one key space in `tank_batches` (a batch's
 * location is `tankId || pondId`), so a unit id alone does not say which kind
 * of unit it is; its equipment category does. Protocol assignment records the
 * kind on the assignment, and a growth sample resolved to a unit records the
 * unit in the field of its kind (`tankId` or `pondId`). Both ask here.
 *
 * @module FeedingProtocol/Services
 */
import { EntityManager } from 'typeorm';

import { findTankOrEquipmentWithManager } from '../../batch/utils/tank-lookup.util';
import { EquipmentCategory, EquipmentType } from '../../equipment/entities/equipment-type.entity';
import { FeedingUnitType } from '../entities/protocol-assignment.entity';

/**
 * Equipment category → FeedingUnitType (the SSoT of this mapping: the frontend
 * only picks a visual). No equipment type, or a type that is neither a pond nor
 * a cage, is a tank.
 */
export async function resolveFeedingUnitType(
  manager: EntityManager,
  equipmentTypeId: string | null | undefined,
): Promise<FeedingUnitType> {
  if (!equipmentTypeId) return FeedingUnitType.TANK;
  const equipmentType = await manager.findOne(EquipmentType, {
    where: { id: equipmentTypeId },
  });
  switch (equipmentType?.category) {
    case EquipmentCategory.POND:
      return FeedingUnitType.POND;
    case EquipmentCategory.CAGE:
      return FeedingUnitType.CAGE;
    default:
      return FeedingUnitType.TANK;
  }
}

/**
 * The kind of the unit a `tank_batches` row is keyed by, read as protocol
 * assignment reads it: the unit's equipment category (a row of the legacy
 * `tanks` table carries no equipment type, so it is a tank).
 */
export async function feedingUnitTypeOf(
  manager: EntityManager,
  tenantId: string,
  unitId: string,
): Promise<FeedingUnitType> {
  const lookup = await findTankOrEquipmentWithManager(manager, unitId, tenantId);
  if (lookup === null) return FeedingUnitType.TANK;
  return resolveFeedingUnitType(manager, lookup.equipment.equipmentTypeId);
}
