/**
 * ListAvailableTanksHandler
 *
 * Lists available tanks, ponds, and cages for batch allocation with capacity information.
 * Queries equipment where equipmentType.category IN ('tank', 'pond', 'cage').
 *
 * @module Batch/QueryHandlers
 */
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In } from 'typeorm';
import { QueryHandler, IQueryHandler } from '@platform/cqrs';
import { ListAvailableTanksQuery, AvailableTank } from '../queries/list-available-tanks.query';
import { Equipment, TankSpecifications } from '../../equipment/entities/equipment.entity';
import { EquipmentCategory } from '../../equipment/entities/equipment-type.entity';
import { Department } from '../../department/entities/department.entity';

@Injectable()
@QueryHandler(ListAvailableTanksQuery)
export class ListAvailableTanksHandler implements IQueryHandler<ListAvailableTanksQuery, AvailableTank[]> {
  constructor(
    @InjectRepository(Equipment)
    private readonly equipmentRepository: Repository<Equipment>,
  ) {}

  async execute(query: ListAvailableTanksQuery): Promise<AvailableTank[]> {
    const { tenantId, siteId, departmentId, excludeFullTanks } = query;

    // Fish-holding equipment categories (tanks, ponds, cages)
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

    // Filter by operational status (lowercase enum values in database)
    queryBuilder.andWhere('eq.status IN (:...statuses)', {
      statuses: ['operational', 'active', 'preparing', 'fallow'],
    });

    // Optional site filter
    if (siteId) {
      queryBuilder.andWhere('dept.siteId = :siteId', { siteId });
    }

    // Optional department filter
    if (departmentId) {
      queryBuilder.andWhere('eq.departmentId = :departmentId', { departmentId });
    }

    // Order by name
    queryBuilder.orderBy('eq.name', 'ASC');

    const tanks = await queryBuilder.getMany();

    // Transform to AvailableTank format
    const availableTanks: AvailableTank[] = tanks.map(tank => {
      const specs = tank.specifications as TankSpecifications | undefined;

      const volume = tank.volume || specs?.volume || 0;
      const maxBiomass = specs?.maxBiomass || 0;
      const currentBiomass = tank.currentBiomass || 0;
      const maxDensity = specs?.maxDensity || 30; // Default 30 kg/m³

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
    });

    // Optionally exclude full tanks
    if (excludeFullTanks) {
      return availableTanks.filter(t => t.availableCapacity > 0);
    }

    return availableTanks;
  }
}
