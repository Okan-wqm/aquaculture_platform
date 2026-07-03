import { IQueryHandler, QueryHandler } from '@nestjs/cqrs';
import { BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ObjectType, Field, ID, Float } from '@nestjs/graphql';
import { GetDepartmentKPIsQuery } from '../queries/get-department-kpis.query';
import { EmployeeKPI } from '../entities/kpi.entity';
import { Employee } from '../../hr/entities/employee.entity';

/**
 * Per-employee achievement within a KPI category, for the department KPI roll-up.
 */
@ObjectType()
export class DepartmentKPIEmployee {
  @Field(() => ID)
  employeeId!: string;

  @Field()
  employeeName!: string;

  @Field(() => Float)
  achievement!: number;
}

@ObjectType()
export class DepartmentKPICategory {
  @Field()
  category!: string;

  @Field(() => Float)
  averageAchievement!: number;

  @Field(() => [DepartmentKPIEmployee])
  employees!: DepartmentKPIEmployee[];
}

/**
 * WHY THIS FILE EXISTS:
 * Backend for the FE `GetDepartmentKPIs` query (performance.operations.ts).
 * The query 400'd before this handler existed (FE shipped ahead of backend).
 * Aggregates the existing per-employee EmployeeKPI rows into category buckets
 * for a department over a period window — no new persistence introduced.
 *
 * EmployeeKPI has no department FK by design (KPIs are owned by an employee),
 * so the department membership is resolved through Employee.departmentHrId,
 * consistent with get-overdue-goals / team-performance-overview.
 *
 * Tenant isolation: KPI rows and employees are both filtered by tenantId.
 * The period window selects KPIs whose [periodStart, periodEnd] overlaps the
 * requested [periodStart, periodEnd].
 */
@QueryHandler(GetDepartmentKPIsQuery)
export class GetDepartmentKPIsHandler implements IQueryHandler<GetDepartmentKPIsQuery> {
  constructor(
    @InjectRepository(EmployeeKPI)
    private readonly kpiRepository: Repository<EmployeeKPI>,
    @InjectRepository(Employee)
    private readonly employeeRepository: Repository<Employee>,
  ) {}

  async execute(query: GetDepartmentKPIsQuery): Promise<DepartmentKPICategory[]> {
    const { tenantId, departmentId, periodStart, periodEnd } = query;

    if (new Date(periodStart) > new Date(periodEnd)) {
      throw new BadRequestException('periodStart must be on or before periodEnd');
    }

    const employees = await this.employeeRepository.find({
      where: { tenantId, departmentHrId: departmentId, isDeleted: false },
    });

    if (employees.length === 0) {
      return [];
    }

    const employeeIds = employees.map((e) => e.id);
    const nameById = new Map(
      employees.map((e) => [e.id, `${e.firstName} ${e.lastName}`.trim()]),
    );

    // Overlapping-period selection: kpi.periodStart <= window.end AND
    // kpi.periodEnd >= window.start.
    const kpis = await this.kpiRepository
      .createQueryBuilder('k')
      .where('k.tenantId = :tenantId', { tenantId })
      .andWhere('k.employeeId IN (:...employeeIds)', { employeeIds })
      .andWhere('k.isDeleted = false')
      .andWhere('k.periodStart <= :periodEnd', { periodEnd })
      .andWhere('k.periodEnd >= :periodStart', { periodStart })
      .getMany();

    // category -> employeeId -> running achievement sum/count (one employee may
    // own several KPIs in the same category; we average them per employee first).
    const byCategory = new Map<string, Map<string, { sum: number; count: number }>>();

    for (const kpi of kpis) {
      let perEmployee = byCategory.get(kpi.category);
      if (!perEmployee) {
        perEmployee = new Map();
        byCategory.set(kpi.category, perEmployee);
      }
      const acc = perEmployee.get(kpi.employeeId) ?? { sum: 0, count: 0 };
      acc.sum += Number(kpi.achievementPercent);
      acc.count += 1;
      perEmployee.set(kpi.employeeId, acc);
    }

    const result: DepartmentKPICategory[] = [];

    for (const [category, perEmployee] of byCategory.entries()) {
      const employeeEntries: DepartmentKPIEmployee[] = [];
      for (const [employeeId, acc] of perEmployee.entries()) {
        const achievement = Math.round((acc.sum / acc.count) * 100) / 100;
        employeeEntries.push({
          employeeId,
          employeeName: nameById.get(employeeId) ?? 'Unknown',
          achievement,
        });
      }

      const averageAchievement =
        employeeEntries.length > 0
          ? Math.round(
              (employeeEntries.reduce((sum, e) => sum + e.achievement, 0) /
                employeeEntries.length) *
                100,
            ) / 100
          : 0;

      employeeEntries.sort((a, b) => b.achievement - a.achievement);

      result.push({ category, averageAchievement, employees: employeeEntries });
    }

    result.sort((a, b) => a.category.localeCompare(b.category));

    return result;
  }
}
