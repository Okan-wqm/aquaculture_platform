import { runInTenantRead } from '@aquaculture/backend-common/database';
import { QueryHandler, IQueryHandler } from '@platform/cqrs';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, In, LessThanOrEqual } from 'typeorm';
import { GetPendingDeliveriesQuery } from '../queries/get-pending-deliveries.query';
import { PurchaseOrder, PurchaseOrderStatus } from '../entities/purchase-order.entity';

@QueryHandler(GetPendingDeliveriesQuery)
export class GetPendingDeliveriesHandler implements IQueryHandler<GetPendingDeliveriesQuery> {
  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  async execute(query: GetPendingDeliveriesQuery): Promise<PurchaseOrder[]> {
    const today = new Date();
    today.setHours(23, 59, 59, 999);

    // Read through the fail-closed tenant boundary.
    return runInTenantRead(this.dataSource, 'farm', query.tenantId, async (queryRunner) => {
      return queryRunner.manager.find(PurchaseOrder, {
        where: {
          tenantId: query.tenantId,
          isDeleted: false,
          status: In([PurchaseOrderStatus.ORDERED, PurchaseOrderStatus.PARTIALLY_RECEIVED]),
          expectedDeliveryDate: LessThanOrEqual(today),
        },
        relations: ['items'],
        order: { expectedDeliveryDate: 'ASC' },
      });
    });
  }
}
