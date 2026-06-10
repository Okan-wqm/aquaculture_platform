import { Equipment } from '../entities/equipment.entity';
import { SubEquipment } from '../entities/sub-equipment.entity';

export function equipmentAuditSnapshot(equipment: Equipment): Record<string, unknown> {
  return {
    id: equipment.id,
    departmentId: equipment.departmentId,
    parentEquipmentId: equipment.parentEquipmentId,
    equipmentTypeId: equipment.equipmentTypeId,
    name: equipment.name,
    code: equipment.code,
    status: equipment.status,
    supplierId: equipment.supplierId,
    subEquipmentCount: equipment.subEquipmentCount,
    isActive: equipment.isActive,
    isDeleted: equipment.isDeleted,
    isVisibleInSensor: equipment.isVisibleInSensor,
    version: equipment.version,
  };
}

export function subEquipmentAuditSnapshot(subEquipment: SubEquipment): Record<string, unknown> {
  return {
    id: subEquipment.id,
    parentEquipmentId: subEquipment.parentEquipmentId,
    subEquipmentTypeId: subEquipment.subEquipmentTypeId,
    name: subEquipment.name,
    code: subEquipment.code,
    status: subEquipment.status,
    isActive: subEquipment.isActive,
    version: subEquipment.version,
  };
}
