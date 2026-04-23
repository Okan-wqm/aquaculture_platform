import { Injectable } from '@nestjs/common';
import { DataSource, FindOptionsWhere, MoreThanOrEqual, LessThanOrEqual, Between } from 'typeorm';
import { QueryHandler, IQueryHandler } from '@nestjs/cqrs';
import { TenantScopedRepository } from '@aquaculture/backend-common';
import { GetPaymentsQuery } from '../queries/get-payments.query';
import { Payment } from '../entities/payment.entity';

@Injectable()
@QueryHandler(GetPaymentsQuery)
export class GetPaymentsHandler implements IQueryHandler<GetPaymentsQuery, Payment[]> {
  constructor(private readonly dataSource: DataSource) {}

  async execute(query: GetPaymentsQuery): Promise<Payment[]> {
    const { tenantId, filter } = query;

    const paymentRepo = TenantScopedRepository.create(this.dataSource, Payment, tenantId);

    // tenantId is auto-injected by TenantScopedRepository — the
    // IDOR/cross-tenant payment-for-another-tenant's-invoice risk is
    // closed by construction (previously relied on the manual
    // composite-where convention documented below).
    const where: FindOptionsWhere<Payment> = {};

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

    // Enforce max limit to prevent memory exhaustion
    const MAX_LIMIT = 100;
    const requestedLimit = filter?.limit || 20;
    const safeLimit = Math.min(Math.max(1, requestedLimit), MAX_LIMIT);

    return paymentRepo.find({
      where,
      relations: ['invoice'],
      skip: Math.max(0, filter?.offset || 0),
      take: safeLimit,
      order: { paymentDate: 'DESC' },
    });
  }
}
