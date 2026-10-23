/**
 * Field resolvers of the HR object types: they derive a value from the parent
 * object's keys through request-scoped loaders, so a list of N rows costs one
 * query per field instead of N.
 */
import { collaborator } from '@aquaculture/testing';

import { DepartmentFieldsResolver } from '../department-fields.resolver';
import { EmployeeFieldsResolver } from '../employee-fields.resolver';
import type { DepartmentHeadCountDataLoader } from '../dataloaders/department-head-count.dataloader';
import type { DepartmentManagerNameDataLoader } from '../dataloaders/department-manager-name.dataloader';
import type { EmployeeDepartmentDataLoader } from '../dataloaders/employee-department.dataloader';
import { DepartmentHR } from '../entities/department.entity';
import { Employee } from '../entities/employee.entity';

describe('DepartmentFieldsResolver', () => {
  const buildResolver = () => {
    const headCounts = { load: jest.fn().mockResolvedValue(4) };
    const managerNames = { load: jest.fn().mockResolvedValue('Ada Kaya') };
    const resolver = new DepartmentFieldsResolver(
      collaborator<DepartmentHeadCountDataLoader>(headCounts, 'DepartmentHeadCountDataLoader'),
      collaborator<DepartmentManagerNameDataLoader>(
        managerNames,
        'DepartmentManagerNameDataLoader',
      ),
    );
    return { resolver, headCounts, managerNames };
  };

  it('headCount is the loaded head count of the department', async () => {
    const { resolver, headCounts } = buildResolver();

    const count = await resolver.headCount(Object.assign(new DepartmentHR(), { id: 'dep-a' }));

    expect(count).toBe(4);
    expect(headCounts.load).toHaveBeenCalledWith('dep-a');
  });

  it('managerName is the loaded name of the department manager', async () => {
    const { resolver, managerNames } = buildResolver();

    const name = await resolver.managerName(
      Object.assign(new DepartmentHR(), { managerId: 'emp-1' }),
    );

    expect(name).toBe('Ada Kaya');
    expect(managerNames.load).toHaveBeenCalledWith('emp-1');
  });

  it('managerName is null, without a query, when the department has no manager', async () => {
    const { resolver, managerNames } = buildResolver();

    expect(await resolver.managerName(new DepartmentHR())).toBeNull();
    expect(managerNames.load).not.toHaveBeenCalled();
  });
});

describe('EmployeeFieldsResolver', () => {
  const buildResolver = () => {
    const departments = {
      load: jest.fn().mockResolvedValue(Object.assign(new DepartmentHR(), { id: 'dep-a' })),
    };
    return {
      resolver: new EmployeeFieldsResolver(
        collaborator<EmployeeDepartmentDataLoader>(departments, 'EmployeeDepartmentDataLoader'),
      ),
      departments,
    };
  };

  it('departmentHr is the department the employee is placed in', async () => {
    const { resolver, departments } = buildResolver();

    const department = await resolver.departmentHr(
      Object.assign(new Employee(), { departmentHrId: 'dep-a' }),
    );

    expect(department?.id).toBe('dep-a');
    expect(departments.load).toHaveBeenCalledWith('dep-a');
  });

  it('departmentHr is null, without a query, for an employee placed in no department', async () => {
    const { resolver, departments } = buildResolver();

    expect(
      await resolver.departmentHr(Object.assign(new Employee(), { departmentHrId: null })),
    ).toBeNull();
    expect(departments.load).not.toHaveBeenCalled();
  });
});
