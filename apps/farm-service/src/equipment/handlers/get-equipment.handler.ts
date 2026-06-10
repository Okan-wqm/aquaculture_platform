/**
 * Get Equipment Query Handler
 */
import { tenantManagerRepo } from '@aquaculture/backend-common/database';
import { NotFoundException } from '@nestjs/common';
import { QueryHandler, IQueryHandler } from '@platform/cqrs';
import { DataSource } from 'typeorm';

import { Tank } from '../../tank/entities/tank.entity';
import { Equipment } from '../entities/equipment.entity';
import { GetEquipmentQuery } from '../queries/get-equipment.query';
import { TankEquipmentAdapterService } from '../services/tank-equipment-adapter.service';

@QueryHandler(GetEquipmentQuery)
export class GetEquipmentHandler implements IQueryHandler<GetEquipmentQuery> {
  constructor(
    private readonly dataSource: DataSource,
    private readonly tankEquipmentAdapter: TankEquipmentAdapterService,
  ) {}

  async execute(query: GetEquipmentQuery): Promise<Equipment> {
    const { equipmentId, tenantId, includeRelations } = query;

    const relations: string[] = [];
    if (includeRelations) {
      relations.push('department');
      relations.push('equipmentType');
      relations.push('equipmentSystems');
      relations.push('equipmentSystems.system');
    }

    const equipmentRepository = tenantManagerRepo(this.dataSource.manager, Equipment, tenantId);
    const tankRepository = tenantManagerRepo(this.dataSource.manager, Tank, tenantId);

    const equipment = await equipmentRepository.findOne({
      where: { id: equipmentId, tenantId },
      relations,
    });
    if (equipment) return equipment;

    const tank = await tankRepository.findOne({
      where: { id: equipmentId, tenantId },
      relations: includeRelations ? ['department'] : [],
    });
    if (tank) {
      const equipmentType = await this.tankEquipmentAdapter.resolveEquipmentTypeForTank(tank);
      return this.tankEquipmentAdapter.toEquipmentResponse(tank, equipmentType);
    }

    throw new NotFoundException(`Equipment with ID "${equipmentId}" not found`);
  }
}
