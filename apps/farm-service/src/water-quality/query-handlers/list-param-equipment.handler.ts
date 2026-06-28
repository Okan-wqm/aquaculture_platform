/**
 * ListParamEquipmentHandler
 *
 * Lists parameter-equipment mappings filtered by tenant and optional criteria.
 * Includes parameterConfig and equipment relations.
 *
 * @module WaterQuality/QueryHandlers
 */
import { runInTenantRead } from '@aquaculture/backend-common/database';
import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, FindOptionsWhere } from 'typeorm';
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
    @InjectDataSource()
    private readonly dataSource: DataSource,
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

    // Read through the fail-closed tenant boundary.
    return runInTenantRead(this.dataSource, 'farm', tenantId, async (queryRunner) =>
      queryRunner.manager.find(WaterQualityParamEquipment, {
        where,
        relations: ['parameterConfig', 'equipment'],
        order: { createdAt: 'ASC' },
      }),
    );
  }
}
