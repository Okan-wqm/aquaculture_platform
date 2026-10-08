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
import { DataSource, FindOptionsWhere, IsNull } from 'typeorm';
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

    // The manual-entry plan: live manual sources. Channel sources and unbound
    // history are read through parameterSourcesAtPoint.
    const base: FindOptionsWhere<WaterQualityParamEquipment> = {
      channelKey: IsNull(),
      unboundAt: IsNull(),
    };
    if (filters?.parameterConfigId) {
      base.parameterConfigId = filters.parameterConfigId;
    }
    if (filters?.isActive !== undefined) {
      base.isActive = filters.isActive;
    }
    // A unit id is a tank point or an equipment point (the classifier filed it).
    const where: Array<FindOptionsWhere<WaterQualityParamEquipment>> = filters?.equipmentId
      ? [
          { ...base, tankId: filters.equipmentId },
          { ...base, equipmentId: filters.equipmentId },
        ]
      : [base];

    // Read through the fail-closed tenant boundary.
    return runInTenantRead(this.dataSource, 'farm', tenantId, async (queryRunner) =>
      queryRunner.manager.find(WaterQualityParamEquipment, {
        where: where.map((clause) => ({ ...clause, tenantId })),
        relations: ['parameterConfig', 'equipment'],
        order: { createdAt: 'ASC' },
      }),
    );
  }
}
