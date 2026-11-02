/**
 * GetEmployeesHandler — filter translation.
 *
 * A module's Team list shows the employees whose department belongs to that
 * module. The module is never stored on the employee: it is read through the
 * department, so an employee cannot disagree with their department. Which modules
 * a caller may list is the workforce scope the resolver decided on the server and
 * narrowed by `filter.moduleCode` (common/workforce-scope.ts, HR-HIGH-066); the
 * handler applies that scope and nothing the client sent.
 */
import { ALL_MODULES_SCOPE, OWNER_MODULE, moduleScopeOf } from '@aquaculture/shared-contracts';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';

import { GetEmployeesHandler } from '../../query-handlers/get-employees.handler';
import { GetEmployeesQuery } from '../../queries/get-employees.query';
import { Employee } from '../../entities/employee.entity';

const tenantId = 'tenant-uuid-001';

describe('GetEmployeesHandler', () => {
  let handler: GetEmployeesHandler;
  let employeeRepository: jest.Mocked<Pick<Repository<Employee>, 'findAndCount'>>;

  beforeEach(async () => {
    employeeRepository = {
      findAndCount: jest.fn().mockResolvedValue([[], 0]),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        GetEmployeesHandler,
        { provide: getRepositoryToken(Employee), useValue: employeeRepository },
      ],
    }).compile();

    handler = module.get(GetEmployeesHandler);
  });

  afterEach(() => jest.clearAllMocks());

  it('scopes to the tenant and hides soft-deleted employees by default', async () => {
    await handler.execute(new GetEmployeesQuery(tenantId, undefined, undefined, ALL_MODULES_SCOPE));

    expect(employeeRepository.findAndCount).toHaveBeenCalledWith(
      expect.objectContaining({ where: { tenantId, isDeleted: false } }),
    );
  });

  it('lists only the employees placed in the requested department', async () => {
    const departmentHrId = '3f1c2b8e-9d4a-4c61-8f0e-5a7b2d9c1e44';

    await handler.execute(
      new GetEmployeesQuery(tenantId, { departmentHrId }, undefined, ALL_MODULES_SCOPE),
    );

    expect(employeeRepository.findAndCount).toHaveBeenCalledWith(
      expect.objectContaining({ where: { tenantId, isDeleted: false, departmentHrId } }),
    );
  });

  it('lists only employees whose live department belongs to a module of the scope', async () => {
    await handler.execute(
      new GetEmployeesQuery(
        tenantId,
        { moduleCode: OWNER_MODULE.HYDROPONICS },
        undefined,
        moduleScopeOf([OWNER_MODULE.HYDROPONICS]) ?? undefined,
      ),
    );

    expect(employeeRepository.findAndCount).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          tenantId,
          isDeleted: false,
          departmentHr: { moduleCode: In([OWNER_MODULE.HYDROPONICS]), isDeleted: false },
        },
      }),
    );
  });

  it('applies the server scope, not the client moduleCode: a farm+sensor scope lists both', async () => {
    await handler.execute(
      new GetEmployeesQuery(
        tenantId,
        undefined,
        undefined,
        moduleScopeOf([OWNER_MODULE.FARM, OWNER_MODULE.SENSOR]) ?? undefined,
      ),
    );

    expect(employeeRepository.findAndCount).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          tenantId,
          isDeleted: false,
          departmentHr: {
            moduleCode: In([OWNER_MODULE.FARM, OWNER_MODULE.SENSOR]),
            isDeleted: false,
          },
        },
      }),
    );
  });

  it('lists no one, without a query, when no scope was decided (fail closed)', async () => {
    const result = await handler.execute(
      new GetEmployeesQuery(tenantId, { moduleCode: OWNER_MODULE.FARM }),
    );

    expect(employeeRepository.findAndCount).not.toHaveBeenCalled();
    expect(result.data).toEqual([]);
  });

  it('does not join the department for selection: EmployeeFieldsResolver resolves it', async () => {
    await handler.execute(new GetEmployeesQuery(tenantId, undefined, undefined, ALL_MODULES_SCOPE));

    expect(employeeRepository.findAndCount).toHaveBeenCalledWith(
      expect.not.objectContaining({ relations: expect.anything() }),
    );
  });

  it('keeps the scope alongside the other filters', async () => {
    await handler.execute(
      new GetEmployeesQuery(
        tenantId,
        { moduleCode: OWNER_MODULE.SENSOR, seaWorthy: false },
        undefined,
        moduleScopeOf([OWNER_MODULE.SENSOR]) ?? undefined,
      ),
    );

    expect(employeeRepository.findAndCount).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          tenantId,
          isDeleted: false,
          seaWorthy: false,
          departmentHr: { moduleCode: In([OWNER_MODULE.SENSOR]), isDeleted: false },
        },
      }),
    );
  });
});
