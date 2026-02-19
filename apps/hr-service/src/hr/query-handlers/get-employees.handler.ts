import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, FindOptionsWhere } from 'typeorm';
import { QueryHandler, IQueryHandler } from '@nestjs/cqrs';
import { GetEmployeesQuery } from '../queries/get-employees.query';
import { Employee } from '../entities/employee.entity';

export interface PaginatedEmployees {
  items: Employee[];
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
}

@Injectable()
@QueryHandler(GetEmployeesQuery)
export class GetEmployeesHandler implements IQueryHandler<GetEmployeesQuery, PaginatedEmployees> {
  constructor(
    @InjectRepository(Employee)
    private readonly employeeRepository: Repository<Employee>,
  ) {}

  async execute(query: GetEmployeesQuery): Promise<PaginatedEmployees> {
    const { tenantId, filter } = query;

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

    // Enforce pagination limits
    const effectiveLimit = Math.min(Math.max(filter?.limit || 20, 1), 100);
    const effectiveOffset = Math.max(filter?.offset || 0, 0);

    const [items, total] = await this.employeeRepository.findAndCount({
      where,
      skip: effectiveOffset,
      take: effectiveLimit,
      order: { lastName: 'ASC', firstName: 'ASC' },
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
