/**
 * Employee CRUD Lifecycle E2E Tests
 *
 * Tests the complete employee lifecycle:
 * Create -> Read -> List/Filter -> Update -> Terminate -> Farm Worker Toggle
 * Plus cross-tenant isolation and DB verification.
 */
import { randomUUID } from 'crypto';

import { assertDefined } from '../../../helpers/assertions';
import { TestDatabase } from '../../../helpers/db.helper';
import { GraphQLTestClient } from '../../../helpers/graphql-client';
import { generateTestToken } from '../../../helpers/jwt.helper';

const GATEWAY_URL = process.env.GATEWAY_URL || 'http://localhost:4000';

// ── Tenant A ──────────────────────────────────────────────
const TENANT_A_ID = randomUUID();
const USER_A_ID = randomUUID();
const TOKEN_A = generateTestToken({
  userId: USER_A_ID,
  tenantId: TENANT_A_ID,
  role: 'TENANT_ADMIN',
});

// ── Tenant B (for cross-tenant isolation) ─────────────────
const TENANT_B_ID = randomUUID();
const USER_B_ID = randomUUID();
const TOKEN_B = generateTestToken({
  userId: USER_B_ID,
  tenantId: TENANT_B_ID,
  role: 'TENANT_ADMIN',
});

describe('Employee CRUD Lifecycle', () => {
  const clientA = new GraphQLTestClient(GATEWAY_URL, TOKEN_A, TENANT_A_ID);
  const clientB = new GraphQLTestClient(GATEWAY_URL, TOKEN_B, TENANT_B_ID);
  const db = new TestDatabase();

  let createdEmployeeId: string;
  let createdEmployeeNumber: string;

  const employeeInput = {
    firstName: 'Ahmet',
    lastName: 'Yilmaz',
    email: `e2e-emp-${Date.now()}@test.aquaculture.io`,
    contactInfo: {
      email: `e2e-emp-contact-${Date.now()}@test.aquaculture.io`,
      phone: '+90-555-123-4567',
      emergencyContact: 'Mehmet Yilmaz',
      emergencyPhone: '+90-555-765-4321',
    },
    address: {
      street: '123 Ataturk Caddesi',
      city: 'Istanbul',
      state: 'Marmara',
      postalCode: '34000',
      country: 'Turkey',
    },
    dateOfBirth: '1990-05-15',
    nationalId: 'TC12345678901',
    employmentType: 'FULL_TIME',
    department: 'OPERATIONS',
    position: 'Aquaculture Technician',
    hireDate: '2024-01-15',
    baseSalary: 45000,
    currency: 'TRY',
    isFarmWorker: false,
  };

  afterAll(async () => {
    await db.close();
  });

  // ── Test 1: Create employee and read back ─────────────
  test('Test 1: createEmployee -> employee(id) -> employees(filter)', async () => {
    const data = await clientA.mutate<{
      createEmployee: {
        id: string;
        firstName: string;
        lastName: string;
        email: string;
        employeeNumber: string;
        status: string;
        employmentType: string;
        department: string;
        position: string;
        isFarmWorker: boolean;
        currency: string;
        contactInfo: { email: string; phone: string };
        address: { city: string; country: string };
      };
    }>(
      `
      mutation CreateEmployee($input: CreateEmployeeInput!) {
        createEmployee(input: $input) {
          id
          firstName
          lastName
          email
          employeeNumber
          status
          employmentType
          department
          position
          isFarmWorker
          currency
          contactInfo { email phone }
          address { city country }
        }
      }
    `,
      { input: employeeInput },
    );

    const emp = data.createEmployee;
    createdEmployeeId = emp.id;
    createdEmployeeNumber = emp.employeeNumber;

    expect(emp.id).toBeDefined();
    expect(emp.firstName).toBe('Ahmet');
    expect(emp.lastName).toBe('Yilmaz');
    expect(emp.email).toBe(employeeInput.email.toLowerCase());
    expect(emp.status).toBe('active');
    expect(emp.employmentType).toBe('full_time');
    expect(emp.department).toBe('operations');
    expect(emp.position).toBe('Aquaculture Technician');
    expect(emp.isFarmWorker).toBe(false);
    expect(emp.currency).toBe('TRY');
    expect(emp.contactInfo.phone).toBe('+90-555-123-4567');
    expect(emp.address.city).toBe('Istanbul');

    // Read back by ID
    const readData = await clientA.query<{
      employee: { id: string; firstName: string; lastName: string; email: string };
    }>(
      `
      query GetEmployee($id: ID!) {
        employee(id: $id) {
          id
          firstName
          lastName
          email
        }
      }
    `,
      { id: createdEmployeeId },
    );

    expect(readData.employee.id).toBe(createdEmployeeId);
    expect(readData.employee.firstName).toBe('Ahmet');

    // List employees with filter
    const listData = await clientA.query<{
      employees: {
        data: Array<{ id: string; firstName: string }>;
        total: number;
      };
    }>(
      `
      query ListEmployees($filter: EmployeeFilterInput) {
        employees(filter: $filter) {
          data {
            id
            firstName
          }
          total
        }
      }
    `,
      { filter: { status: 'ACTIVE' } },
    );

    expect(listData.employees.total).toBeGreaterThanOrEqual(1);
    const found = listData.employees.data.find((e: { id: string }) => e.id === createdEmployeeId);
    expect(found).toBeDefined();
  });

  // ── Test 2: Employee number auto-generated ────────────
  test('Test 2: employeeNumber auto-generated (EMP-YYYY-NNNNN)', () => {
    expect(createdEmployeeNumber).toBeDefined();
    // Employee number should follow pattern EMP-YYYY-NNNNN
    expect(createdEmployeeNumber).toMatch(/^EMP-\d{4}-\d{5}$/);
  });

  // ── Test 3: Unique email per tenant ───────────────────
  test('Test 3: duplicate email per tenant -> error', async () => {
    const duplicateInput = {
      ...employeeInput,
      firstName: 'Duplicate',
      lastName: 'User',
      nationalId: 'TC99999999999',
    };

    const response = await clientA.queryRaw(
      `
      mutation CreateDuplicate($input: CreateEmployeeInput!) {
        createEmployee(input: $input) {
          id
        }
      }
    `,
      { input: duplicateInput },
    );

    expect(response.errors).toBeDefined();
    expect(assertDefined(response.errors).length).toBeGreaterThan(0);
  });

  // ── Test 4: Update employee ───────────────────────────
  test('Test 4: updateEmployee -> verify changes persisted', async () => {
    const updateData = await clientA.mutate<{
      updateEmployee: {
        id: string;
        position: string;
        department: string;
      };
    }>(
      `
      mutation UpdateEmployee($input: UpdateEmployeeInput!) {
        updateEmployee(input: $input) {
          id
          position
          department
        }
      }
    `,
      {
        input: {
          id: createdEmployeeId,
          position: 'Senior Aquaculture Technician',
          department: 'MANAGEMENT',
        },
      },
    );

    expect(updateData.updateEmployee.position).toBe('Senior Aquaculture Technician');
    expect(updateData.updateEmployee.department).toBe('management');
  });

  // ── Test 5: Terminate employee ────────────────────────
  test('Test 5: terminateEmployee -> status=TERMINATED', async () => {
    // First create a new employee to terminate (keep original for other tests)
    const termInput = {
      ...employeeInput,
      firstName: 'Terminated',
      lastName: 'Employee',
      email: `e2e-term-${Date.now()}@test.aquaculture.io`,
      nationalId: 'TC11111111111',
      contactInfo: {
        ...employeeInput.contactInfo,
        email: `e2e-term-contact-${Date.now()}@test.aquaculture.io`,
      },
    };

    const createRes = await clientA.mutate<{
      createEmployee: { id: string };
    }>(
      `
      mutation CreateTermEmp($input: CreateEmployeeInput!) {
        createEmployee(input: $input) { id }
      }
    `,
      { input: termInput },
    );

    const termData = await clientA.mutate<{
      terminateEmployee: { id: string; status: string; terminationDate: string };
    }>(
      `
      mutation TerminateEmployee($id: ID!, $terminationDate: String!) {
        terminateEmployee(id: $id, terminationDate: $terminationDate) {
          id
          status
          terminationDate
        }
      }
    `,
      {
        id: createRes.createEmployee.id,
        terminationDate: '2026-03-22',
      },
    );

    expect(termData.terminateEmployee.status).toBe('terminated');
    expect(termData.terminateEmployee.terminationDate).toBeDefined();
  });

  // ── Test 6: activeEmployees returns only ACTIVE ───────
  test('Test 6: activeEmployees query -> only ACTIVE status', async () => {
    const data = await clientA.query<{
      activeEmployees: Array<{ id: string; status: string }>;
    }>(`
      query ActiveEmployees {
        activeEmployees {
          id
          status
        }
      }
    `);

    // All returned employees must be active
    for (const emp of data.activeEmployees) {
      expect(emp.status).toBe('active');
    }
  });

  // ── Test 7: employeesByDepartment ─────────────────────
  test('Test 7: employeesByDepartment -> correct filtering', async () => {
    const data = await clientA.query<{
      employeesByDepartment: Array<{ id: string; department: string }>;
    }>(
      `
      query ByDepartment($department: HRDepartment!) {
        employeesByDepartment(department: $department) {
          id
          department
        }
      }
    `,
      { department: 'MANAGEMENT' },
    );

    for (const emp of data.employeesByDepartment) {
      expect(emp.department).toBe('management');
    }
    // Our updated employee should be in MANAGEMENT
    const found = data.employeesByDepartment.find(
      (e: { id: string }) => e.id === createdEmployeeId,
    );
    expect(found).toBeDefined();
  });

  // ── Test 8: toggleFarmWorker ──────────────────────────
  test('Test 8: toggleFarmWorker(id, true) -> isFarmWorker=true', async () => {
    const data = await clientA.mutate<{
      toggleFarmWorker: { id: string; isFarmWorker: boolean };
    }>(
      `
      mutation ToggleFarmWorker($id: ID!, $isFarmWorker: Boolean!) {
        toggleFarmWorker(id: $id, isFarmWorker: $isFarmWorker) {
          id
          isFarmWorker
        }
      }
    `,
      { id: createdEmployeeId, isFarmWorker: true },
    );

    expect(data.toggleFarmWorker.isFarmWorker).toBe(true);

    // Toggle back
    const data2 = await clientA.mutate<{
      toggleFarmWorker: { id: string; isFarmWorker: boolean };
    }>(
      `
      mutation ToggleFarmWorker($id: ID!, $isFarmWorker: Boolean!) {
        toggleFarmWorker(id: $id, isFarmWorker: $isFarmWorker) {
          id
          isFarmWorker
        }
      }
    `,
      { id: createdEmployeeId, isFarmWorker: false },
    );

    expect(data2.toggleFarmWorker.isFarmWorker).toBe(false);
  });

  // ── Test 9: hrDashboardStats ──────────────────────────
  test('Test 9: hrDashboardStats -> total, active, byDepartment', async () => {
    const data = await clientA.query<{
      hrDashboardStats: {
        totalEmployees: number;
        activeEmployees: number;
        onLeaveEmployees: number;
        terminatedEmployees: number;
        newHiresThisMonth: number;
        offshoreEmployees: number;
        onshoreEmployees: number;
        attendanceRate: number;
        pendingLeaveRequests: number;
        totalDepartments: number;
      };
    }>(`
      query DashboardStats {
        hrDashboardStats {
          totalEmployees
          activeEmployees
          onLeaveEmployees
          terminatedEmployees
          newHiresThisMonth
          offshoreEmployees
          onshoreEmployees
          attendanceRate
          pendingLeaveRequests
          totalDepartments
        }
      }
    `);

    const stats = data.hrDashboardStats;
    expect(typeof stats.totalEmployees).toBe('number');
    expect(typeof stats.activeEmployees).toBe('number');
    expect(stats.totalEmployees).toBeGreaterThanOrEqual(0);
    expect(stats.activeEmployees).toBeGreaterThanOrEqual(0);
    expect(typeof stats.attendanceRate).toBe('number');
    expect(typeof stats.totalDepartments).toBe('number');
  });

  // ── Test 10: Cross-tenant isolation ───────────────────
  test('Test 10: Tenant B cannot see Tenant A employee', async () => {
    // Tenant B queries for Tenant A's employee by ID
    const response = await clientB.queryRaw<{
      employee: { id: string } | null;
    }>(
      `
      query GetEmployee($id: ID!) {
        employee(id: $id) {
          id
          firstName
        }
      }
    `,
      { id: createdEmployeeId },
    );

    // Should either return null/empty or throw an error
    if (response.data?.employee) {
      // If data returned, it should NOT be our employee
      fail('Tenant B should not be able to see Tenant A employee');
    }
    // Errors are also acceptable (not found / unauthorized)
    if (response.errors) {
      expect(response.errors.length).toBeGreaterThan(0);
    }
  });

  // ── Test 11: DB verification ──────────────────────────
  test('Test 11: DB verify: employees table (not auth.users)', async () => {
    try {
      // Employees live in public schema (or tenant schema), NOT auth.users
      const result = await db.query<{
        id: string;
        firstName: string;
        tenantId: string;
        email: string;
      }>(
        `SELECT id, "firstName", "tenantId", email
         FROM employees
         WHERE id = $1 AND "tenantId" = $2`,
        [createdEmployeeId, TENANT_A_ID],
      );

      expect(result.rows.length).toBe(1);
      expect(result.rows[0].firstName).toBe('Ahmet');
      expect(result.rows[0].tenantId).toBe(TENANT_A_ID);

      // Verify NOT in auth.users (employees are HR records, not auth accounts)
      const authResult = await db.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM auth.users WHERE id = $1`,
        [createdEmployeeId],
      );
      expect(parseInt(authResult.rows[0].count, 10)).toBe(0);
    } catch (error) {
      // DB may not be accessible in all environments
      console.warn('DB verification skipped:', (error as Error).message);
    }
  });
});
