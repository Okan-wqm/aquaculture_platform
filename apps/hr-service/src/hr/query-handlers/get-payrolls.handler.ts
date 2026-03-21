import { InjectRepository } from '@nestjs/typeorm';
import { Repository, FindOptionsWhere, MoreThanOrEqual, LessThanOrEqual } from 'typeorm';
import { QueryHandler, IQueryHandler, PaginatedQueryResult, createPaginatedQueryResult } from '@platform/cqrs';
import { GetPayrollsQuery } from '../queries/get-payrolls.query';
import { Payroll } from '../entities/payroll.entity';

@QueryHandler(GetPayrollsQuery)
export class GetPayrollsHandler implements IQueryHandler<GetPayrollsQuery, PaginatedQueryResult<Payroll>> {
  constructor(
    @InjectRepository(Payroll)
    private readonly payrollRepository: Repository<Payroll>,
  ) {}

  async execute(query: GetPayrollsQuery): Promise<PaginatedQueryResult<Payroll>> {
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

    const page = filter?.page ?? 1;
    const limit = Math.min(Math.max(filter?.limit ?? 20, 1), 100);
    const offset = (page - 1) * limit;

    const [items, total] = await this.payrollRepository.findAndCount({
      where,
      relations: ['employee'],
      skip: offset,
      take: limit,
      order: { payPeriodStart: 'DESC' },
    });

    return createPaginatedQueryResult(items, page, limit, total);
  }
}
