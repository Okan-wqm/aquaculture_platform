import { Injectable } from '@nestjs/common';
import { DataSource, FindOptionsWhere, MoreThanOrEqual, LessThanOrEqual, Between } from 'typeorm';
import { QueryHandler, IQueryHandler } from '@nestjs/cqrs';
import { GetPaymentsQuery } from '../queries/get-payments.query';
import { Payment } from '../entities/payment.entity';

@Injectable()
@QueryHandler(GetPaymentsQuery)
export class GetPaymentsHandler implements IQueryHandler<GetPaymentsQuery, Payment[]> {
  constructor(private readonly dataSource: DataSource) {}

  async execute(query: GetPaymentsQuery): Promise<Payment[]> {
    const { tenantId, filter } = query;

    const paymentRepo = this.dataSource.getRepository(Payment);

    const where: FindOptionsWhere<Payment> = { tenantId };

    if (filter?.invoiceId) {
      where.invoiceId = filter.invoiceId;
    }
    if (filter?.status) {
      where.status = filter.status;
    }

    // Handle date range filtering
    if (filter?.startDate && filter?.endDate) {
      where.paymentDate = Between(filter.startDate, filter.endDate);
    } else if (filter?.startDate) {
      where.paymentDate = MoreThanOrEqual(filter.startDate);
    } else if (filter?.endDate) {
      where.paymentDate = LessThanOrEqual(filter.endDate);
    }

    return paymentRepo.find({
      where,
      relations: ['invoice'],
      skip: filter?.offset || 0,
      take: filter?.limit || 20,
      order: { paymentDate: 'DESC' },
    });
  }
}
