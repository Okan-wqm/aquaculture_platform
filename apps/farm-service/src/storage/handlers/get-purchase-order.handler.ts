import { QueryHandler, IQueryHandler } from '@platform/cqrs';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { NotFoundException } from '@nestjs/common';
import { GetPurchaseOrderQuery } from '../queries/get-purchase-order.query';
import { PurchaseOrder } from '../entities/purchase-order.entity';

@QueryHandler(GetPurchaseOrderQuery)
export class GetPurchaseOrderHandler implements IQueryHandler<GetPurchaseOrderQuery> {
  constructor(
    @InjectRepository(PurchaseOrder)
    private readonly poRepository: Repository<PurchaseOrder>,
  ) {}

  async execute(query: GetPurchaseOrderQuery): Promise<PurchaseOrder> {
    const po = await this.poRepository.findOne({
      where: { id: query.id, tenantId: query.tenantId, isDeleted: false },
      relations: ['items'],
    });

    if (!po) {
      throw new NotFoundException(`Purchase order "${query.id}" not found`);
    }

    return po;
  }
}
