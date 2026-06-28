/**
 * GetEquipmentParamsHandler
 *
 * Retrieves all active parameter mappings for a specific equipment.
 * Returns with parameterConfig relation loaded.
 *
 * @module WaterQuality/QueryHandlers
 */
import { runInTenantRead } from '@aquaculture/backend-common/database';
import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
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
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  async execute(query: GetEquipmentParamsQuery): Promise<WaterQualityParamEquipment[]> {
    const { tenantId, equipmentId } = query;

    this.logger.debug(
      `Getting active parameter mappings for equipment ${equipmentId}, tenant ${tenantId}`,
    );

    // Read through the fail-closed tenant boundary.
    return runInTenantRead(this.dataSource, 'farm', tenantId, async (queryRunner) =>
      queryRunner.manager.find(WaterQualityParamEquipment, {
        where: {
          tenantId,
          equipmentId,
          isActive: true,
        },
        relations: ['parameterConfig'],
        order: { createdAt: 'ASC' },
      }),
    );
  }
}
