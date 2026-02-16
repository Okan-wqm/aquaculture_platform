/**
 * ListAvailableTanksHandler
 *
 * Lists available tanks, ponds, and cages for batch allocation with capacity information.
 * Queries BOTH the `equipment` table AND the `tanks` table (unified lookup).
 *
 * @module Batch/QueryHandlers
 */
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { QueryHandler, IQueryHandler } from '@platform/cqrs';
import { ListAvailableTanksQuery, AvailableTank } from '../queries/list-available-tanks.query';
import { Equipment, TankSpecifications } from '../../equipment/entities/equipment.entity';
import { EquipmentCategory, EquipmentType } from '../../equipment/entities/equipment-type.entity';
import { Tank, TankStatus } from '../../tank/entities/tank.entity';
import { Department } from '../../department/entities/department.entity';

/** Tank statuses considered operational for batch allocation (all except INACTIVE) */
const OPERATIONAL_TANK_STATUSES: TankStatus[] = [
  TankStatus.ACTIVE,
  TankStatus.PREPARING,
  TankStatus.FALLOW,
  TankStatus.CLEANING,
  TankStatus.MAINTENANCE,
  TankStatus.HARVESTING,
  TankStatus.QUARANTINE,
];

@Injectable()
@QueryHandler(ListAvailableTanksQuery)
export class ListAvailableTanksHandler implements IQueryHandler<ListAvailableTanksQuery, AvailableTank[]> {
  constructor(
    @InjectRepository(Equipment)
    private readonly equipmentRepository: Repository<Equipment>,
    @InjectRepository(Tank)
    private readonly tankRepository: Repository<Tank>,
    @InjectRepository(EquipmentType)
    private readonly equipmentTypeRepository: Repository<EquipmentType>,
  ) {}

  async execute(query: ListAvailableTanksQuery): Promise<AvailableTank[]> {
    const { tenantId, siteId, departmentId, excludeFullTanks } = query;

    // Query both tables in parallel
    const [equipmentTanks, tanksTableTanks] = await Promise.all([
      this.queryEquipmentTable(tenantId, siteId, departmentId),
      this.queryTanksTable(tenantId, siteId, departmentId),
    ]);

    // Transform equipment results
    const fromEquipment: AvailableTank[] = equipmentTanks.map(tank => this.equipmentToAvailableTank(tank));

    // Transform tanks table results
    const fromTanks: AvailableTank[] = tanksTableTanks.map(tank => this.tankToAvailableTank(tank));

    // Merge and deduplicate by ID (equipment table takes precedence)
    const seenIds = new Set(fromEquipment.map(t => t.id));
    const merged = [
      ...fromEquipment,
      ...fromTanks.filter(t => !seenIds.has(t.id)),
    ];

    // Sort by name
    merged.sort((a, b) => (a.name || '').localeCompare(b.name || ''));

    // Optionally exclude full tanks
    if (excludeFullTanks) {
      return merged.filter(t => t.availableCapacity > 0);
    }

    return merged;
  }

  private async queryEquipmentTable(
    tenantId: string,
    siteId?: string,
    departmentId?: string,
  ): Promise<Equipment[]> {
    const fishHoldingCategories = [
      EquipmentCategory.TANK,
      EquipmentCategory.POND,
      EquipmentCategory.CAGE,
    ];

    const queryBuilder = this.equipmentRepository
      .createQueryBuilder('eq')
      .leftJoinAndSelect('eq.department', 'dept')
      .leftJoinAndSelect('dept.site', 'site')
      .leftJoinAndSelect('eq.equipmentType', 'eqType')
      .where('eq.tenantId = :tenantId', { tenantId })
      .andWhere('eqType.category IN (:...categories)', { categories: fishHoldingCategories })
      .andWhere('eq.isActive = :isActive', { isActive: true })
      .andWhere('eq.isDeleted = :isDeleted', { isDeleted: false });

    queryBuilder.andWhere('eq.status IN (:...statuses)', {
      statuses: ['operational', 'active', 'preparing', 'fallow', 'cleaning', 'maintenance', 'harvesting', 'quarantine'],
    });

    if (siteId) {
      queryBuilder.andWhere('dept.siteId = :siteId', { siteId });
    }

    if (departmentId) {
      queryBuilder.andWhere('eq.departmentId = :departmentId', { departmentId });
    }

    queryBuilder.orderBy('eq.name', 'ASC');

    return queryBuilder.getMany();
  }

  private async queryTanksTable(
    tenantId: string,
    siteId?: string,
    departmentId?: string,
  ): Promise<Tank[]> {
    const queryBuilder = this.tankRepository
      .createQueryBuilder('tank')
      .leftJoinAndSelect('tank.department', 'dept')
      .leftJoinAndSelect('dept.site', 'site')
      .where('tank.tenantId = :tenantId', { tenantId })
      .andWhere('tank.isActive = :isActive', { isActive: true })
      .andWhere('tank.status IN (:...statuses)', {
        statuses: OPERATIONAL_TANK_STATUSES,
      });

    if (siteId) {
      queryBuilder.andWhere('dept.siteId = :siteId', { siteId });
    }

    if (departmentId) {
      queryBuilder.andWhere('tank.departmentId = :departmentId', { departmentId });
    }

    queryBuilder.orderBy('tank.name', 'ASC');

    return queryBuilder.getMany();
  }

  private equipmentToAvailableTank(tank: Equipment): AvailableTank {
    const specs = tank.specifications as TankSpecifications | undefined;

    const volume = tank.volume || specs?.volume || 0;
    const maxBiomass = specs?.maxBiomass || 0;
    const currentBiomass = tank.currentBiomass || 0;
    const maxDensity = specs?.maxDensity || 30;

    const availableCapacity = Math.max(0, maxBiomass - currentBiomass);
    const currentDensity = volume > 0 ? currentBiomass / volume : 0;

    return {
      id: tank.id,
      code: tank.code,
      name: tank.name,
      volume,
      maxBiomass,
      currentBiomass,
      availableCapacity,
      currentCount: tank.currentCount || 0,
      maxDensity,
      currentDensity,
      status: tank.status,
      departmentId: tank.departmentId || '',
      departmentName: tank.department?.name || '',
      siteId: tank.department?.siteId || undefined,
      siteName: tank.department?.site?.name || undefined,
    };
  }

  private tankToAvailableTank(tank: Tank): AvailableTank {
    const volume = Number(tank.volume) || 0;
    const maxBiomass = Number(tank.maxBiomass) || 0;
    const currentBiomass = Number(tank.currentBiomass) || 0;
    const maxDensity = Number(tank.maxDensity) || 30;

    const availableCapacity = Math.max(0, maxBiomass - currentBiomass);
    const currentDensity = volume > 0 ? currentBiomass / volume : 0;

    // Map TankStatus to equipment-compatible status string
    const statusMap: Record<TankStatus, string> = {
      [TankStatus.ACTIVE]: 'active',
      [TankStatus.PREPARING]: 'preparing',
      [TankStatus.CLEANING]: 'cleaning',
      [TankStatus.MAINTENANCE]: 'maintenance',
      [TankStatus.HARVESTING]: 'harvesting',
      [TankStatus.FALLOW]: 'fallow',
      [TankStatus.QUARANTINE]: 'quarantine',
      [TankStatus.INACTIVE]: 'out_of_service',
    };

    return {
      id: tank.id,
      code: tank.code,
      name: tank.name,
      volume,
      maxBiomass,
      currentBiomass,
      availableCapacity,
      currentCount: tank.currentCount || 0,
      maxDensity,
      currentDensity,
      status: statusMap[tank.status] || tank.status,
      departmentId: tank.departmentId || '',
      departmentName: tank.department?.name || '',
      siteId: tank.department?.siteId || undefined,
      siteName: tank.department?.site?.name || undefined,
    };
  }
}
