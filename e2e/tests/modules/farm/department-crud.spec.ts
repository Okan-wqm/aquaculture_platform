/**
 * Department CRUD + Relationships E2E Tests
 *
 * Tests:
 * 1. createDepartment -> department(id) -> departments(filter)
 * 2. Site-Department relationship: department.siteId -> site exists
 * 3. updateDepartment -> values changed
 * 4. deleteDepartment -> departmentDeletePreview -> preview relationship count
 * 5. Cross-tenant isolation
 * 6. Unique constraint: same tenant+code -> error
 */
import { assertDefined } from '../../../helpers/assertions';
import { TestDatabase } from '../../../helpers/db.helper';
import { GraphQLTestClient } from '../../../helpers/graphql-client';
import { generateCrossTenantTokens } from '../../../helpers/jwt.helper';

// ---------------------------------------------------------------------------
// GraphQL Fragments
// ---------------------------------------------------------------------------

const DEPARTMENT_FIELDS = `
  id
  tenantId
  siteId
  name
  code
  type
  status
  description
  isActive
  createdAt
  updatedAt
`;

const CREATE_SITE = `
  mutation CreateSite($input: CreateSiteInput!) {
    createSite(input: $input) {
      id
      name
      tenantId
    }
  }
`;

const CREATE_DEPARTMENT = `
  mutation CreateDepartment($input: CreateDepartmentInput!) {
    createDepartment(input: $input) {
      ${DEPARTMENT_FIELDS}
    }
  }
`;

const UPDATE_DEPARTMENT = `
  mutation UpdateDepartment($input: UpdateDepartmentInput!) {
    updateDepartment(input: $input) {
      ${DEPARTMENT_FIELDS}
    }
  }
`;

const DELETE_DEPARTMENT = `
  mutation DeleteDepartment($id: ID!, $cascade: Boolean!) {
    deleteDepartment(id: $id, cascade: $cascade)
  }
`;

const GET_DEPARTMENT = `
  query Department($id: ID!) {
    department(id: $id) {
      ${DEPARTMENT_FIELDS}
    }
  }
`;

const LIST_DEPARTMENTS = `
  query Departments($filter: DepartmentFilterInput, $pagination: FarmPaginationInput) {
    departments(filter: $filter, pagination: $pagination) {
      items {
        ${DEPARTMENT_FIELDS}
      }
      total
    }
  }
`;

const DEPARTMENT_DELETE_PREVIEW = `
  query DepartmentDeletePreview($id: ID!) {
    departmentDeletePreview(id: $id) {
      canDelete
      blockers
      affectedItems {
        totalCount
      }
    }
  }
`;

const DEPARTMENTS_BY_SITE = `
  query DepartmentsBySite($siteId: ID!) {
    departmentsBySite(siteId: $siteId) {
      id
      name
      siteId
    }
  }
`;

// ---------------------------------------------------------------------------
// Test Suite
// ---------------------------------------------------------------------------

describe('Department CRUD + Relationships E2E', () => {
  const client = GraphQLTestClient.forFarmService();
  const db = new TestDatabase();
  let tenantAToken: string;
  let tenantAId: string;
  let tenantBToken: string;
  let tenantBId: string;
  let siteId: string;

  beforeAll(async () => {
    await db.connect();
    const tokens = generateCrossTenantTokens();
    tenantAToken = tokens.tenantA.token;
    tenantAId = tokens.tenantA.tenantId;
    tenantBToken = tokens.tenantB.token;
    tenantBId = tokens.tenantB.tenantId;

    // Create a prerequisite site for department tests
    const siteResult = await client.executeSuccess<{
      createSite: { id: string };
    }>({
      query: CREATE_SITE,
      variables: {
        input: {
          name: `Dept Test Site ${Date.now()}`,
          code: `DTS-${Date.now().toString(36).toUpperCase()}`,
        },
      },
      token: tenantAToken,
    });
    siteId = siteResult.createSite.id;
  });

  afterAll(async () => {
    await db.cleanupTenant(tenantAId, ['departments', 'sites']);
    await db.cleanupTenant(tenantBId, ['departments', 'sites']);
    await db.disconnect();
  });

  // -------------------------------------------------------------------------
  // Test 1: Full CRUD flow
  // -------------------------------------------------------------------------
  it('should create department, read by id, and find in filtered list', async () => {
    const input = {
      siteId,
      name: `E2E Dept ${Date.now()}`,
      code: `DEP-${Date.now().toString(36).toUpperCase()}`,
      type: 'production',
      description: 'Test department for CRUD',
    };

    // CREATE
    const createResult = await client.executeSuccess<{
      createDepartment: {
        id: string;
        tenantId: string;
        siteId: string;
        name: string;
        code: string;
        type: string;
        status: string;
        isActive: boolean;
      };
    }>({
      query: CREATE_DEPARTMENT,
      variables: { input },
      token: tenantAToken,
    });

    const dept = createResult.createDepartment;
    expect(dept.id).toBeDefined();
    expect(dept.name).toBe(input.name);
    expect(dept.code).toBe(input.code);
    expect(dept.siteId).toBe(siteId);
    expect(dept.type).toBe('production');
    expect(dept.status).toBe('active');
    expect(dept.isActive).toBe(true);

    // READ by ID
    const readResult = await client.executeSuccess<{
      department: {
        id: string;
        name: string;
        code: string;
        siteId: string;
      };
    }>({
      query: GET_DEPARTMENT,
      variables: { id: dept.id },
      token: tenantAToken,
    });

    expect(readResult.department.id).toBe(dept.id);
    expect(readResult.department.name).toBe(input.name);

    // DB VERIFY
    const dbRow = await db.findById('departments', dept.id, tenantAId);
    expect(dbRow).not.toBeNull();
    expect(assertDefined(dbRow)['name']).toBe(input.name);
    expect(assertDefined(dbRow)['siteId']).toBe(siteId);

    // LIST with filter
    const listResult = await client.executeSuccess<{
      departments: {
        items: Array<{ id: string; siteId: string }>;
        total: number;
      };
    }>({
      query: LIST_DEPARTMENTS,
      variables: { filter: { siteId } },
      token: tenantAToken,
    });

    const found = listResult.departments.items.find((d: { id: string }) => d.id === dept.id);
    expect(found).toBeDefined();
  });

  // -------------------------------------------------------------------------
  // Test 2: Site-Department relationship
  // -------------------------------------------------------------------------
  it('should correctly link department to site via departmentsBySite query', async () => {
    const input = {
      siteId,
      name: `Rel Test ${Date.now()}`,
      code: `REL-${Date.now().toString(36).toUpperCase()}`,
      type: 'maintenance',
    };

    const createResult = await client.executeSuccess<{
      createDepartment: { id: string; siteId: string };
    }>({
      query: CREATE_DEPARTMENT,
      variables: { input },
      token: tenantAToken,
    });

    expect(createResult.createDepartment.siteId).toBe(siteId);

    // Query departments by site
    const bySiteResult = await client.executeSuccess<{
      departmentsBySite: Array<{ id: string; siteId: string; name: string }>;
    }>({
      query: DEPARTMENTS_BY_SITE,
      variables: { siteId },
      token: tenantAToken,
    });

    const found = bySiteResult.departmentsBySite.find(
      (d: { id: string }) => d.id === createResult.createDepartment.id,
    );
    expect(found).toBeDefined();
    expect(assertDefined(found).siteId).toBe(siteId);
  });

  // -------------------------------------------------------------------------
  // Test 3: Update department
  // -------------------------------------------------------------------------
  it('should update department name and type', async () => {
    const input = {
      siteId,
      name: `UpdDept ${Date.now()}`,
      code: `UD-${Date.now().toString(36).toUpperCase()}`,
      type: 'production',
    };

    const createResult = await client.executeSuccess<{
      createDepartment: { id: string };
    }>({
      query: CREATE_DEPARTMENT,
      variables: { input },
      token: tenantAToken,
    });

    const deptId = createResult.createDepartment.id;

    const updateInput = {
      id: deptId,
      name: `Updated Dept ${Date.now()}`,
      type: 'quality_control',
    };

    const updateResult = await client.executeSuccess<{
      updateDepartment: { id: string; name: string; type: string };
    }>({
      query: UPDATE_DEPARTMENT,
      variables: { input: updateInput },
      token: tenantAToken,
    });

    expect(updateResult.updateDepartment.name).toBe(updateInput.name);
    expect(updateResult.updateDepartment.type).toBe('quality_control');

    // DB verify
    const dbRow = await db.findById('departments', deptId, tenantAId);
    expect(assertDefined(dbRow)['name']).toBe(updateInput.name);
  });

  // -------------------------------------------------------------------------
  // Test 4: Delete with preview
  // -------------------------------------------------------------------------
  it('should preview and soft-delete department', async () => {
    const input = {
      siteId,
      name: `DelDept ${Date.now()}`,
      code: `DD-${Date.now().toString(36).toUpperCase()}`,
      type: 'other',
    };

    const createResult = await client.executeSuccess<{
      createDepartment: { id: string };
    }>({
      query: CREATE_DEPARTMENT,
      variables: { input },
      token: tenantAToken,
    });

    const deptId = createResult.createDepartment.id;

    // PREVIEW
    const previewResult = await client.executeSuccess<{
      departmentDeletePreview: {
        canDelete: boolean;
        blockers: string[];
        affectedItems: { totalCount: number };
      };
    }>({
      query: DEPARTMENT_DELETE_PREVIEW,
      variables: { id: deptId },
      token: tenantAToken,
    });

    expect(previewResult.departmentDeletePreview.canDelete).toBe(true);
    expect(previewResult.departmentDeletePreview.affectedItems.totalCount).toBeGreaterThanOrEqual(
      0,
    );

    // DELETE
    const deleteResult = await client.executeSuccess<{
      deleteDepartment: boolean;
    }>({
      query: DELETE_DEPARTMENT,
      variables: { id: deptId, cascade: false },
      token: tenantAToken,
    });

    expect(deleteResult.deleteDepartment).toBe(true);

    // Verify soft-deleted in DB
    const dbRow = await db.findById('departments', deptId, tenantAId);
    if (dbRow) {
      expect(dbRow['isDeleted']).toBe(true);
    }
  });

  // -------------------------------------------------------------------------
  // Test 5: Cross-tenant isolation
  // -------------------------------------------------------------------------
  it('should not allow Tenant B to see Tenant A department', async () => {
    const input = {
      siteId,
      name: `Iso Dept ${Date.now()}`,
      code: `ISO-${Date.now().toString(36).toUpperCase()}`,
      type: 'production',
    };

    const createResult = await client.executeSuccess<{
      createDepartment: { id: string };
    }>({
      query: CREATE_DEPARTMENT,
      variables: { input },
      token: tenantAToken,
    });

    const deptId = createResult.createDepartment.id;

    // Tenant B queries the department
    const readResult = await client.execute<{
      department: { id: string } | null;
    }>({
      query: GET_DEPARTMENT,
      variables: { id: deptId },
      token: tenantBToken,
    });

    expect(readResult.data?.department).toBeNull();

    // Tenant B lists departments - should NOT see Tenant A's department
    const listResult = await client.executeSuccess<{
      departments: { items: Array<{ id: string }> };
    }>({
      query: LIST_DEPARTMENTS,
      variables: {},
      token: tenantBToken,
    });

    const found = listResult.departments.items.find((d: { id: string }) => d.id === deptId);
    expect(found).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // Test 6: Unique constraint on code
  // -------------------------------------------------------------------------
  it('should reject duplicate department code within the same tenant', async () => {
    const sharedCode = `DUP-${Date.now().toString(36).toUpperCase()}`;

    const input1 = {
      siteId,
      name: `Dup Dept A ${Date.now()}`,
      code: sharedCode,
      type: 'production',
    };

    await client.executeSuccess<{
      createDepartment: { id: string };
    }>({
      query: CREATE_DEPARTMENT,
      variables: { input: input1 },
      token: tenantAToken,
    });

    const input2 = {
      siteId,
      name: `Dup Dept B ${Date.now() + 1}`,
      code: sharedCode,
      type: 'maintenance',
    };

    const duplicateResult = await client.execute<{
      createDepartment: { id: string };
    }>({
      query: CREATE_DEPARTMENT,
      variables: { input: input2 },
      token: tenantAToken,
    });

    expect(duplicateResult.errors).toBeDefined();
    expect(assertDefined(duplicateResult.errors).length).toBeGreaterThan(0);
  });
});
