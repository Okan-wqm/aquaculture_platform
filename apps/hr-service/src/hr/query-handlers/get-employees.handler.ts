import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, FindOptionsWhere } from 'typeorm';
import { QueryHandler, IQueryHandler } from '@nestjs/cqrs';
import { GetEmployeesQuery } from '../queries/get-employees.query';
import { Employee } from '../entities/employee.entity';

@Injectable()
@QueryHandler(GetEmployeesQuery)
export class GetEmployeesHandler implements IQueryHandler<GetEmployeesQuery, Employee[]> {
  constructor(
    @InjectRepository(Employee)
    private readonly employeeRepository: Repository<Employee>,
  ) {}

  async execute(query: GetEmployeesQuery): Promise<Employee[]> {
    const { tenantId, filter } = query;

    const where: FindOptionsWhere<Employee> = { tenantId };

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

    return this.employeeRepository.find({
      where,
      skip: filter?.offset || 0,
      take: filter?.limit || 20,
      order: { lastName: 'ASC', firstName: 'ASC' },
    });
  }
}
