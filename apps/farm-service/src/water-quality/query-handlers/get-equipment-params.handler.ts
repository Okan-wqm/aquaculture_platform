/**
 * GetEquipmentParamsHandler
 *
 * Retrieves all active parameter mappings for a specific equipment.
 * Returns with parameterConfig relation loaded.
 *
 * @module WaterQuality/QueryHandlers
 */
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { QueryHandler, IQueryHandler } from '@platform/cqrs';
import { GetEquipmentParamsQuery } from '../queries/get-equipment-params.query';
import { WaterQualityParamEquipment } from '../entities/water-quality-param-equipment.entity';

@Injectable()
@QueryHandler(GetEquipmentParamsQuery)
export class GetEquipmentParamsHandler
  implements IQueryHandler<GetEquipmentParamsQuery, WaterQualityParamEquipment[]>
{
  private readonly logger = new Logger(GetEquipmentParamsHandler.name);

  constructor(
    @InjectRepository(WaterQualityParamEquipment)
    private readonly repository: Repository<WaterQualityParamEquipment>,
  ) {}

  async execute(query: GetEquipmentParamsQuery): Promise<WaterQualityParamEquipment[]> {
    const { tenantId, equipmentId } = query;

    this.logger.debug(
      `Getting active parameter mappings for equipment ${equipmentId}, tenant ${tenantId}`,
    );

    return this.repository.find({
      where: {
        tenantId,
        equipmentId,
        isActive: true,
      },
      relations: ['parameterConfig'],
      order: { createdAt: 'ASC' },
    });
  }
}
