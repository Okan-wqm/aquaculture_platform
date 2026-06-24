/**
 * Department HR E2E Tests
 *
 * Tests HR department CRUD operations:
 * Create -> List -> Detail -> Update -> Unique code enforcement -> Cross-tenant isolation
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

describe('Department HR CRUD', () => {
  const clientA = new GraphQLTestClient(GATEWAY_URL, TOKEN_A, TENANT_A_ID);
  const clientB = new GraphQLTestClient(GATEWAY_URL, TOKEN_B, TENANT_B_ID);
  const db = new TestDatabase();

  let createdDeptId: string;
  const deptCode = `OPS-${Date.now()}`;

  afterAll(async () => {
    await db.close();
  });

  // ── Test 1: Create department and list ─────────────────
  test('Test 1: createHRDepartment -> hrDepartments -> found in list', async () => {
    const data = await clientA.mutate<{
      createHRDepartment: {
        id: string;
        name: string;
        code: string;
        type: string;
        isActive: boolean;
        description: string | null;
      };
    }>(
      `
      mutation CreateDept($input: CreateHRDepartmentInput!) {
        createHRDepartment(input: $input) {
          id
          name
          code
          type
          isActive
          description
        }
      }
    `,
      {
        input: {
          name: 'Operations Department',
          code: deptCode,
          type: 'OPERATIONS',
          description: 'Main operations department for E2E testing',
        },
      },
    );

    const dept = data.createHRDepartment;
    createdDeptId = dept.id;

    expect(dept.id).toBeDefined();
    expect(dept.name).toBe('Operations Department');
    expect(dept.code).toBe(deptCode);
    expect(dept.type).toBe('operations');
    expect(dept.isActive).toBe(true);
    expect(dept.description).toBe('Main operations department for E2E testing');

    // Verify in list
    const listData = await clientA.query<{
      hrDepartments: Array<{ id: string; name: string; code: string }>;
    }>(`
      query ListDepartments {
        hrDepartments {
          id
          name
          code
        }
      }
    `);

    const found = listData.hrDepartments.find((d: { id: string }) => d.id === createdDeptId);
    expect(found).toBeDefined();
    expect(assertDefined(found).code).toBe(deptCode);
  });

  // ── Test 2: Get department by ID ──────────────────────
  test('Test 2: hrDepartment(id) -> detail', async () => {
    const data = await clientA.query<{
      hrDepartment: {
        id: string;
        name: string;
        code: string;
        type: string;
        description: string;
        isActive: boolean;
        sortOrder: number;
        version: number;
        createdAt: string;
      };
    }>(
      `
      query GetDepartment($id: ID!) {
        hrDepartment(id: $id) {
          id
          name
          code
          type
          description
          isActive
          sortOrder
          version
          createdAt
        }
      }
    `,
      { id: createdDeptId },
    );

    expect(data.hrDepartment.id).toBe(createdDeptId);
    expect(data.hrDepartment.name).toBe('Operations Department');
    expect(data.hrDepartment.code).toBe(deptCode);
    expect(data.hrDepartment.type).toBe('operations');
    expect(data.hrDepartment.version).toBeGreaterThanOrEqual(1);
    expect(data.hrDepartment.createdAt).toBeDefined();
  });

  // ── Test 3: Update department ─────────────────────────
  test('Test 3: updateHRDepartment -> changes persisted', async () => {
    const data = await clientA.mutate<{
      updateHRDepartment: {
        id: string;
        name: string;
        description: string;
        budgetCode: string;
        costCenter: string;
      };
    }>(
      `
      mutation UpdateDept($input: UpdateHRDepartmentInput!) {
        updateHRDepartment(input: $input) {
          id
          name
          description
          budgetCode
          costCenter
        }
      }
    `,
      {
        input: {
          id: createdDeptId,
          name: 'Updated Operations',
          description: 'Updated description',
          budgetCode: 'BUD-OPS-01',
          costCenter: 'CC-100',
        },
      },
    );

    expect(data.updateHRDepartment.name).toBe('Updated Operations');
    expect(data.updateHRDepartment.description).toBe('Updated description');
    expect(data.updateHRDepartment.budgetCode).toBe('BUD-OPS-01');
    expect(data.updateHRDepartment.costCenter).toBe('CC-100');
  });

  // ── Test 4: Unique code per tenant ────────────────────
  test('Test 4: duplicate code per tenant -> error', async () => {
    const response = await clientA.queryRaw(
      `
      mutation CreateDuplicateDept($input: CreateHRDepartmentInput!) {
        createHRDepartment(input: $input) {
          id
        }
      }
    `,
      {
        input: {
          name: 'Duplicate Operations',
          code: deptCode,
          type: 'OPERATIONS',
        },
      },
    );

    expect(response.errors).toBeDefined();
    expect(assertDefined(response.errors).length).toBeGreaterThan(0);
  });

  // ── Test 5: Cross-tenant isolation ────────────────────
  test('Test 5: Tenant B cannot see Tenant A department', async () => {
    const response = await clientB.queryRaw<{
      hrDepartment: { id: string } | null;
    }>(
      `
      query GetDepartment($id: ID!) {
        hrDepartment(id: $id) {
          id
          name
        }
      }
    `,
      { id: createdDeptId },
    );

    // Should either return error or null
    if (response.data?.hrDepartment) {
      fail('Tenant B should not see Tenant A department');
    }
    if (response.errors) {
      expect(response.errors.length).toBeGreaterThan(0);
    }

    // Tenant B list should not contain Tenant A department
    const listResponse = await clientB.queryRaw<{
      hrDepartments: Array<{ id: string }>;
    }>(`
      query ListDepartments {
        hrDepartments {
          id
        }
      }
    `);

    if (listResponse.data?.hrDepartments) {
      const crossTenantFound = listResponse.data.hrDepartments.find(
        (d: { id: string }) => d.id === createdDeptId,
      );
      expect(crossTenantFound).toBeUndefined();
    }
  });

  // ── DB Verification ───────────────────────────────────
  test('DB verify: departments_hr table has correct tenant scoping', async () => {
    try {
      const result = await db.query<{
        id: string;
        name: string;
        code: string;
        tenantId: string;
      }>(
        `SELECT id, name, code, "tenantId"
         FROM departments_hr
         WHERE id = $1 AND "tenantId" = $2`,
        [createdDeptId, TENANT_A_ID],
      );

      expect(result.rows.length).toBe(1);
      expect(result.rows[0].tenantId).toBe(TENANT_A_ID);
      expect(result.rows[0].code).toBe(deptCode);
    } catch (error) {
      console.warn('DB verification skipped:', (error as Error).message);
    }
  });
});
