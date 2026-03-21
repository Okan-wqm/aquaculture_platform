import { InjectRepository } from '@nestjs/typeorm';
import { Repository, FindOptionsWhere } from 'typeorm';
import { QueryHandler, IQueryHandler } from '@nestjs/cqrs';
import { PaginatedQueryResult, createPaginatedQueryResult } from '@platform/cqrs';
import { GetEmployeesQuery } from '../queries/get-employees.query';
import { Employee } from '../entities/employee.entity';

@QueryHandler(GetEmployeesQuery)
export class GetEmployeesHandler implements IQueryHandler<GetEmployeesQuery, PaginatedQueryResult<Employee>> {
  constructor(
    @InjectRepository(Employee)
    private readonly employeeRepository: Repository<Employee>,
  ) {}

  async execute(query: GetEmployeesQuery): Promise<PaginatedQueryResult<Employee>> {
    const { tenantId, filter, pagination } = query;

    const where: FindOptionsWhere<Employee> = { tenantId, isDeleted: false };

    if (filter?.status) {
      where.status = filter.status;
    }
    if (filter?.employmentType) {
      where.employmentType = filter.employmentType;
    }
    if (filter?.department) {
      where.department = filter.department;
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

    const page = pagination?.page ?? 1;
    const limit = Math.min(Math.max(pagination?.limit ?? 20, 1), 100);
    const offset = (page - 1) * limit;

    const [items, total] = await this.employeeRepository.findAndCount({
      where,
      skip: offset,
      take: limit,
      order: { lastName: 'ASC', firstName: 'ASC' },
    });

    return createPaginatedQueryResult(items, page, limit, total);
  }
}
