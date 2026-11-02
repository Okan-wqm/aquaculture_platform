/**
 * GetEmployeeHandler — the employee detail read.
 *
 * `Employee.departmentHr` is not joined here: EmployeeFieldsResolver resolves it
 * from `departmentHrId` for every operation that returns an employee. The read is
 * held to the workforce scope the resolver decided (HR-HIGH-066): an employee of
 * the tenant outside it is FORBIDDEN, as no list shows them.
 */
import { ALL_MODULES_SCOPE, OWNER_MODULE, moduleScopeOf } from '@aquaculture/shared-contracts';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';

import { GetEmployeeHandler } from '../../query-handlers/get-employee.handler';
import { GetEmployeeQuery } from '../../queries/get-employee.query';
import { Employee } from '../../entities/employee.entity';

const tenantId = 'tenant-uuid-001';
const employeeId = '0b7e5c1a-6f2d-4b8e-9a31-2c4d5e6f7a80';

describe('GetEmployeeHandler', () => {
  let handler: GetEmployeeHandler;
  let findOne: jest.Mock;
  let exists: jest.Mock;
  const farmScope = moduleScopeOf([OWNER_MODULE.FARM]) ?? undefined;

  beforeEach(async () => {
    findOne = jest.fn().mockResolvedValue(new Employee());
    exists = jest.fn().mockResolvedValue(true);
    const employeeRepository: Partial<Repository<Employee>> = { findOne, exists };

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
    await handler.execute(new GetEmployeeQuery(tenantId, employeeId, ALL_MODULES_SCOPE));

    expect(findOne).toHaveBeenCalledWith({
      where: { id: employeeId, tenantId, isDeleted: false },
    });
    // Every module: no second read.
    expect(exists).not.toHaveBeenCalled();
  });

  it('returns an employee inside a module scope', async () => {
    await expect(
      handler.execute(new GetEmployeeQuery(tenantId, employeeId, farmScope)),
    ).resolves.toBeInstanceOf(Employee);

    expect(exists).toHaveBeenCalledWith({
      where: {
        id: employeeId,
        tenantId,
        isDeleted: false,
        departmentHr: { moduleCode: In([OWNER_MODULE.FARM]), isDeleted: false },
      },
    });
  });

  it('refuses a tenant employee outside the scope (a farm member reading a sensor employee)', async () => {
    exists.mockResolvedValue(false);

    await expect(
      handler.execute(new GetEmployeeQuery(tenantId, employeeId, farmScope)),
    ).rejects.toThrow(ForbiddenException);
  });

  it('refuses every read when no scope was decided (fail closed)', async () => {
    await expect(handler.execute(new GetEmployeeQuery(tenantId, employeeId))).rejects.toThrow(
      ForbiddenException,
    );
    expect(findOne).not.toHaveBeenCalled();
  });

  it('throws NotFoundException when there is no such employee in the tenant', async () => {
    findOne.mockResolvedValue(null);

    await expect(
      handler.execute(new GetEmployeeQuery(tenantId, employeeId, ALL_MODULES_SCOPE)),
    ).rejects.toThrow(NotFoundException);
  });
});
