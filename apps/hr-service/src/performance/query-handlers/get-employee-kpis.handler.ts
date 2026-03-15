import { IQueryHandler, QueryHandler } from '@nestjs/cqrs';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { GetEmployeeKPIsQuery } from '../queries/get-employee-kpis.query';
import { EmployeeKPI } from '../entities/kpi.entity';

@QueryHandler(GetEmployeeKPIsQuery)
export class GetEmployeeKPIsHandler implements IQueryHandler<GetEmployeeKPIsQuery> {
  constructor(
    @InjectRepository(EmployeeKPI)
    private readonly kpiRepository: Repository<EmployeeKPI>,
  ) {}

  async execute(query: GetEmployeeKPIsQuery): Promise<EmployeeKPI[]> {
    const { tenantId, employeeId, periodStart, periodEnd } = query;

    const qb = this.kpiRepository
      .createQueryBuilder('kpi')
      .where('kpi.tenantId = :tenantId', { tenantId })
      .andWhere('kpi.employeeId = :employeeId', { employeeId })
      .andWhere('kpi.isDeleted = false')
      .orderBy('kpi.category', 'ASC')
      .addOrderBy('kpi.name', 'ASC');

    if (periodStart) {
      qb.andWhere('kpi.periodStart >= :periodStart', { periodStart });
    }

    if (periodEnd) {
      qb.andWhere('kpi.periodEnd <= :periodEnd', { periodEnd });
    }

    return qb.getMany();
  }
}
