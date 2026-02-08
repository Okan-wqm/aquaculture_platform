import { QueryHandler, IQueryHandler } from '@nestjs/cqrs';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In, LessThanOrEqual } from 'typeorm';
import { GetPendingDeliveriesQuery } from '../queries/get-pending-deliveries.query';
import { PurchaseOrder, PurchaseOrderStatus } from '../entities/purchase-order.entity';

@QueryHandler(GetPendingDeliveriesQuery)
export class GetPendingDeliveriesHandler implements IQueryHandler<GetPendingDeliveriesQuery> {
  constructor(
    @InjectRepository(PurchaseOrder)
    private readonly poRepository: Repository<PurchaseOrder>,
  ) {}

  async execute(query: GetPendingDeliveriesQuery): Promise<PurchaseOrder[]> {
    const today = new Date();
    today.setHours(23, 59, 59, 999);

    return this.poRepository.find({
      where: {
        tenantId: query.tenantId,
        isDeleted: false,
        status: In([PurchaseOrderStatus.ORDERED, PurchaseOrderStatus.PARTIALLY_RECEIVED]),
        expectedDeliveryDate: LessThanOrEqual(today),
      },
      relations: ['items'],
      order: { expectedDeliveryDate: 'ASC' },
    });
  }
}
