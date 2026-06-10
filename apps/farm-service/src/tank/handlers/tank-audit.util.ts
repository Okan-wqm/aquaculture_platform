import { Tank } from '../entities/tank.entity';

export function tankAuditSnapshot(tank: Tank): Record<string, unknown> {
  return {
    id: tank.id,
    name: tank.name,
    code: tank.code,
    departmentId: tank.departmentId,
    systemId: tank.systemId,
    tankType: tank.tankType,
    material: tank.material,
    waterType: tank.waterType,
    volume: tank.volume,
    waterVolume: tank.waterVolume,
    maxBiomass: tank.maxBiomass,
    currentBiomass: tank.currentBiomass,
    maxDensity: tank.maxDensity,
    status: tank.status,
    statusReason: tank.statusReason,
    isActive: tank.isActive,
  };
}
