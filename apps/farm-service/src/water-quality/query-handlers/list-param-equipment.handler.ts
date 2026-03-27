/**
 * ListParamEquipmentHandler
 *
 * Lists parameter-equipment mappings filtered by tenant and optional criteria.
 * Includes parameterConfig and equipment relations.
 *
 * @module WaterQuality/QueryHandlers
 */
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, FindOptionsWhere } from 'typeorm';
import { QueryHandler, IQueryHandler } from '@platform/cqrs';
import { ListParamEquipmentQuery } from '../queries/list-param-equipment.query';
import { WaterQualityParamEquipment } from '../entities/water-quality-param-equipment.entity';

@Injectable()
@QueryHandler(ListParamEquipmentQuery)
export class ListParamEquipmentHandler
  implements IQueryHandler<ListParamEquipmentQuery, WaterQualityParamEquipment[]>
{
  private readonly logger = new Logger(ListParamEquipmentHandler.name);

  constructor(
    @InjectRepository(WaterQualityParamEquipment)
    private readonly repository: Repository<WaterQualityParamEquipment>,
  ) {}

  async execute(query: ListParamEquipmentQuery): Promise<WaterQualityParamEquipment[]> {
    const { tenantId, filters } = query;

    this.logger.debug(`Listing param-equipment mappings for tenant ${tenantId}`);

    const where: FindOptionsWhere<WaterQualityParamEquipment> = { tenantId };

    if (filters) {
      if (filters.equipmentId) {
        where.equipmentId = filters.equipmentId;
      }
      if (filters.parameterConfigId) {
        where.parameterConfigId = filters.parameterConfigId;
      }
      if (filters.isActive !== undefined) {
        where.isActive = filters.isActive;
      }
    }

    return this.repository.find({
      where,
      relations: ['parameterConfig', 'equipment'],
      order: { createdAt: 'ASC' },
    });
  }
}
