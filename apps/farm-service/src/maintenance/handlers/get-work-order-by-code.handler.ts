/**
 * Get Work Order (by code) Query Handler — fail-closed tenant boundary.
 */
import { runInTenantRead } from '@aquaculture/backend-common/database';
import { NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { QueryHandler, IQueryHandler } from '@platform/cqrs';
import { DataSource } from 'typeorm';

import { WorkOrder } from '../entities/work-order.entity';
import { GetWorkOrderByCodeQuery } from '../queries/get-work-order-by-code.query';

@QueryHandler(GetWorkOrderByCodeQuery)
export class GetWorkOrderByCodeHandler implements IQueryHandler<GetWorkOrderByCodeQuery> {
  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  async execute(query: GetWorkOrderByCodeQuery): Promise<WorkOrder> {
    const { tenantId, code } = query;
    return runInTenantRead(this.dataSource, 'farm', tenantId, async (queryRunner) => {
      const workOrder = await queryRunner.manager.findOne(WorkOrder, {
        where: { workOrderCode: code, tenantId },
      });
      if (!workOrder) {
        throw new NotFoundException(`İş emri bulunamadı: ${code}`);
      }
      return workOrder;
    });
  }
}
