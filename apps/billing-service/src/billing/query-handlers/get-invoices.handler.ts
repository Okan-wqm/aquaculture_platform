import { Injectable } from '@nestjs/common';
import { DataSource, FindOptionsWhere, MoreThanOrEqual, LessThanOrEqual, Between, In } from 'typeorm';
import { QueryHandler, IQueryHandler } from '@nestjs/cqrs';
import { TenantScopedRepository } from '@aquaculture/backend-common';
import { GetInvoicesQuery } from '../queries/get-invoices.query';
import { Invoice } from '../entities/invoice.entity';

@Injectable()
@QueryHandler(GetInvoicesQuery)
export class GetInvoicesHandler implements IQueryHandler<GetInvoicesQuery, Invoice[]> {
  constructor(private readonly dataSource: DataSource) {}

  async execute(query: GetInvoicesQuery): Promise<Invoice[]> {
    const { tenantId, filter } = query;

    const invoiceRepo = TenantScopedRepository.create(this.dataSource, Invoice, tenantId);

    // tenantId is auto-injected by the scoped repo; WHERE stays free
    // for status/date filters only.
    const where: FindOptionsWhere<Invoice> = {};

    if (filter?.statuses && filter.statuses.length > 0) {
      where.status = In(filter.statuses);
    } else if (filter?.status) {
      where.status = filter.status;
    }

    // Handle date range filtering
    if (filter?.startDate && filter?.endDate) {
      where.issueDate = Between(filter.startDate, filter.endDate);
    } else if (filter?.startDate) {
      where.issueDate = MoreThanOrEqual(filter.startDate);
    } else if (filter?.endDate) {
      where.issueDate = LessThanOrEqual(filter.endDate);
    }

    // OPTIMIZED: Conditional eager loading - payments only loaded when requested
    const relations: string[] = ['subscription'];
    if (filter?.includePayments) {
      relations.push('payments');
    }

    // Enforce max limit to prevent memory exhaustion attacks
    const MAX_LIMIT = 100;
    const requestedLimit = filter?.limit || 20;
    const safeLimit = Math.min(Math.max(1, requestedLimit), MAX_LIMIT);

    return invoiceRepo.find({
      where,
      relations,
      skip: Math.max(0, filter?.offset || 0),
      take: safeLimit,
      order: { issueDate: 'DESC' },
    });
  }
}
