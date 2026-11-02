/**
 * Employee contact-PII object-level authz (DB-PEOPLE-MEDIUM-001, HR-HIGH-056, HR-HIGH-067).
 *
 * The employee reads are open to the broad workforce role. These tests pin that full contact
 * details reach only a tenant administrator, the employee themselves, the hr manager (an hr
 * MODULE_MANAGER grant) and a manager of the employee's own module by grant; that the tenant-wide
 * MODULE_MANAGER role alone reaches nothing (HR-HIGH-067: a sensor manager read every farm and HR
 * employee's home address); and that the rule lives on the `Employee` type, so it holds for every
 * operation that returns an employee — the weekly plan or the leave request that nests one
 * included.
 */
import { Role } from '@aquaculture/backend-common/decorators';
import type { CurrentUserPayload } from '@aquaculture/backend-common/decorators';
import {
  OWNER_MODULE,
  type ModuleAccess,
  type OwnerModuleCode,
} from '@aquaculture/shared-contracts';
import { collaborator } from '@aquaculture/testing';
import { GraphQLSchemaBuilderModule, GraphQLSchemaFactory } from '@nestjs/graphql';
import { Test } from '@nestjs/testing';
import { GraphQLObjectType } from 'graphql';

import type { EmployeeDepartmentDataLoader } from '../dataloaders/employee-department.dataloader';
import { DepartmentHR } from '../entities/department.entity';
import { Employee } from '../entities/employee.entity';
import { EmployeeFieldsResolver } from '../employee-fields.resolver';
import { HRResolver } from '../hr.resolver';

const FARM_DEPARTMENT = 'dept-farm';
const SENSOR_DEPARTMENT = 'dept-sensor';
const COMPANY_DEPARTMENT = 'dept-company';
const DELETED_FARM_DEPARTMENT = 'dept-farm-deleted';

function department(id: string, moduleCode: OwnerModuleCode | undefined, isDeleted = false) {
  return Object.assign(new DepartmentHR(), { id, moduleCode, isDeleted });
}

const DEPARTMENTS = new Map<string, DepartmentHR>([
  [FARM_DEPARTMENT, department(FARM_DEPARTMENT, OWNER_MODULE.FARM)],
  [SENSOR_DEPARTMENT, department(SENSOR_DEPARTMENT, OWNER_MODULE.SENSOR)],
  [COMPANY_DEPARTMENT, department(COMPANY_DEPARTMENT, undefined)],
  [DELETED_FARM_DEPARTMENT, department(DELETED_FARM_DEPARTMENT, OWNER_MODULE.FARM, true)],
]);

function makeEmployee(over: Partial<Employee> = {}): Employee {
  return Object.assign(new Employee(), {
    id: 'emp-1',
    tenantId: 't1',
    userId: 'other-user',
    email: 'ada@farm.test',
    departmentHrId: FARM_DEPARTMENT,
    contactInfo: {
      email: 'ada@farm.test',
      phone: '+1-555-0100',
      emergencyContact: 'Charles',
      emergencyPhone: '+1-555-0199',
    },
    address: {
      street: '12 Analytical Ave',
      city: 'London',
      state: 'LDN',
      postalCode: 'EC1',
      country: 'UK',
    },
    ...over,
  });
}

function makeViewer(
  roles: string[],
  moduleAccess?: ModuleAccess,
  sub = 'viewer-user',
): CurrentUserPayload {
  return {
    sub,
    email: 'v@farm.test',
    tenantId: 't1',
    roles,
    ...(moduleAccess === undefined ? {} : { moduleAccess }),
  };
}

const load = jest.fn(async (id: string) => DEPARTMENTS.get(id) ?? null);
const resolver = new EmployeeFieldsResolver(
  collaborator<EmployeeDepartmentDataLoader>({ load }, 'EmployeeDepartmentDataLoader'),
);

async function seesFull(employee: Employee, viewer: CurrentUserPayload): Promise<boolean> {
  const phone = (await resolver.contactInfo(employee, viewer)).phone;
  const street = (await resolver.address(employee, viewer)).street;
  // The two fields decide by the same rule; a split answer is a bug in itself.
  expect(phone === 'REDACTED').toBe(street === 'REDACTED');
  return phone !== 'REDACTED';
}

describe('Employee contact fields: who sees them in full', () => {
  it.each([
    ['TENANT_ADMIN', makeViewer([Role.TENANT_ADMIN])],
    ['SUPER_ADMIN', makeViewer([Role.SUPER_ADMIN])],
    [
      'the hr manager (hr MODULE_MANAGER grant)',
      makeViewer([Role.MODULE_USER], { hr: 'MODULE_MANAGER' }),
    ],
    [
      'the farm manager, for a farm employee (farm MODULE_MANAGER grant)',
      makeViewer([Role.MODULE_MANAGER], { farm: 'MODULE_MANAGER' }),
    ],
  ])('%s', async (_who, viewer) => {
    expect(await seesFull(makeEmployee(), viewer)).toBe(true);
  });

  it('the employee, for their OWN record', async () => {
    const employee = makeEmployee({ userId: 'viewer-user', departmentHrId: SENSOR_DEPARTMENT });
    expect(await seesFull(employee, makeViewer([Role.MODULE_USER]))).toBe(true);
  });
});

describe('Employee contact fields: the global role reaches nothing (HR-HIGH-067)', () => {
  it.each([
    [
      'a farm manager, for a sensor employee',
      makeViewer([Role.MODULE_MANAGER], { farm: 'MODULE_MANAGER' }),
      SENSOR_DEPARTMENT,
    ],
    [
      'a sensor manager, for a farm employee',
      makeViewer([Role.MODULE_MANAGER], { sensor: 'MODULE_MANAGER' }),
      FARM_DEPARTMENT,
    ],
    [
      'a global MODULE_MANAGER with no grant',
      makeViewer([Role.MODULE_MANAGER], {}),
      FARM_DEPARTMENT,
    ],
    [
      'a global MODULE_MANAGER on a token minted before the moduleAccess claim',
      makeViewer([Role.MODULE_MANAGER]),
      FARM_DEPARTMENT,
    ],
    [
      'a farm MODULE_USER, for a farm colleague',
      makeViewer([Role.MODULE_USER], { farm: 'MODULE_USER' }),
      FARM_DEPARTMENT,
    ],
    [
      'an hr MODULE_USER (not the hr manager)',
      makeViewer([Role.MODULE_USER], { hr: 'MODULE_USER' }),
      FARM_DEPARTMENT,
    ],
    [
      'a farm manager, for an employee in a company-wide department',
      makeViewer([Role.MODULE_MANAGER], { farm: 'MODULE_MANAGER' }),
      COMPANY_DEPARTMENT,
    ],
    [
      'a farm manager, for an employee whose farm department was deleted',
      makeViewer([Role.MODULE_MANAGER], { farm: 'MODULE_MANAGER' }),
      DELETED_FARM_DEPARTMENT,
    ],
    [
      'a viewer with a malformed moduleAccess claim',
      { ...makeViewer([Role.MODULE_MANAGER]), moduleAccess: 'farm' as unknown as ModuleAccess },
      FARM_DEPARTMENT,
    ],
  ])('%s sees the directory projection', async (_who, viewer, departmentHrId) => {
    expect(await seesFull(makeEmployee({ departmentHrId }), viewer)).toBe(false);
  });

  it('an employee placed in no department belongs to no module manager', async () => {
    const employee = makeEmployee({ departmentHrId: null });
    const farmManager = makeViewer([Role.MODULE_MANAGER], { farm: 'MODULE_MANAGER' });
    expect(await seesFull(employee, farmManager)).toBe(false);
    expect(await seesFull(employee, makeViewer([Role.MODULE_USER], { hr: 'MODULE_MANAGER' }))).toBe(
      true,
    );
  });
});

describe('Employee contact fields: the projection', () => {
  it('keeps the work email and drops the phones and the address', async () => {
    const employee = makeEmployee({ userId: 'other-user' });
    const viewer = makeViewer([Role.MODULE_USER], { farm: 'MODULE_USER' });

    const contact = await resolver.contactInfo(employee, viewer);
    // The work email stays (it is already public as Employee.email); the phones and the address go.
    expect(contact.email).toBe('ada@farm.test');
    expect(contact.phone).toBe('REDACTED');
    expect(contact.emergencyContact).toBeUndefined();
    expect(contact.emergencyPhone).toBeUndefined();
    expect(await resolver.address(employee, viewer)).toEqual({
      street: 'REDACTED',
      city: 'REDACTED',
      state: 'REDACTED',
      postalCode: 'REDACTED',
      country: 'REDACTED',
    });
  });

  it('redacting does not touch the stored employee', async () => {
    const employee = makeEmployee();

    await resolver.contactInfo(employee, makeViewer([Role.MODULE_USER]));
    await resolver.address(employee, makeViewer([Role.MODULE_USER]));

    expect(employee.contactInfo.phone).toBe('+1-555-0100');
    expect(employee.address.street).toBe('12 Analytical Ave');
  });

  it('a viewer with no platform role is treated as a colleague, not a manager', async () => {
    expect(await seesFull(makeEmployee(), makeViewer(['AUDITOR']))).toBe(false);
  });

  it('the account role is read the way RolesGuard reads it: any case, and the legacy single role', async () => {
    expect(await seesFull(makeEmployee(), makeViewer(['tenant_admin']))).toBe(true);
    const legacy: CurrentUserPayload = { ...makeViewer([]), role: Role.TENANT_ADMIN };
    expect(await seesFull(makeEmployee(), legacy)).toBe(true);
  });

  it('reads the module through the batched department loader', async () => {
    load.mockClear();
    await resolver.contactInfo(makeEmployee(), makeViewer([Role.MODULE_USER], {}));
    expect(load).toHaveBeenCalledWith(FARM_DEPARTMENT);
  });
});

describe('Employee contact fields in the schema', () => {
  it('the redacting field resolvers leave contactInfo and address non-null, as the type declares them', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [GraphQLSchemaBuilderModule],
    }).compile();
    const schema = await moduleRef
      .get(GraphQLSchemaFactory)
      .create([HRResolver, EmployeeFieldsResolver]);

    const employee = schema.getType('Employee');
    expect(employee).toBeInstanceOf(GraphQLObjectType);
    const fields = employee instanceof GraphQLObjectType ? employee.getFields() : {};
    expect(String(fields['contactInfo']?.type)).toBe('ContactInfo!');
    expect(String(fields['address']?.type)).toBe('Address!');
  });
});
