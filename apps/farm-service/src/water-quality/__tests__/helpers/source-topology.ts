import { withTenantContext } from '@aquaculture/backend-common/context';
import type { DataSource } from 'typeorm';

import {
  Department,
  DepartmentStatus,
  DepartmentType,
} from '../../../department/entities/department.entity';
import { EquipmentSystem } from '../../../equipment/entities/equipment-system.entity';
import { Equipment } from '../../../equipment/entities/equipment.entity';
import { Site, SiteStatus, SiteType } from '../../../site/entities/site.entity';
import { System, SystemType } from '../../../system/entities/system.entity';
import {
  Tank,
  TankMaterial,
  TankStatus,
  TankType,
  WaterType,
} from '../../../tank/entities/tank.entity';
import { WaterQualityParameterConfig } from '../../entities/water-quality-parameter-config.entity';

/**
 * A site with one recirculating system holding a tank and a biofilter, and the
 * parameter configs the binding rules are exercised against. Written through
 * the entities, so every column default and the config's derived quantity are
 * the production ones.
 */
export interface SourceTopology {
  siteId: string;
  departmentId: string;
  systemId: string;
  tankId: string;
  biofilterId: string;
  /** A sensor id the sensor service would own; farm stores it only as a key. */
  sensorId: string;
  configs: {
    temperature: string;
    ph: string;
    ammonia: string;
    tan: string;
  };
}

export async function seedSourceTopology(
  dataSource: DataSource,
  schema: string,
  tenantId: string,
  userId: string,
): Promise<SourceTopology> {
  const manager = dataSource.manager;
  return withTenantContext(tenantId, async () => {
    const site = await manager.save(
      manager.create(Site, {
        tenantId,
        name: 'Source Site',
        code: 'SRC-SITE',
        type: SiteType.LAND_BASED,
        country: 'NO',
        timezone: 'UTC',
        status: SiteStatus.ACTIVE,
        isActive: true,
      }),
    );
    const department = await manager.save(
      manager.create(Department, {
        tenantId,
        siteId: site.id,
        name: 'Source Department',
        code: 'SRC-DEPT',
        type: DepartmentType.PRODUCTION,
        status: DepartmentStatus.ACTIVE,
        isActive: true,
        isDeleted: false,
        createdBy: userId,
        updatedBy: userId,
      }),
    );
    const system = await manager.save(
      manager.create(System, {
        tenantId,
        siteId: site.id,
        name: 'Loop A',
        code: 'RAS-A',
        type: SystemType.RAS,
        isActive: true,
      }),
    );
    const tank = await manager.save(
      manager.create(Tank, {
        tenantId,
        name: 'Source Tank',
        code: 'SRC-TANK',
        departmentId: department.id,
        systemId: system.id,
        tankType: TankType.CIRCULAR,
        material: TankMaterial.FIBERGLASS,
        waterType: WaterType.SALTWATER,
        diameter: 5,
        depth: 2,
        waterDepth: 2,
        maxBiomass: 1500,
        currentBiomass: 0,
        currentCount: 0,
        maxDensity: 30,
        status: TankStatus.ACTIVE,
        isActive: true,
        createdBy: userId,
        updatedBy: userId,
      }),
    );
    const biofilter = await manager.save(
      manager.create(Equipment, {
        tenantId,
        equipmentTypeId: '0e0e0e0e-0e0e-4e0e-8e0e-0e0e0e0e0e0e',
        name: 'Biofilter',
        code: 'BF-1',
        departmentId: department.id,
        isTank: false,
        isActive: true,
        isDeleted: false,
      }),
    );
    await manager.save(
      manager.create(EquipmentSystem, {
        tenantId,
        equipmentId: biofilter.id,
        systemId: system.id,
      }),
    );
    const config = async (code: string, unit: string): Promise<string> => {
      const saved = await manager.save(
        manager.create(WaterQualityParameterConfig, { tenantId, code, name: code, unit }),
      );
      return saved.id;
    };
    const configs = {
      temperature: await config('temperature', '°C'),
      ph: await config('ph', 'pH'),
      ammonia: await config('ammonia', 'mg/L'),
      tan: await config('total_ammonia_nitrogen', 'mg/L'),
    };
    // The fixture writes through the tenant schema the bootstrap routes to.
    const [{ placed }] = await dataSource.query(
      `SELECT count(*)::int AS placed FROM "${schema}".tanks WHERE id = $1`,
      [tank.id],
    );
    if (placed !== 1) {
      throw new Error(`Source topology was not written to ${schema}`);
    }
    return {
      siteId: site.id,
      departmentId: department.id,
      systemId: system.id,
      tankId: tank.id,
      biofilterId: biofilter.id,
      sensorId: '9a9a9a9a-9a9a-4a9a-8a9a-9a9a9a9a9a9a',
      configs,
    };
  });
}

/** Another active tank in the topology's department, optionally in a loop. */
export async function seedTank(
  dataSource: DataSource,
  tenantId: string,
  topology: Pick<SourceTopology, 'departmentId'>,
  code: string,
  userId: string,
  systemId: string | null = null,
): Promise<string> {
  const manager = dataSource.manager;
  return withTenantContext(tenantId, async () => {
    const tank = await manager.save(
      manager.create(Tank, {
        tenantId,
        name: code,
        code,
        departmentId: topology.departmentId,
        systemId: systemId ?? undefined,
        tankType: TankType.CIRCULAR,
        material: TankMaterial.FIBERGLASS,
        waterType: WaterType.SALTWATER,
        diameter: 5,
        depth: 2,
        waterDepth: 2,
        maxBiomass: 1500,
        currentBiomass: 0,
        currentCount: 0,
        maxDensity: 30,
        status: TankStatus.ACTIVE,
        isActive: true,
        createdBy: userId,
        updatedBy: userId,
      }),
    );
    return tank.id;
  });
}

/** Another loop at the topology's site with one piece of water equipment linked to it. */
export async function seedLoop(
  dataSource: DataSource,
  tenantId: string,
  topology: Pick<SourceTopology, 'siteId' | 'departmentId'>,
  code: string,
): Promise<{ systemId: string; equipmentId: string }> {
  const manager = dataSource.manager;
  return withTenantContext(tenantId, async () => {
    const system = await manager.save(
      manager.create(System, {
        tenantId,
        siteId: topology.siteId,
        name: code,
        code,
        type: SystemType.RAS,
        isActive: true,
      }),
    );
    const equipment = await manager.save(
      manager.create(Equipment, {
        tenantId,
        equipmentTypeId: '0e0e0e0e-0e0e-4e0e-8e0e-0e0e0e0e0e0e',
        name: `${code} filter`,
        code: `${code}-BF`,
        departmentId: topology.departmentId,
        isTank: false,
        isActive: true,
        isDeleted: false,
      }),
    );
    await manager.save(
      manager.create(EquipmentSystem, { tenantId, equipmentId: equipment.id, systemId: system.id }),
    );
    return { systemId: system.id, equipmentId: equipment.id };
  });
}

/** A tank kept as equipment (isTank), linked to the given systems. */
export async function seedEquipmentTank(
  dataSource: DataSource,
  tenantId: string,
  topology: Pick<SourceTopology, 'departmentId'>,
  code: string,
  systemIds: readonly string[],
): Promise<string> {
  const manager = dataSource.manager;
  return withTenantContext(tenantId, async () => {
    const equipment = await manager.save(
      manager.create(Equipment, {
        tenantId,
        equipmentTypeId: '0e0e0e0e-0e0e-4e0e-8e0e-0e0e0e0e0e0e',
        name: code,
        code,
        departmentId: topology.departmentId,
        isTank: true,
        isActive: true,
        isDeleted: false,
      }),
    );
    for (const systemId of systemIds) {
      await manager.save(
        manager.create(EquipmentSystem, { tenantId, equipmentId: equipment.id, systemId }),
      );
    }
    return equipment.id;
  });
}
