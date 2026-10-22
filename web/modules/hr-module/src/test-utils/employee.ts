/**
 * The one employee the specs start from: active, full-time, placed in the Deck
 * department of the Production module. A spec states only what it varies.
 */
import type { Employee } from '../types';
import { EmployeeStatus, EmploymentType } from '../types';

export const DECK_DEPARTMENT_ID = '11111111-1111-4111-8111-111111111111';

export function buildEmployee(overrides: Partial<Employee> = {}): Employee {
  return {
    id: 'emp-1',
    tenantId: 'tenant-1',
    employeeNumber: 'E-001',
    firstName: 'Ada',
    lastName: 'Lovelace',
    email: 'ada@example.com',
    status: EmployeeStatus.ACTIVE,
    employmentType: EmploymentType.FULL_TIME,
    hireDate: '2026-01-05',
    seaWorthy: false,
    departmentHrId: DECK_DEPARTMENT_ID,
    departmentHr: { id: DECK_DEPARTMENT_ID, name: 'Deck', code: 'DECK', moduleCode: 'FARM' },
    isDeleted: false,
    createdAt: '2026-01-05T00:00:00Z',
    updatedAt: '2026-01-05T00:00:00Z',
    ...overrides,
  };
}
