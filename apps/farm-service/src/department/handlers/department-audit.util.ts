import { Department } from '../entities/department.entity';

export function departmentAuditSnapshot(department: Department): Record<string, unknown> {
  return {
    id: department.id,
    tenantId: department.tenantId,
    siteId: department.siteId,
    name: department.name,
    code: department.code,
    type: department.type,
    description: department.description,
    capacity: department.capacity,
    notes: department.notes,
    managerUserId: department.managerUserId,
    managerName: department.managerName,
    status: department.status,
    isActive: department.isActive,
    createdBy: department.createdBy,
    updatedBy: department.updatedBy,
    version: department.version,
    isDeleted: department.isDeleted,
    deletedAt: department.deletedAt,
    deletedBy: department.deletedBy,
  };
}
