/**
 * GetEmployeesHandler — filter translation.
 *
 * A module's Team list shows the employees whose department belongs to that
 * module. The module is never stored on the employee: it is read through the
 * department, so an employee cannot disagree with their department.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { GetEmployeesHandler } from '../../query-handlers/get-employees.handler';
import { GetEmployeesQuery } from '../../queries/get-employees.query';
import { Employee } from '../../entities/employee.entity';
import { HrModuleCode } from '../../../common/enums';

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
    await handler.execute(new GetEmployeesQuery(tenantId));

    expect(employeeRepository.findAndCount).toHaveBeenCalledWith(
      expect.objectContaining({ where: { tenantId, isDeleted: false } }),
    );
  });

  it('lists only the employees placed in the requested department', async () => {
    const departmentHrId = '3f1c2b8e-9d4a-4c61-8f0e-5a7b2d9c1e44';

    await handler.execute(new GetEmployeesQuery(tenantId, { departmentHrId }));

    expect(employeeRepository.findAndCount).toHaveBeenCalledWith(
      expect.objectContaining({ where: { tenantId, isDeleted: false, departmentHrId } }),
    );
  });

  it('lists only employees whose live department belongs to the requested module', async () => {
    await handler.execute(
      new GetEmployeesQuery(tenantId, { moduleCode: HrModuleCode.HYDROPONICS }),
    );

    expect(employeeRepository.findAndCount).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          tenantId,
          isDeleted: false,
          departmentHr: { moduleCode: HrModuleCode.HYDROPONICS, isDeleted: false },
        },
      }),
    );
  });

  it('does not join the department for selection: EmployeeFieldsResolver resolves it', async () => {
    await handler.execute(new GetEmployeesQuery(tenantId));

    expect(employeeRepository.findAndCount).toHaveBeenCalledWith(
      expect.not.objectContaining({ relations: expect.anything() }),
    );
  });

  it('keeps the module filter alongside the other filters', async () => {
    await handler.execute(
      new GetEmployeesQuery(tenantId, { moduleCode: HrModuleCode.SENSOR, seaWorthy: false }),
    );

    expect(employeeRepository.findAndCount).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          tenantId,
          isDeleted: false,
          seaWorthy: false,
          departmentHr: { moduleCode: HrModuleCode.SENSOR, isDeleted: false },
        },
      }),
    );
  });
});
