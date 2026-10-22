/**
 * GetEmployeeHandler — the employee detail read.
 *
 * `Employee.departmentHr` is not joined here: EmployeeFieldsResolver resolves it
 * from `departmentHrId` for every operation that returns an employee.
 */
import { NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { GetEmployeeHandler } from '../../query-handlers/get-employee.handler';
import { GetEmployeeQuery } from '../../queries/get-employee.query';
import { Employee } from '../../entities/employee.entity';

const tenantId = 'tenant-uuid-001';
const employeeId = '0b7e5c1a-6f2d-4b8e-9a31-2c4d5e6f7a80';

describe('GetEmployeeHandler', () => {
  let handler: GetEmployeeHandler;
  let findOne: jest.Mock;

  beforeEach(async () => {
    findOne = jest.fn().mockResolvedValue(new Employee());
    const employeeRepository: Partial<Repository<Employee>> = { findOne };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        GetEmployeeHandler,
        { provide: getRepositoryToken(Employee), useValue: employeeRepository },
      ],
    }).compile();

    handler = module.get(GetEmployeeHandler);
  });

  afterEach(() => jest.clearAllMocks());

  it('reads the live employee of the tenant', async () => {
    await handler.execute(new GetEmployeeQuery(tenantId, employeeId));

    expect(findOne).toHaveBeenCalledWith({
      where: { id: employeeId, tenantId, isDeleted: false },
    });
  });

  it('throws NotFoundException when there is no such employee in the tenant', async () => {
    findOne.mockResolvedValue(null);

    await expect(handler.execute(new GetEmployeeQuery(tenantId, employeeId))).rejects.toThrow(
      NotFoundException,
    );
  });
});
