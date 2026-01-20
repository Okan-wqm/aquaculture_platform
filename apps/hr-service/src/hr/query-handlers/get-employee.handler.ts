import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { QueryHandler, IQueryHandler } from '@nestjs/cqrs';
import { GetEmployeeQuery } from '../queries/get-employee.query';
import { Employee } from '../entities/employee.entity';

@Injectable()
@QueryHandler(GetEmployeeQuery)
export class GetEmployeeHandler implements IQueryHandler<GetEmployeeQuery, Employee> {
  constructor(
    @InjectRepository(Employee)
    private readonly employeeRepository: Repository<Employee>,
  ) {}

  async execute(query: GetEmployeeQuery): Promise<Employee> {
    const { tenantId, employeeId } = query;

    const employee = await this.employeeRepository.findOne({
      where: { id: employeeId, tenantId },
      relations: ['payrolls'],
    });

    if (!employee) {
      throw new NotFoundException(`Employee with id ${employeeId} not found`);
    }

    return employee;
  }
}
