import { System } from '../entities/system.entity';

export function systemAuditSnapshot(system: System): Record<string, unknown> {
  return {
    id: system.id,
    tenantId: system.tenantId,
    siteId: system.siteId,
    departmentId: system.departmentId,
    parentSystemId: system.parentSystemId,
    name: system.name,
    code: system.code,
    type: system.type,
    description: system.description,
    totalVolumeM3: system.totalVolumeM3,
    maxBiomassKg: system.maxBiomassKg,
    tankCount: system.tankCount,
    status: system.status,
    isActive: system.isActive,
    createdBy: system.createdBy,
    updatedBy: system.updatedBy,
    version: system.version,
    isDeleted: system.isDeleted,
    deletedAt: system.deletedAt,
    deletedBy: system.deletedBy,
  };
}
