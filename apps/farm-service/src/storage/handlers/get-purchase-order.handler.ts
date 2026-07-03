import { runInTenantRead } from '@aquaculture/backend-common/database';
import { QueryHandler, IQueryHandler } from '@platform/cqrs';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { NotFoundException } from '@nestjs/common';
import { GetPurchaseOrderQuery } from '../queries/get-purchase-order.query';
import { PurchaseOrder } from '../entities/purchase-order.entity';

@QueryHandler(GetPurchaseOrderQuery)
export class GetPurchaseOrderHandler implements IQueryHandler<GetPurchaseOrderQuery> {
  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  async execute(query: GetPurchaseOrderQuery): Promise<PurchaseOrder> {
    // Read through the fail-closed tenant boundary.
    return runInTenantRead(this.dataSource, 'farm', query.tenantId, async (queryRunner) => {
      const po = await queryRunner.manager.findOne(PurchaseOrder, {
        where: { id: query.id, tenantId: query.tenantId, isDeleted: false },
        relations: ['items'],
      });

      if (!po) {
        throw new NotFoundException(`Purchase order "${query.id}" not found`);
      }

      return po;
    });
  }
}
