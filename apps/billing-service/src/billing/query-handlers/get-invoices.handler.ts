import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, FindOptionsWhere, MoreThanOrEqual, LessThanOrEqual, Between } from 'typeorm';
import { QueryHandler, IQueryHandler } from '@nestjs/cqrs';
import { GetInvoicesQuery } from '../queries/get-invoices.query';
import { Invoice } from '../entities/invoice.entity';

@Injectable()
@QueryHandler(GetInvoicesQuery)
export class GetInvoicesHandler implements IQueryHandler<GetInvoicesQuery, Invoice[]> {
  constructor(
    @InjectRepository(Invoice)
    private readonly invoiceRepository: Repository<Invoice>,
  ) {}

  async execute(query: GetInvoicesQuery): Promise<Invoice[]> {
    const { tenantId, filter } = query;

    const where: FindOptionsWhere<Invoice> = { tenantId };

    if (filter?.status) {
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

    return this.invoiceRepository.find({
      where,
      relations,
      skip: filter?.offset || 0,
      take: filter?.limit || 20,
      order: { issueDate: 'DESC' },
    });
  }
}
