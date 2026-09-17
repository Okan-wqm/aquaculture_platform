/**
 * Ünite tipi çözümü — ekipman kategorisinden FeedingUnitType.
 *
 * WHY it lives here and not inside a handler file: both the protocol assignment
 * and the feeder assignment need the same mapping, and a second copy is how two
 * assignments of the same unit end up disagreeing about whether it is a tank or
 * a cage. One definition, one place.
 *
 * @module FeedingProtocol/Utils
 */
import { EntityManager } from 'typeorm';

import { EquipmentCategory, EquipmentType } from '../../equipment/entities/equipment-type.entity';
import { FeedingUnitType } from '../entities/protocol-assignment.entity';

/** Ekipman kategorisi → FeedingUnitType (FE yalnız görsel seçim yapar; SSoT burasıdır). */
export async function resolveUnitType(
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
