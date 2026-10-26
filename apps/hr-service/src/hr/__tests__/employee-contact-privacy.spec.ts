/**
 * Employee contact-PII object-level authz (DB-PEOPLE-MEDIUM-001, HR-HIGH-056).
 *
 * The employee reads are open to the broad workforce role. These tests pin that full contact
 * details reach only workforce managers (TENANT_ADMIN/MODULE_MANAGER) or the employee themselves,
 * and that the rule lives on the `Employee` type, so it holds for every operation that returns an
 * employee — the weekly plan or the leave request that nests one included.
 */
import { Role } from '@aquaculture/backend-common/decorators';
import type { CurrentUserPayload } from '@aquaculture/backend-common/decorators';
import { collaborator } from '@aquaculture/testing';
import { GraphQLSchemaBuilderModule, GraphQLSchemaFactory } from '@nestjs/graphql';
import { Test } from '@nestjs/testing';
import { GraphQLObjectType } from 'graphql';

import type { EmployeeDepartmentDataLoader } from '../dataloaders/employee-department.dataloader';
import { Employee } from '../entities/employee.entity';
import { EmployeeFieldsResolver } from '../employee-fields.resolver';
import { HRResolver } from '../hr.resolver';

function makeEmployee(over: Partial<Employee> = {}): Employee {
  return Object.assign(new Employee(), {
    id: 'emp-1',
    tenantId: 't1',
    userId: 'other-user',
    email: 'ada@farm.test',
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

function makeViewer(roles: string[], sub = 'viewer-user'): CurrentUserPayload {
  return { sub, email: 'v@farm.test', tenantId: 't1', roles };
}

const resolver = new EmployeeFieldsResolver(
  collaborator<EmployeeDepartmentDataLoader>({ load: jest.fn() }, 'EmployeeDepartmentDataLoader'),
);

describe('Employee contact fields', () => {
  it.each([Role.TENANT_ADMIN, Role.MODULE_MANAGER, Role.SUPER_ADMIN])(
    '%s sees full contact details',
    (role) => {
      const employee = makeEmployee();
      const viewer = makeViewer([role]);

      expect(resolver.contactInfo(employee, viewer).phone).toBe('+1-555-0100');
      expect(resolver.address(employee, viewer).street).toBe('12 Analytical Ave');
    },
  );

  it('a MODULE_USER sees full contact details of their OWN record', () => {
    const employee = makeEmployee({ userId: 'viewer-user' });
    const viewer = makeViewer([Role.MODULE_USER]);

    expect(resolver.contactInfo(employee, viewer).phone).toBe('+1-555-0100');
    expect(resolver.address(employee, viewer).street).toBe('12 Analytical Ave');
  });

  it('a MODULE_USER sees a redacted directory projection of ANOTHER employee', () => {
    const employee = makeEmployee({ userId: 'other-user' });
    const viewer = makeViewer([Role.MODULE_USER]);

    const contact = resolver.contactInfo(employee, viewer);
    // The work email stays (it is already public as Employee.email); the phones and the address go.
    expect(contact.email).toBe('ada@farm.test');
    expect(contact.phone).toBe('REDACTED');
    expect(contact.emergencyContact).toBeUndefined();
    expect(contact.emergencyPhone).toBeUndefined();
    expect(resolver.address(employee, viewer)).toEqual({
      street: 'REDACTED',
      city: 'REDACTED',
      state: 'REDACTED',
      postalCode: 'REDACTED',
      country: 'REDACTED',
    });
  });

  it('redacting does not touch the stored employee', () => {
    const employee = makeEmployee();

    resolver.contactInfo(employee, makeViewer([Role.MODULE_USER]));
    resolver.address(employee, makeViewer([Role.MODULE_USER]));

    expect(employee.contactInfo.phone).toBe('+1-555-0100');
    expect(employee.address.street).toBe('12 Analytical Ave');
  });

  it('a viewer with no platform role is treated as a colleague, not a manager', () => {
    const employee = makeEmployee({ userId: 'other-user' });

    expect(resolver.contactInfo(employee, makeViewer(['AUDITOR'])).phone).toBe('REDACTED');
  });

  it('role claims are read the way RolesGuard reads them: any case, and the legacy single role', () => {
    const employee = makeEmployee({ userId: 'other-user' });

    expect(resolver.contactInfo(employee, makeViewer(['module_manager'])).phone).toBe(
      '+1-555-0100',
    );
    const legacy: CurrentUserPayload = { ...makeViewer([]), role: Role.TENANT_ADMIN };
    expect(resolver.contactInfo(employee, legacy).phone).toBe('+1-555-0100');
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
