import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, FindOptionsWhere, MoreThanOrEqual, LessThanOrEqual, Between } from 'typeorm';
import { QueryHandler, IQueryHandler } from '@nestjs/cqrs';
import { GetPayrollsQuery } from '../queries/get-payrolls.query';
import { Payroll } from '../entities/payroll.entity';

export interface PaginatedPayrolls {
  items: Payroll[];
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
}

@Injectable()
@QueryHandler(GetPayrollsQuery)
export class GetPayrollsHandler implements IQueryHandler<GetPayrollsQuery, PaginatedPayrolls> {
  constructor(
    @InjectRepository(Payroll)
    private readonly payrollRepository: Repository<Payroll>,
  ) {}

  async execute(query: GetPayrollsQuery): Promise<PaginatedPayrolls> {
    const { tenantId, filter } = query;

    const where: FindOptionsWhere<Payroll> = { tenantId };

    if (filter?.employeeId) {
      where.employeeId = filter.employeeId;
    }
    if (filter?.status) {
      where.status = filter.status;
    }

    // Handle date range filtering — find payrolls active during the period
    if (filter?.startDate && filter?.endDate) {
      where.payPeriodStart = LessThanOrEqual(filter.endDate);
      where.payPeriodEnd = MoreThanOrEqual(filter.startDate);
    } else if (filter?.startDate) {
      where.payPeriodStart = MoreThanOrEqual(filter.startDate);
    } else if (filter?.endDate) {
      where.payPeriodEnd = LessThanOrEqual(filter.endDate);
    }

    // Enforce pagination limits
    const effectiveLimit = Math.min(Math.max(filter?.limit || 20, 1), 100);
    const effectiveOffset = Math.max(filter?.offset || 0, 0);

    const [items, total] = await this.payrollRepository.findAndCount({
      where,
      relations: ['employee'],
      skip: effectiveOffset,
      take: effectiveLimit,
      order: { payPeriodStart: 'DESC' },
    });

    return {
      items,
      total,
      limit: effectiveLimit,
      offset: effectiveOffset,
      hasMore: effectiveOffset + items.length < total,
    };
  }
}
