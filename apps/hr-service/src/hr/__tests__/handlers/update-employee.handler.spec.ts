/**
 * UpdateEmployeeHandler — department placement.
 *
 * An employee's department (`departmentHrId`) is the only way they belong to a
 * module, so moving them is validated by the one department rule
 * (`assertAssignableDepartment`) and nothing else:
 *   - a CHANGE to a department asks the rule;
 *   - the same department, or no department in the input, asks nothing;
 *   - an explicit null takes the employee out of any department.
 */
import { ConflictException, NotFoundException } from '@nestjs/common';
import { OutboxPublisher } from '@platform/outbox';
import { DataSource, EntityManager, QueryRunner } from 'typeorm';

import { UpdateEmployeeCommand } from '../../commands/update-employee.command';
import { UpdateEmployeeHandler } from '../../handlers/update-employee.handler';
import { DepartmentHR } from '../../entities/department.entity';
import { Employee, EmployeeStatus, EmploymentType } from '../../entities/employee.entity';

const tenantId = 'tenant-uuid-001';
const userId = 'admin-user-001';
const employeeId = '0b7e5c1a-6f2d-4b8e-9a31-2c4d5e6f7a80';
const currentDepartmentId = '9a1b2c3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d';
const newDepartmentId = '3f1c2b8e-9d4a-4c61-8f0e-5a7b2d9c1e44';

const buildEmployee = (overrides: Partial<Employee> = {}): Employee => {
  const employee = new Employee();
  Object.assign(employee, {
    id: employeeId,
    tenantId,
    employeeNumber: 'EMP-2026-00001',
    firstName: 'Ali',
    lastName: 'Yilmaz',
    email: 'ali@example.com',
    position: 'Fish Farm Operator',
    employmentType: EmploymentType.FULL_TIME,
    status: EmployeeStatus.ACTIVE,
    departmentHrId: currentDepartmentId,
    ...overrides,
  });
  return employee;
};

const buildMocks = (options: { current: Employee; departmentResult?: DepartmentHR | null }) => {
  const employeeRepo = {
    findOne: jest.fn().mockResolvedValue(options.current),
    // The tenant-scoped save builds a fresh entity from the one it is given.
    create: jest
      .fn()
      .mockImplementation((data: Partial<Employee>) => Object.assign(new Employee(), data)),
    save: jest.fn().mockImplementation((employee: Employee) => Promise.resolve(employee)),
  };
  // The department rule reads DepartmentHR through its own repository.
  const departmentRepo = {
    findOne: jest.fn().mockResolvedValue(options.departmentResult ?? null),
  };
  const getRepository = jest
    .fn()
    .mockImplementation((entity: unknown) =>
      entity === DepartmentHR ? departmentRepo : employeeRepo,
    );

  const manager: Partial<EntityManager> = { getRepository };
  const queryRunner: Partial<QueryRunner> = {
    connect: jest.fn().mockResolvedValue(undefined),
    startTransaction: jest.fn().mockResolvedValue(undefined),
    commitTransaction: jest.fn().mockResolvedValue(undefined),
    rollbackTransaction: jest.fn().mockResolvedValue(undefined),
    release: jest.fn().mockResolvedValue(undefined),
    manager: manager as EntityManager,
  };
  const dataSource: Partial<DataSource> = {
    createQueryRunner: jest.fn().mockReturnValue(queryRunner),
  };
  const outbox: Partial<OutboxPublisher> = { enqueue: jest.fn().mockResolvedValue(undefined) };

  const handler = new UpdateEmployeeHandler(dataSource as DataSource, outbox as OutboxPublisher);
  return { handler, employeeRepo, departmentRepo, getRepository, queryRunner, outbox };
};

describe('UpdateEmployeeHandler department placement', () => {
  it('moves the employee into a live department and stores it', async () => {
    const { handler, employeeRepo, departmentRepo, queryRunner } = buildMocks({
      current: buildEmployee(),
      departmentResult: new DepartmentHR(),
    });

    const result = await handler.execute(
      new UpdateEmployeeCommand(
        tenantId,
        { id: employeeId, departmentHrId: newDepartmentId },
        userId,
      ),
    );

    expect(departmentRepo.findOne).toHaveBeenCalledWith({
      where: { id: newDepartmentId, isDeleted: false, isActive: true, tenantId },
      lock: { mode: 'pessimistic_read' },
    });
    expect(employeeRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({ departmentHrId: newDepartmentId }),
    );
    expect(result.departmentHrId).toBe(newDepartmentId);
    expect(queryRunner.commitTransaction).toHaveBeenCalled();
  });

  it('rejects a department that is not live in the tenant and changes nothing', async () => {
    const { handler, employeeRepo, queryRunner, outbox } = buildMocks({
      current: buildEmployee(),
      departmentResult: null,
    });

    await expect(
      handler.execute(
        new UpdateEmployeeCommand(
          tenantId,
          { id: employeeId, departmentHrId: newDepartmentId },
          userId,
        ),
      ),
    ).rejects.toThrow(ConflictException);

    expect(queryRunner.rollbackTransaction).toHaveBeenCalled();
    expect(queryRunner.commitTransaction).not.toHaveBeenCalled();
    expect(employeeRepo.save).not.toHaveBeenCalled();
    expect(outbox.enqueue).not.toHaveBeenCalled();
  });

  it('does not re-validate the department the employee is already in', async () => {
    // The department may have been switched off since the employee was placed;
    // saving an unrelated edit must not start failing because of it.
    const { handler, getRepository, employeeRepo } = buildMocks({
      current: buildEmployee(),
      departmentResult: null,
    });

    await handler.execute(
      new UpdateEmployeeCommand(
        tenantId,
        { id: employeeId, departmentHrId: currentDepartmentId, position: 'Senior Operator' },
        userId,
      ),
    );

    expect(getRepository).not.toHaveBeenCalledWith(DepartmentHR);
    expect(employeeRepo.save).toHaveBeenCalled();
  });

  it('leaves the department alone when the input does not mention it', async () => {
    const { handler, getRepository, employeeRepo } = buildMocks({ current: buildEmployee() });

    await handler.execute(
      new UpdateEmployeeCommand(tenantId, { id: employeeId, position: 'Senior Operator' }, userId),
    );

    expect(getRepository).not.toHaveBeenCalledWith(DepartmentHR);
    expect(employeeRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({ departmentHrId: currentDepartmentId, position: 'Senior Operator' }),
    );
  });

  it('takes the employee out of any department on an explicit null, without a lookup', async () => {
    const { handler, getRepository, employeeRepo } = buildMocks({ current: buildEmployee() });

    const result = await handler.execute(
      new UpdateEmployeeCommand(tenantId, { id: employeeId, departmentHrId: null }, userId),
    );

    expect(getRepository).not.toHaveBeenCalledWith(DepartmentHR);
    expect(employeeRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({ departmentHrId: null }),
    );
    expect(result.departmentHrId).toBeNull();
  });

  it('never edits a soft-deleted (erased) employee', async () => {
    const { handler, employeeRepo, queryRunner } = buildMocks({ current: buildEmployee() });
    employeeRepo.findOne.mockResolvedValue(null);

    await expect(
      handler.execute(
        new UpdateEmployeeCommand(
          tenantId,
          { id: employeeId, position: 'Senior Operator' },
          userId,
        ),
      ),
    ).rejects.toThrow(NotFoundException);

    expect(employeeRepo.findOne).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: employeeId, tenantId, isDeleted: false } }),
    );
    expect(employeeRepo.save).not.toHaveBeenCalled();
    expect(queryRunner.rollbackTransaction).toHaveBeenCalled();
  });

  it('places an employee who had no department', async () => {
    const { handler, departmentRepo } = buildMocks({
      current: buildEmployee({ departmentHrId: null }),
      departmentResult: new DepartmentHR(),
    });

    const result = await handler.execute(
      new UpdateEmployeeCommand(
        tenantId,
        { id: employeeId, departmentHrId: newDepartmentId },
        userId,
      ),
    );

    expect(departmentRepo.findOne).toHaveBeenCalledTimes(1);
    expect(result.departmentHrId).toBe(newDepartmentId);
  });
});
