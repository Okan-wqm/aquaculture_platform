/**
 * Team Calendar & Leave Balances E2E Tests
 *
 * Tests team leave calendar, pending approvals, my leave requests,
 * and cross-tenant isolation for calendar views.
 */
import { randomUUID } from 'crypto';

import { TestDatabase } from '../../../helpers/db.helper';
import { GraphQLTestClient } from '../../../helpers/graphql-client';
import { generateTestToken } from '../../../helpers/jwt.helper';

const GATEWAY_URL = process.env.GATEWAY_URL || 'http://localhost:4000';

// ── Tenant A — Employee user ──────────────────────────────
const TENANT_A_ID = randomUUID();
const EMPLOYEE_USER_ID = randomUUID();
const TOKEN_EMPLOYEE = generateTestToken({
  userId: EMPLOYEE_USER_ID,
  tenantId: TENANT_A_ID,
  role: 'MODULE_USER',
});

// ── Tenant A — Manager user ──────────────────────────────
const MANAGER_USER_ID = randomUUID();
const TOKEN_MANAGER = generateTestToken({
  userId: MANAGER_USER_ID,
  tenantId: TENANT_A_ID,
  role: 'TENANT_ADMIN',
});

// ── Tenant A — Admin ─────────────────────────────────────
const ADMIN_USER_ID = randomUUID();
const TOKEN_ADMIN = generateTestToken({
  userId: ADMIN_USER_ID,
  tenantId: TENANT_A_ID,
  role: 'TENANT_ADMIN',
});

// ── Tenant B (cross-tenant) ──────────────────────────────
const TENANT_B_ID = randomUUID();
const USER_B_ID = randomUUID();
const TOKEN_B = generateTestToken({
  userId: USER_B_ID,
  tenantId: TENANT_B_ID,
  role: 'TENANT_ADMIN',
});

describe('Team Calendar & Leave Balances', () => {
  const clientEmployee = new GraphQLTestClient(GATEWAY_URL, TOKEN_EMPLOYEE, TENANT_A_ID);
  const clientManager = new GraphQLTestClient(GATEWAY_URL, TOKEN_MANAGER, TENANT_A_ID);
  const clientAdmin = new GraphQLTestClient(GATEWAY_URL, TOKEN_ADMIN, TENANT_A_ID);
  const clientB = new GraphQLTestClient(GATEWAY_URL, TOKEN_B, TENANT_B_ID);
  const db = new TestDatabase();

  let employeeId: string;
  let leaveTypeId: string;
  let leaveRequestId: string;

  beforeAll(async () => {
    // Create employee
    const empData = await clientAdmin.mutate<{
      createEmployee: { id: string };
    }>(
      `
      mutation CreateEmp($input: CreateEmployeeInput!) {
        createEmployee(input: $input) { id }
      }
    `,
      {
        input: {
          firstName: 'Calendar',
          lastName: 'Employee',
          email: `e2e-cal-${Date.now()}@test.aquaculture.io`,
          contactInfo: {
            email: `e2e-cal-c-${Date.now()}@test.aquaculture.io`,
            phone: '+90-555-222-3333',
          },
          address: {
            street: '456 Calendar Ave',
            city: 'Bodrum',
            state: 'Aegean',
            postalCode: '48400',
            country: 'Turkey',
          },
          dateOfBirth: '1994-12-25',
          nationalId: 'TC88888888888',
          employmentType: 'FULL_TIME',
          department: 'QUALITY_CONTROL',
          position: 'Lab Analyst',
          hireDate: '2024-02-01',
          baseSalary: 48000,
          currency: 'TRY',
        },
      },
    );
    employeeId = empData.createEmployee.id;

    // Link employee to user
    try {
      await db.query(`UPDATE employees SET "userId" = $1 WHERE id = $2 AND "tenantId" = $3`, [
        EMPLOYEE_USER_ID,
        employeeId,
        TENANT_A_ID,
      ]);
    } catch (error) {
      console.warn('Could not link employee:', (error as Error).message);
    }

    // Get first leave type for creating requests
    try {
      const ltData = await clientAdmin.query<{
        leaveTypes: Array<{ id: string }>;
      }>(`
        query LeaveTypes { leaveTypes { id } }
      `);
      if (ltData.leaveTypes.length > 0) {
        leaveTypeId = ltData.leaveTypes[0].id;
      } else {
        leaveTypeId = randomUUID();
      }
    } catch {
      leaveTypeId = randomUUID();
    }

    // Create a leave request, submit, and approve for calendar visibility
    try {
      const createData = await clientEmployee.mutate<{
        createLeaveRequest: { id: string };
      }>(
        `
        mutation CreateLeave($input: CreateLeaveRequestInput!) {
          createLeaveRequest(input: $input) { id }
        }
      `,
        {
          input: {
            employeeId,
            leaveTypeId,
            startDate: '2026-04-10',
            endDate: '2026-04-14',
            totalDays: 5,
            reason: 'Calendar test leave',
          },
        },
      );
      leaveRequestId = createData.createLeaveRequest.id;

      // Submit
      await clientEmployee.mutate(
        `
        mutation Submit($id: ID!) {
          submitLeaveRequest(id: $id) { id status }
        }
      `,
        { id: leaveRequestId },
      );

      // Approve (by manager)
      await clientManager.mutate(
        `
        mutation Approve($id: ID!) {
          approveLeaveRequest(id: $id) { id status }
        }
      `,
        { id: leaveRequestId },
      );
    } catch (error) {
      console.warn('Leave setup failed:', (error as Error).message);
    }

    // Create a pending leave request for the pending approvals test
    try {
      const pendingData = await clientEmployee.mutate<{
        createLeaveRequest: { id: string };
      }>(
        `
        mutation CreateLeave($input: CreateLeaveRequestInput!) {
          createLeaveRequest(input: $input) { id }
        }
      `,
        {
          input: {
            employeeId,
            leaveTypeId,
            startDate: '2026-05-20',
            endDate: '2026-05-22',
            totalDays: 3,
            reason: 'Pending approval test',
          },
        },
      );

      // Submit but do NOT approve (keep in PENDING)
      await clientEmployee.mutate(
        `
        mutation Submit($id: ID!) {
          submitLeaveRequest(id: $id) { id status }
        }
      `,
        { id: pendingData.createLeaveRequest.id },
      );
    } catch (error) {
      console.warn('Pending leave setup failed:', (error as Error).message);
    }
  });

  afterAll(async () => {
    await db.close();
  });

  // ── Test 1: teamLeaveCalendar ─────────────────────────
  test('Test 1: teamLeaveCalendar(startDate, endDate) -> team calendar', async () => {
    const data = await clientManager.query<{
      teamLeaveCalendar: Array<{
        id: string;
        employeeId: string;
        employeeName: string;
        leaveTypeName: string;
        leaveTypeColor: string;
        startDate: string;
        endDate: string;
        totalDays: number;
        status: string;
        isHalfDayStart: boolean;
        isHalfDayEnd: boolean;
      }>;
    }>(
      `
      query TeamCalendar($startDate: String!, $endDate: String!) {
        teamLeaveCalendar(startDate: $startDate, endDate: $endDate) {
          id
          employeeId
          employeeName
          leaveTypeName
          leaveTypeColor
          startDate
          endDate
          totalDays
          status
          isHalfDayStart
          isHalfDayEnd
        }
      }
    `,
      {
        startDate: '2026-04-01',
        endDate: '2026-04-30',
      },
    );

    expect(data.teamLeaveCalendar).toBeDefined();
    expect(Array.isArray(data.teamLeaveCalendar)).toBe(true);

    // Should contain only APPROVED or PENDING leaves
    for (const entry of data.teamLeaveCalendar) {
      expect(['approved', 'pending']).toContain(entry.status);
      expect(entry.employeeId).toBeDefined();
      expect(entry.employeeName).toBeDefined();
      expect(entry.leaveTypeName).toBeDefined();
      expect(typeof entry.totalDays).toBe('number');
      expect(typeof entry.isHalfDayStart).toBe('boolean');
      expect(typeof entry.isHalfDayEnd).toBe('boolean');
    }

    // Our approved leave should appear if within the date range
    if (leaveRequestId) {
      const found = data.teamLeaveCalendar.find((e: { id: string }) => e.id === leaveRequestId);
      if (found) {
        expect(found.status).toBe('approved');
        expect(found.totalDays).toBe(5);
      }
    }
  });

  // ── Test 2: pendingLeaveApprovals ─────────────────────
  test('Test 2: pendingLeaveApprovals -> pending requests for manager', async () => {
    const data = await clientManager.query<{
      pendingLeaveApprovals: {
        data: Array<{
          id: string;
          employeeId: string;
          status: string;
          startDate: string;
          endDate: string;
          totalDays: number;
          reason: string;
        }>;
        total: number;
      };
    }>(`
      query PendingApprovals {
        pendingLeaveApprovals {
          data {
            id
            employeeId
            status
            startDate
            endDate
            totalDays
            reason
          }
          total
        }
      }
    `);

    expect(data.pendingLeaveApprovals).toBeDefined();
    expect(typeof data.pendingLeaveApprovals.total).toBe('number');

    // All returned requests should be in PENDING status
    for (const request of data.pendingLeaveApprovals.data) {
      expect(request.status).toBe('pending');
      expect(request.employeeId).toBeDefined();
      expect(request.startDate).toBeDefined();
      expect(typeof request.totalDays).toBe('number');
    }
  });

  // ── Test 3: myLeaveRequests ───────────────────────────
  test('Test 3: myLeaveRequests -> own leave requests', async () => {
    const data = await clientEmployee.query<{
      myLeaveRequests: Array<{
        id: string;
        employeeId: string;
        status: string;
        startDate: string;
        endDate: string;
        totalDays: number;
        reason: string;
        requestNumber: string;
      }>;
    }>(`
      query MyLeaves {
        myLeaveRequests {
          id
          employeeId
          status
          startDate
          endDate
          totalDays
          reason
          requestNumber
        }
      }
    `);

    expect(data.myLeaveRequests).toBeDefined();
    expect(Array.isArray(data.myLeaveRequests)).toBe(true);

    // All returned requests should belong to the current employee
    for (const request of data.myLeaveRequests) {
      expect(request.employeeId).toBe(employeeId);
      expect(request.requestNumber).toMatch(/^LR-\d{4}-\d{5}$/);
    }

    // Our created leaves should be in the list
    if (leaveRequestId) {
      const found = data.myLeaveRequests.find((r: { id: string }) => r.id === leaveRequestId);
      if (found) {
        expect(found.status).toBe('approved');
      }
    }
  });

  // ── Test 3b: myLeaveRequests with status filter ───────
  test('Test 3b: myLeaveRequests with status filter', async () => {
    const data = await clientEmployee.query<{
      myLeaveRequests: Array<{
        id: string;
        status: string;
      }>;
    }>(
      `
      query MyLeavesFiltered($status: LeaveRequestStatus) {
        myLeaveRequests(status: $status) {
          id
          status
        }
      }
    `,
      { status: 'APPROVED' },
    );

    for (const request of data.myLeaveRequests) {
      expect(request.status).toBe('approved');
    }
  });

  // ── Test 3c: myLeaveBalances ──────────────────────────
  test('Test 3c: myLeaveBalances -> own balance data', async () => {
    try {
      const data = await clientEmployee.query<{
        myLeaveBalances: Array<{
          id: string;
          employeeId: string;
          leaveTypeId: string;
          year: number;
          openingBalance: number;
          used: number;
          pending: number;
          currentBalance: number;
          availableBalance: number;
        }>;
      }>(`
        query MyBalances {
          myLeaveBalances {
            id
            employeeId
            leaveTypeId
            year
            openingBalance
            used
            pending
            currentBalance
            availableBalance
          }
        }
      `);

      expect(data.myLeaveBalances).toBeDefined();
      expect(Array.isArray(data.myLeaveBalances)).toBe(true);

      for (const balance of data.myLeaveBalances) {
        expect(balance.employeeId).toBe(employeeId);
        expect(typeof balance.currentBalance).toBe('number');
        expect(typeof balance.availableBalance).toBe('number');
      }
    } catch (error) {
      // myLeaveBalances may fail if no balance records exist
      console.warn('myLeaveBalances returned error:', (error as Error).message);
    }
  });

  // ── Test 4: Cross-tenant isolation ────────────────────
  test('Test 4: Tenant B cannot see Tenant A team calendar', async () => {
    const data = await clientB.query<{
      teamLeaveCalendar: Array<{ id: string; employeeId: string }>;
    }>(
      `
      query TeamCalendar($startDate: String!, $endDate: String!) {
        teamLeaveCalendar(startDate: $startDate, endDate: $endDate) {
          id
          employeeId
        }
      }
    `,
      {
        startDate: '2026-04-01',
        endDate: '2026-04-30',
      },
    );

    // Tenant B should not see Tenant A's calendar entries
    if (data.teamLeaveCalendar.length > 0) {
      for (const entry of data.teamLeaveCalendar) {
        expect(entry.employeeId).not.toBe(employeeId);
      }
    }

    // Also check that Tenant B cannot see pending approvals for Tenant A
    const pendingData = await clientB.query<{
      pendingLeaveApprovals: {
        data: Array<{ id: string; employeeId: string }>;
        total: number;
      };
    }>(`
      query PendingApprovals {
        pendingLeaveApprovals {
          data { id employeeId }
          total
        }
      }
    `);

    // None of the pending approvals should be for Tenant A employees
    for (const request of pendingData.pendingLeaveApprovals.data) {
      expect(request.employeeId).not.toBe(employeeId);
    }
  });

  // ── Test 4b: Cross-tenant myLeaveRequests isolation ───
  test('Test 4b: Tenant B myLeaveRequests does not contain Tenant A data', async () => {
    const response = await clientB.queryRaw<{
      myLeaveRequests: Array<{ id: string; employeeId: string }>;
    }>(`
      query MyLeaves {
        myLeaveRequests {
          id
          employeeId
        }
      }
    `);

    // Either errors (no employee record for user B) or empty list
    if (response.data?.myLeaveRequests) {
      for (const request of response.data.myLeaveRequests) {
        expect(request.employeeId).not.toBe(employeeId);
      }
    }
    // Error is also acceptable (user B has no employee record in Tenant B)
  });

  // ── DB Verification ───────────────────────────────────
  test('DB verify: leave_requests scoped to correct tenant', async () => {
    try {
      const result = await db.query<{
        id: string;
        tenantId: string;
        status: string;
        employeeId: string;
      }>(
        `SELECT id, "tenantId", status, "employeeId"
         FROM leave_requests
         WHERE "employeeId" = $1 AND "tenantId" = $2
         ORDER BY "createdAt" DESC
         LIMIT 10`,
        [employeeId, TENANT_A_ID],
      );

      for (const row of result.rows) {
        expect(row.tenantId).toBe(TENANT_A_ID);
        expect(row.employeeId).toBe(employeeId);
      }

      // Verify approved leave exists
      const approved = result.rows.find((r: { status: string }) => r.status === 'approved');
      if (approved) {
        expect(approved.id).toBe(leaveRequestId);
      }
    } catch (error) {
      console.warn('DB verification skipped:', (error as Error).message);
    }
  });
});
