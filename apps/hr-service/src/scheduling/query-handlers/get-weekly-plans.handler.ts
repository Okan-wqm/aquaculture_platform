import { QueryHandler, IQueryHandler, PaginatedQueryResult, createPaginatedQueryResult } from '@platform/cqrs';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { GetWeeklyPlansQuery } from '../queries/get-weekly-plans.query';
import { WeeklyPlan } from '../entities/weekly-plan.entity';
import { Employee } from '../../hr/entities/employee.entity';

@QueryHandler(GetWeeklyPlansQuery)
export class GetWeeklyPlansHandler implements IQueryHandler<GetWeeklyPlansQuery> {
  constructor(
    @InjectRepository(WeeklyPlan)
    private readonly planRepository: Repository<WeeklyPlan>,
    @InjectRepository(Employee)
    private readonly employeeRepository: Repository<Employee>,
  ) {}

  async execute(query: GetWeeklyPlansQuery): Promise<PaginatedQueryResult<WeeklyPlan>> {
    const {
      tenantId,
      employeeId,
      departmentId,
      siteId,
      weekStartDate,
      status,
    } = query;

    const page = query.page ?? 1;
    const limit = Math.min(Math.max(query.limit ?? 20, 1), 100);
    const offset = (page - 1) * limit;

    const qb = this.planRepository
      .createQueryBuilder('wp')
      .leftJoinAndSelect('wp.entries', 'entries')
      .leftJoinAndSelect('entries.shift', 'shift')
      .leftJoinAndSelect('wp.employee', 'employee')
      .where('wp.tenantId = :tenantId', { tenantId })
      .andWhere('wp.isDeleted = false');

    if (employeeId) {
      qb.andWhere('wp.employeeId = :employeeId', { employeeId });
    }

    if (departmentId) {
      qb.andWhere('employee.departmentHrId = :departmentId', { departmentId });
    }

    if (siteId) {
      qb.andWhere('employee.farmId = :siteId', { siteId });
    }

    if (weekStartDate) {
      const startDate = new Date(weekStartDate);
      qb.andWhere('wp.weekStartDate = :weekStartDate', { weekStartDate: startDate });
    }

    if (status) {
      qb.andWhere('wp.status = :status', { status });
    }

    qb.orderBy('wp.weekStartDate', 'DESC')
      .addOrderBy('employee.firstName', 'ASC')
      .skip(offset)
      .take(limit);

    const [items, total] = await qb.getManyAndCount();

    return createPaginatedQueryResult(items, page, limit, total);
  }
}
