/**
 * HRResolver — the employee mutations hand back the entity their command saved.
 *
 * The saved entity does not carry the department; it does not need to. A
 * mutation that selects `departmentHr` (the employee form's fragment does) is
 * answered by EmployeeFieldsResolver from `departmentHrId`, the same way every
 * other operation that returns an employee is (see department-fields.resolver.spec).
 */
import { CommandBus, QueryBus } from '@nestjs/cqrs';
import { collaborator } from '@aquaculture/testing';

import { HRResolver } from '../hr.resolver';
import { CreateEmployeeCommand } from '../commands/create-employee.command';
import { UpdateEmployeeCommand } from '../commands/update-employee.command';
import { Employee, EmployeeStatus } from '../entities/employee.entity';
import { CreateEmployeeInput } from '../dto/create-employee.input';
import { UpdateEmployeeInput } from '../dto/update-employee.input';

const tenantId = 't1';
const context = { req: { user: { sub: 'actor-user', tenantId } } };
const employeeId = '0b7e5c1a-6f2d-4b8e-9a31-2c4d5e6f7a80';

describe('HRResolver employee mutations', () => {
  let commandBus: { execute: jest.Mock };
  let queryBus: { execute: jest.Mock };
  let resolver: HRResolver;
  let saved: Employee;

  beforeEach(() => {
    saved = Object.assign(new Employee(), { id: employeeId, tenantId });
    commandBus = { execute: jest.fn().mockResolvedValue(saved) };
    queryBus = { execute: jest.fn() };
    resolver = new HRResolver(
      collaborator<CommandBus>(commandBus, 'CommandBus'),
      collaborator<QueryBus>(queryBus, 'QueryBus'),
    );
  });

  it('createEmployee returns the employee the command saved', async () => {
    const input = { email: 'ada@farm.test' } as CreateEmployeeInput;

    const result = await resolver.createEmployee(input, context);

    expect(commandBus.execute).toHaveBeenCalledWith(
      new CreateEmployeeCommand(tenantId, input, 'actor-user'),
    );
    expect(result).toBe(saved);
    expect(queryBus.execute).not.toHaveBeenCalled();
  });

  it('updateEmployee returns the employee the command saved', async () => {
    const input = { id: employeeId, departmentHrId: null } as UpdateEmployeeInput;

    const result = await resolver.updateEmployee(input, context);

    expect(commandBus.execute).toHaveBeenCalledWith(
      new UpdateEmployeeCommand(tenantId, input, 'actor-user'),
    );
    expect(result).toBe(saved);
    expect(queryBus.execute).not.toHaveBeenCalled();
  });

  it('terminateEmployee returns the employee the command saved', async () => {
    const result = await resolver.terminateEmployee(employeeId, '2026-10-01', context);

    expect(commandBus.execute).toHaveBeenCalledWith(
      new UpdateEmployeeCommand(
        tenantId,
        { id: employeeId, status: EmployeeStatus.TERMINATED, terminationDate: '2026-10-01' },
        'actor-user',
      ),
    );
    expect(result).toBe(saved);
    expect(queryBus.execute).not.toHaveBeenCalled();
  });
});
