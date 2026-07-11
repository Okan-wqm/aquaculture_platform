/**
 * HRResolver — employee contact-PII object-level authz (DB-PEOPLE-MEDIUM-001).
 *
 * The employee read queries are gated to the broad MODULE_USER role. Before this
 * fix, any MODULE_USER could read every colleague's home address, personal
 * phone, and emergency contacts. These tests pin that full contact PII reaches
 * only workforce managers (TENANT_ADMIN/MODULE_MANAGER) or the subject
 * themselves; everyone else gets a redacted directory projection.
 */
import { HRResolver } from '../hr.resolver';
import { Role } from '@aquaculture/backend-common/decorators';
import type { CurrentUserPayload } from '@aquaculture/backend-common/decorators';
import { Employee } from '../entities/employee.entity';

const context = { req: { user: { sub: 'viewer-user', tenantId: 't1' } } } as never;

function makeEmployee(over: Partial<Employee> = {}): Employee {
  return {
    id: 'emp-1',
    tenantId: 't1',
    userId: 'other-user',
    firstName: 'Ada',
    lastName: 'Lovelace',
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
  } as Employee;
}

function makeViewer(roles: string[], sub = 'viewer-user'): CurrentUserPayload {
  return { sub, email: 'v@farm.test', tenantId: 't1', roles } as CurrentUserPayload;
}

function makeResolver(employee: Employee) {
  const queryBus = { execute: jest.fn().mockResolvedValue(employee) };
  const commandBus = { execute: jest.fn() };
  return new HRResolver(commandBus as never, queryBus as never);
}

describe('HRResolver employee contact-PII masking', () => {
  it('TENANT_ADMIN sees full contact PII', async () => {
    const emp = makeEmployee();
    const resolver = makeResolver(emp);
    const result = await resolver.getEmployee('emp-1', context, makeViewer([Role.TENANT_ADMIN]));
    expect(result.contactInfo.phone).toBe('+1-555-0100');
    expect(result.address.street).toBe('12 Analytical Ave');
  });

  it('MODULE_MANAGER sees full contact PII', async () => {
    const emp = makeEmployee();
    const resolver = makeResolver(emp);
    const result = await resolver.getEmployee('emp-1', context, makeViewer([Role.MODULE_MANAGER]));
    expect(result.contactInfo.phone).toBe('+1-555-0100');
    expect(result.address.city).toBe('London');
  });

  it('MODULE_USER viewing their OWN record sees full contact PII', async () => {
    const emp = makeEmployee({ userId: 'viewer-user' });
    const resolver = makeResolver(emp);
    const result = await resolver.getEmployee('emp-1', context, makeViewer([Role.MODULE_USER]));
    expect(result.contactInfo.phone).toBe('+1-555-0100');
    expect(result.address.street).toBe('12 Analytical Ave');
  });

  it('MODULE_USER viewing ANOTHER employee gets a redacted directory projection', async () => {
    const emp = makeEmployee({ userId: 'other-user' });
    const resolver = makeResolver(emp);
    const result = await resolver.getEmployee('emp-1', context, makeViewer([Role.MODULE_USER]));
    // Work email stays (already public via the top-level email field)...
    expect(result.contactInfo.email).toBe('ada@farm.test');
    // ...but personal + emergency phone and the full home address are redacted.
    expect(result.contactInfo.phone).toBe('REDACTED');
    expect(result.contactInfo.emergencyContact).toBeUndefined();
    expect(result.contactInfo.emergencyPhone).toBeUndefined();
    expect(result.address.street).toBe('REDACTED');
    expect(result.address.postalCode).toBe('REDACTED');
    expect(result.address.city).toBe('REDACTED');
  });

  it('masks every item of a list for an unauthorized MODULE_USER', async () => {
    const employees = [
      makeEmployee({ id: 'e1', userId: 'a' }),
      makeEmployee({ id: 'e2', userId: 'b' }),
    ];
    const queryBus = { execute: jest.fn().mockResolvedValue({ data: employees }) };
    const resolver = new HRResolver({ execute: jest.fn() } as never, queryBus as never);

    const result = await resolver.getActiveEmployees(20, 1, context, makeViewer([Role.MODULE_USER]));

    expect(result).toHaveLength(2);
    for (const e of result) {
      expect(e.contactInfo.phone).toBe('REDACTED');
      expect(e.address.street).toBe('REDACTED');
    }
  });
});
