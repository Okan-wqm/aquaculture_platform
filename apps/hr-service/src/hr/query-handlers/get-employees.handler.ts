import { InjectRepository } from '@nestjs/typeorm';
import { Repository, FindOptionsWhere } from 'typeorm';
import { QueryHandler, IQueryHandler } from '@nestjs/cqrs';
import { PaginatedQueryResult, createPaginatedQueryResult } from '@platform/cqrs';
import { GetEmployeesQuery } from '../queries/get-employees.query';
import { Employee } from '../entities/employee.entity';
import { employeeScopeWhere } from '../../common/module-scope';

@QueryHandler(GetEmployeesQuery)
export class GetEmployeesHandler implements IQueryHandler<GetEmployeesQuery, PaginatedQueryResult<Employee>> {
  constructor(
    @InjectRepository(Employee)
    private readonly employeeRepository: Repository<Employee>,
  ) {}

  async execute(query: GetEmployeesQuery): Promise<PaginatedQueryResult<Employee>> {
    const { tenantId, filter, pagination, scope } = query;
    const page = pagination?.page ?? 1;
    const limit = Math.min(Math.max(pagination?.limit ?? 20, 1), 100);
    const offset = (page - 1) * limit;

    // The workforce scope, decided on the server and already narrowed by filter.moduleCode
    // (common/workforce-scope.ts). No scope: the caller sees no one.
    const scoped = employeeScopeWhere(scope);
    if (scoped === null) return createPaginatedQueryResult([], page, limit, 0);

    const where: FindOptionsWhere<Employee> = { tenantId, isDeleted: false, ...scoped };

    if (filter?.status) {
      where.status = filter.status;
    }
    if (filter?.employmentType) {
      where.employmentType = filter.employmentType;
    }
    if (filter?.departmentHrId) {
      where.departmentHrId = filter.departmentHrId;
    }
    if (filter?.farmId) {
      where.farmId = filter.farmId;
    }
    if (filter?.supervisorId) {
      where.supervisorId = filter.supervisorId;
    }
    if (filter?.personnelCategory) {
      where.personnelCategory = filter.personnelCategory;
    }
    if (filter?.seaWorthy !== undefined && filter?.seaWorthy !== null) {
      where.seaWorthy = filter.seaWorthy;
    }

    const [items, total] = await this.employeeRepository.findAndCount({
      where,
      skip: offset,
      take: limit,
      order: { lastName: 'ASC', firstName: 'ASC' },
    });

    return createPaginatedQueryResult(items, page, limit, total);
  }
}
