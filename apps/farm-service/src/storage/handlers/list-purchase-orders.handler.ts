import { QueryHandler, IQueryHandler } from '@nestjs/cqrs';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ListPurchaseOrdersQuery } from '../queries/list-purchase-orders.query';
import { PurchaseOrder } from '../entities/purchase-order.entity';

@QueryHandler(ListPurchaseOrdersQuery)
export class ListPurchaseOrdersHandler implements IQueryHandler<ListPurchaseOrdersQuery> {
  constructor(
    @InjectRepository(PurchaseOrder)
    private readonly poRepository: Repository<PurchaseOrder>,
  ) {}

  async execute(query: ListPurchaseOrdersQuery) {
    const { tenantId, category, status, page = 1, limit = 50 } = query;

    const qb = this.poRepository.createQueryBuilder('po')
      .leftJoinAndSelect('po.items', 'items')
      .where('po.tenantId = :tenantId', { tenantId })
      .andWhere('po.isDeleted = :isDeleted', { isDeleted: false });

    if (category) {
      qb.andWhere('po.category = :category', { category });
    }
    if (status) {
      qb.andWhere('po.status = :status', { status });
    }

    qb.orderBy('po.createdAt', 'DESC');

    const [items, total] = await qb
      .skip((page - 1) * limit)
      .take(limit)
      .getManyAndCount();

    return {
      items,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }
}
