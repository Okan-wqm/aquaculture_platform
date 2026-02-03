import { IQueryHandler, QueryHandler } from '@nestjs/cqrs';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { GetWeeklyPlansQuery } from '../queries/get-weekly-plans.query';
import { WeeklyPlan } from '../entities/weekly-plan.entity';
import { Employee } from '../../hr/entities/employee.entity';
import { ObjectType, Field, Int } from '@nestjs/graphql';

// Maximum limit to prevent performance issues
const MAX_LIMIT = 100;

@ObjectType()
export class WeeklyPlanConnection {
  @Field(() => [WeeklyPlan])
  items!: WeeklyPlan[];

  @Field(() => Int)
  total!: number;

  @Field(() => Int)
  limit!: number;

  @Field(() => Int)
  offset!: number;

  @Field()
  hasMore!: boolean;
}

@QueryHandler(GetWeeklyPlansQuery)
export class GetWeeklyPlansHandler implements IQueryHandler<GetWeeklyPlansQuery> {
  constructor(
    @InjectRepository(WeeklyPlan)
    private readonly planRepository: Repository<WeeklyPlan>,
    @InjectRepository(Employee)
    private readonly employeeRepository: Repository<Employee>,
  ) {}

  async execute(query: GetWeeklyPlansQuery): Promise<WeeklyPlanConnection> {
    const {
      tenantId,
      employeeId,
      departmentId,
      siteId,
      weekStartDate,
      status,
      limit: rawLimit,
      offset,
    } = query;

    // Enforce maximum limit to prevent performance issues
    const limit = Math.min(rawLimit ?? 20, MAX_LIMIT);

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

    return {
      items,
      total,
      limit,
      offset,
      hasMore: offset + items.length < total,
    };
  }
}
