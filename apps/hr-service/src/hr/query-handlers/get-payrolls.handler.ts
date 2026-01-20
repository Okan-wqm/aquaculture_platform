import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, FindOptionsWhere, MoreThanOrEqual, LessThanOrEqual, Between } from 'typeorm';
import { QueryHandler, IQueryHandler } from '@nestjs/cqrs';
import { GetPayrollsQuery } from '../queries/get-payrolls.query';
import { Payroll } from '../entities/payroll.entity';

@Injectable()
@QueryHandler(GetPayrollsQuery)
export class GetPayrollsHandler implements IQueryHandler<GetPayrollsQuery, Payroll[]> {
  constructor(
    @InjectRepository(Payroll)
    private readonly payrollRepository: Repository<Payroll>,
  ) {}

  async execute(query: GetPayrollsQuery): Promise<Payroll[]> {
    const { tenantId, filter } = query;

    const where: FindOptionsWhere<Payroll> = { tenantId };

    if (filter?.employeeId) {
      where.employeeId = filter.employeeId;
    }
    if (filter?.status) {
      where.status = filter.status;
    }

    // Handle date range filtering
    if (filter?.startDate && filter?.endDate) {
      where.payPeriodStart = Between(filter.startDate, filter.endDate);
    } else if (filter?.startDate) {
      where.payPeriodStart = MoreThanOrEqual(filter.startDate);
    } else if (filter?.endDate) {
      where.payPeriodEnd = LessThanOrEqual(filter.endDate);
    }

    return this.payrollRepository.find({
      where,
      relations: ['employee'],
      skip: filter?.offset || 0,
      take: filter?.limit || 20,
      order: { payPeriodStart: 'DESC' },
    });
  }
}
