/**
 * Get SubEquipment Query Handler
 */
import { runInTenantRead } from '@aquaculture/backend-common/database';
import { QueryHandler, IQueryHandler } from '@platform/cqrs';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { NotFoundException } from '@nestjs/common';
import { GetSubEquipmentQuery } from '../queries/get-sub-equipment.query';
import { SubEquipment } from '../entities/sub-equipment.entity';

@QueryHandler(GetSubEquipmentQuery)
export class GetSubEquipmentHandler implements IQueryHandler<GetSubEquipmentQuery> {
  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  async execute(query: GetSubEquipmentQuery): Promise<SubEquipment> {
    const { id, tenantId, includeRelations } = query;

    // Read through the fail-closed tenant boundary.
    return runInTenantRead(this.dataSource, 'farm', tenantId, async (queryRunner) => {
      const relations = includeRelations
        ? ['subEquipmentType', 'parentEquipment', 'parentEquipment.equipmentType']
        : ['subEquipmentType'];

      const subEquipment = await queryRunner.manager.findOne(SubEquipment, {
        where: { id, tenantId },
        relations,
      });

      if (!subEquipment) {
        throw new NotFoundException(`Sub-equipment with ID "${id}" not found`);
      }

      return subEquipment;
    });
  }
}
