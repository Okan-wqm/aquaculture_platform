import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { QueryHandler, IQueryHandler } from '@nestjs/cqrs';
import { GetEmployeeQuery } from '../queries/get-employee.query';
import { Employee } from '../entities/employee.entity';
import { employeeScopeWhere } from '../../common/module-scope';

@Injectable()
@QueryHandler(GetEmployeeQuery)
export class GetEmployeeHandler implements IQueryHandler<GetEmployeeQuery, Employee> {
  constructor(
    @InjectRepository(Employee)
    private readonly employeeRepository: Repository<Employee>,
  ) {}

  async execute(query: GetEmployeeQuery): Promise<Employee> {
    const { tenantId, employeeId, scope } = query;
    // The workforce scope, decided on the server (common/workforce-scope.ts). No scope: no one.
    const scoped = employeeScopeWhere(scope);
    if (scoped === null) throw new ForbiddenException('This employee is outside your workforce scope');

    const employee = await this.employeeRepository.findOne({
      where: { id: employeeId, tenantId, isDeleted: false },
    });

    if (!employee) {
      throw new NotFoundException(`Employee with id ${employeeId} not found`);
    }

    // A tenant employee outside the scope is refused (HR-HIGH-066): a farm member reading a
    // sensor-only employee by id gets FORBIDDEN, as a list never shows them.
    if (scoped.departmentHr !== undefined) {
      const inScope = await this.employeeRepository.exists({
        where: { id: employeeId, tenantId, isDeleted: false, ...scoped },
      });
      if (!inScope) throw new ForbiddenException('This employee is outside your workforce scope');
    }

    return employee;
  }
}
