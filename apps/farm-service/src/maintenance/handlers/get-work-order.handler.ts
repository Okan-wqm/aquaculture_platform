/**
 * Get Work Order (by id) Query Handler — fail-closed tenant boundary
 * (FARM-HIGH-060).
 */
import { runInTenantRead } from '@aquaculture/backend-common/database';
import { NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { QueryHandler, IQueryHandler } from '@platform/cqrs';
import { DataSource } from 'typeorm';

import { WorkOrder } from '../entities/work-order.entity';
import { GetWorkOrderQuery } from '../queries/get-work-order.query';

@QueryHandler(GetWorkOrderQuery)
export class GetWorkOrderHandler implements IQueryHandler<GetWorkOrderQuery> {
  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  async execute(query: GetWorkOrderQuery): Promise<WorkOrder> {
    const { tenantId, id } = query;
    return runInTenantRead(this.dataSource, 'farm', tenantId, async (queryRunner) => {
      const workOrder = await queryRunner.manager.findOne(WorkOrder, { where: { id, tenantId } });
      if (!workOrder) {
        throw new NotFoundException(`İş emri bulunamadı: ${id}`);
      }
      return workOrder;
    });
  }
}
