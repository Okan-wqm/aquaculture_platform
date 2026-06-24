/**
 * Farm Infrastructure Round-Trip E2E Test
 *
 * Full chain:
 * 1. createSite
 * 2. createDepartment(siteId)
 * 3. createSystem(siteId, departmentId)
 * 4. createTank(departmentId)
 * 5. DB verify all exist
 * 6. Query each entity -> values correct
 * 7. Tenant B queries all -> NONE visible
 * 8. Teardown: delete tank -> system -> department -> site
 */
import { TestDatabase } from '../../../helpers/db.helper';
import { GraphQLTestClient } from '../../../helpers/graphql-client';
import { generateCrossTenantTokens } from '../../../helpers/jwt.helper';

// ---------------------------------------------------------------------------
// GraphQL Operations
// ---------------------------------------------------------------------------

const CREATE_SITE = `
  mutation CreateSite($input: CreateSiteInput!) {
    createSite(input: $input) {
      id
      name
      code
      tenantId
      status
      isActive
    }
  }
`;

const CREATE_DEPARTMENT = `
  mutation CreateDepartment($input: CreateDepartmentInput!) {
    createDepartment(input: $input) {
      id
      name
      code
      siteId
      tenantId
      status
      isActive
    }
  }
`;

const CREATE_SYSTEM = `
  mutation CreateSystem($input: CreateSystemInput!) {
    createSystem(input: $input) {
      id
      name
      code
      siteId
      departmentId
      tenantId
      status
      isActive
    }
  }
`;

const CREATE_TANK = `
  mutation CreateTank($input: CreateTankInput!) {
    createTank(input: $input) {
      id
      name
      code
      departmentId
      tenantId
      volume
      status
      isActive
    }
  }
`;

const GET_SITE = `
  query Site($id: ID!) {
    site(id: $id) {
      id
      name
      code
      tenantId
      status
    }
  }
`;

const GET_DEPARTMENT = `
  query Department($id: ID!) {
    department(id: $id) {
      id
      name
      code
      siteId
      tenantId
      status
    }
  }
`;

const GET_SYSTEM = `
  query System($id: ID!) {
    system(id: $id) {
      id
      name
      code
      siteId
      departmentId
      tenantId
      status
    }
  }
`;

const GET_TANK = `
  query Tank($id: ID!) {
    tank(id: $id) {
      id
      name
      code
      departmentId
      tenantId
      volume
      status
    }
  }
`;

const DELETE_TANK = `
  mutation DeleteTank($id: ID!) {
    deleteTank(id: $id) {
      success
      id
    }
  }
`;

const DELETE_SYSTEM = `
  mutation DeleteSystem($id: ID!, $cascade: Boolean!) {
    deleteSystem(id: $id, cascade: $cascade)
  }
`;

const DELETE_DEPARTMENT = `
  mutation DeleteDepartment($id: ID!, $cascade: Boolean!) {
    deleteDepartment(id: $id, cascade: $cascade)
  }
`;

const DELETE_SITE = `
  mutation DeleteSite($id: ID!, $cascade: Boolean!) {
    deleteSite(id: $id, cascade: $cascade)
  }
`;

// ---------------------------------------------------------------------------
// Test Suite
// ---------------------------------------------------------------------------

describe('Farm Infrastructure Round-Trip E2E', () => {
  const client = GraphQLTestClient.forFarmService();
  const db = new TestDatabase();
  let tenantAToken: string;
  let tenantAId: string;
  let tenantBToken: string;
  let tenantBId: string;

  // Entity IDs created during the test
  let createdSiteId: string;
  let createdDeptId: string;
  let createdSystemId: string;
  let createdTankId: string;

  beforeAll(async () => {
    await db.connect();
    const tokens = generateCrossTenantTokens();
    tenantAToken = tokens.tenantA.token;
    tenantAId = tokens.tenantA.tenantId;
    tenantBToken = tokens.tenantB.token;
    tenantBId = tokens.tenantB.tenantId;
  });

  afterAll(async () => {
    // Final cleanup via DB in case GraphQL deletions fail
    await db.cleanupTenant(tenantAId, ['tanks', 'systems', 'departments', 'sites']);
    await db.cleanupTenant(tenantBId, ['tanks', 'systems', 'departments', 'sites']);
    await db.disconnect();
  });

  // =========================================================================
  // STEP 1: Create Site
  // =========================================================================
  it('Step 1: should create a site', async () => {
    const input = {
      name: `RT Site ${Date.now()}`,
      code: `RT-${Date.now().toString(36).toUpperCase()}`,
      description: 'Round-trip test site',
      timezone: 'Europe/Istanbul',
    };

    const result = await client.executeSuccess<{
      createSite: {
        id: string;
        name: string;
        code: string;
        tenantId: string;
        status: string;
        isActive: boolean;
      };
    }>({
      query: CREATE_SITE,
      variables: { input },
      token: tenantAToken,
    });

    createdSiteId = result.createSite.id;
    expect(createdSiteId).toBeDefined();
    expect(result.createSite.name).toBe(input.name);
    expect(result.createSite.status).toBe('active');
    expect(result.createSite.isActive).toBe(true);
  });

  // =========================================================================
  // STEP 2: Create Department under Site
  // =========================================================================
  it('Step 2: should create a department under the site', async () => {
    const input = {
      siteId: createdSiteId,
      name: `RT Dept ${Date.now()}`,
      code: `RD-${Date.now().toString(36).toUpperCase()}`,
      type: 'production',
      description: 'Round-trip test department',
    };

    const result = await client.executeSuccess<{
      createDepartment: {
        id: string;
        name: string;
        code: string;
        siteId: string;
        tenantId: string;
        status: string;
        isActive: boolean;
      };
    }>({
      query: CREATE_DEPARTMENT,
      variables: { input },
      token: tenantAToken,
    });

    createdDeptId = result.createDepartment.id;
    expect(createdDeptId).toBeDefined();
    expect(result.createDepartment.siteId).toBe(createdSiteId);
    expect(result.createDepartment.status).toBe('active');
  });

  // =========================================================================
  // STEP 3: Create System under Site + Department
  // =========================================================================
  it('Step 3: should create a system linked to site and department', async () => {
    const input = {
      siteId: createdSiteId,
      departmentId: createdDeptId,
      name: `RT System ${Date.now()}`,
      code: `RS-${Date.now().toString(36).toUpperCase()}`,
      type: 'ras',
      description: 'Round-trip test system',
      totalVolumeM3: 100.0,
      maxBiomassKg: 500.0,
      tankCount: 5,
    };

    const result = await client.executeSuccess<{
      createSystem: {
        id: string;
        name: string;
        code: string;
        siteId: string;
        departmentId: string;
        tenantId: string;
        status: string;
        isActive: boolean;
      };
    }>({
      query: CREATE_SYSTEM,
      variables: { input },
      token: tenantAToken,
    });

    createdSystemId = result.createSystem.id;
    expect(createdSystemId).toBeDefined();
    expect(result.createSystem.siteId).toBe(createdSiteId);
    expect(result.createSystem.departmentId).toBe(createdDeptId);
    expect(result.createSystem.status).toBe('operational');
  });

  // =========================================================================
  // STEP 4: Create Tank under Department
  // =========================================================================
  it('Step 4: should create a tank under the department', async () => {
    const input = {
      name: `RT Tank ${Date.now()}`,
      departmentId: createdDeptId,
      systemId: createdSystemId,
      tankType: 'circular',
      material: 'fiberglass',
      waterType: 'saltwater',
      diameter: 5.0,
      depth: 1.5,
      maxBiomass: 500.0,
      maxDensity: 30,
    };

    const result = await client.executeSuccess<{
      createTank: {
        id: string;
        name: string;
        code: string;
        departmentId: string;
        tenantId: string;
        volume: number;
        status: string;
        isActive: boolean;
      };
    }>({
      query: CREATE_TANK,
      variables: { input },
      token: tenantAToken,
    });

    createdTankId = result.createTank.id;
    expect(createdTankId).toBeDefined();
    expect(result.createTank.departmentId).toBe(createdDeptId);
    expect(result.createTank.volume).toBeGreaterThan(0);
    expect(result.createTank.status).toBe('preparing');
  });

  // =========================================================================
  // STEP 5: Verify all exist in DB
  // =========================================================================
  it('Step 5: should verify all entities exist in database', async () => {
    const siteExists = await db.exists('sites', createdSiteId, tenantAId);
    expect(siteExists).toBe(true);

    const deptExists = await db.exists('departments', createdDeptId, tenantAId);
    expect(deptExists).toBe(true);

    const systemExists = await db.exists('systems', createdSystemId, tenantAId);
    expect(systemExists).toBe(true);

    const tankExists = await db.exists('tanks', createdTankId, tenantAId);
    expect(tankExists).toBe(true);
  });

  // =========================================================================
  // STEP 6: Query each entity and verify values
  // =========================================================================
  it('Step 6: should re-read each entity via query and verify values', async () => {
    // Site
    const siteResult = await client.executeSuccess<{
      site: { id: string; name: string; tenantId: string; status: string };
    }>({
      query: GET_SITE,
      variables: { id: createdSiteId },
      token: tenantAToken,
    });
    expect(siteResult.site.id).toBe(createdSiteId);
    expect(siteResult.site.status).toBe('active');

    // Department
    const deptResult = await client.executeSuccess<{
      department: {
        id: string;
        siteId: string;
        tenantId: string;
        status: string;
      };
    }>({
      query: GET_DEPARTMENT,
      variables: { id: createdDeptId },
      token: tenantAToken,
    });
    expect(deptResult.department.id).toBe(createdDeptId);
    expect(deptResult.department.siteId).toBe(createdSiteId);

    // System
    const systemResult = await client.executeSuccess<{
      system: {
        id: string;
        siteId: string;
        departmentId: string;
        tenantId: string;
        status: string;
      };
    }>({
      query: GET_SYSTEM,
      variables: { id: createdSystemId },
      token: tenantAToken,
    });
    expect(systemResult.system.id).toBe(createdSystemId);
    expect(systemResult.system.siteId).toBe(createdSiteId);
    expect(systemResult.system.departmentId).toBe(createdDeptId);

    // Tank
    const tankResult = await client.executeSuccess<{
      tank: {
        id: string;
        departmentId: string;
        tenantId: string;
        volume: number;
      };
    }>({
      query: GET_TANK,
      variables: { id: createdTankId },
      token: tenantAToken,
    });
    expect(tankResult.tank.id).toBe(createdTankId);
    expect(tankResult.tank.departmentId).toBe(createdDeptId);
    expect(tankResult.tank.volume).toBeGreaterThan(0);
  });

  // =========================================================================
  // STEP 7: Tenant B cannot see ANY of the created entities
  // =========================================================================
  it('Step 7: Tenant B should not see any of Tenant A entities', async () => {
    // Site
    const siteResult = await client.execute<{
      site: { id: string } | null;
    }>({
      query: GET_SITE,
      variables: { id: createdSiteId },
      token: tenantBToken,
    });
    expect(siteResult.data?.site).toBeNull();

    // Department
    const deptResult = await client.execute<{
      department: { id: string } | null;
    }>({
      query: GET_DEPARTMENT,
      variables: { id: createdDeptId },
      token: tenantBToken,
    });
    expect(deptResult.data?.department).toBeNull();

    // System
    const systemResult = await client.execute<{
      system: { id: string } | null;
    }>({
      query: GET_SYSTEM,
      variables: { id: createdSystemId },
      token: tenantBToken,
    });
    expect(systemResult.data?.system).toBeNull();

    // Tank - may throw error instead of returning null (non-nullable query)
    const tankResult = await client.execute<{
      tank: { id: string } | null;
    }>({
      query: GET_TANK,
      variables: { id: createdTankId },
      token: tenantBToken,
    });
    // Either null or error is acceptable for cross-tenant isolation
    if (tankResult.data?.tank) {
      expect((tankResult.data.tank as Record<string, unknown>)['tenantId']).not.toBe(tenantAId);
    }
  });

  // =========================================================================
  // STEP 8: Teardown - reverse deletion order
  // =========================================================================
  it('Step 8: should teardown entities in reverse order: tank -> system -> department -> site', async () => {
    // Delete Tank
    const tankDeleteResult = await client.executeSuccess<{
      deleteTank: { success: boolean; id: string };
    }>({
      query: DELETE_TANK,
      variables: { id: createdTankId },
      token: tenantAToken,
    });
    expect(tankDeleteResult.deleteTank.success).toBe(true);

    // Delete System
    const systemDeleteResult = await client.executeSuccess<{
      deleteSystem: boolean;
    }>({
      query: DELETE_SYSTEM,
      variables: { id: createdSystemId, cascade: false },
      token: tenantAToken,
    });
    expect(systemDeleteResult.deleteSystem).toBe(true);

    // Delete Department
    const deptDeleteResult = await client.executeSuccess<{
      deleteDepartment: boolean;
    }>({
      query: DELETE_DEPARTMENT,
      variables: { id: createdDeptId, cascade: false },
      token: tenantAToken,
    });
    expect(deptDeleteResult.deleteDepartment).toBe(true);

    // Delete Site
    const siteDeleteResult = await client.executeSuccess<{
      deleteSite: boolean;
    }>({
      query: DELETE_SITE,
      variables: { id: createdSiteId, cascade: false },
      token: tenantAToken,
    });
    expect(siteDeleteResult.deleteSite).toBe(true);

    // Verify all soft-deleted or removed from DB
    const siteInDb = await db.findById('sites', createdSiteId, tenantAId);
    if (siteInDb) {
      expect(siteInDb['isDeleted']).toBe(true);
    }

    const deptInDb = await db.findById('departments', createdDeptId, tenantAId);
    if (deptInDb) {
      expect(deptInDb['isDeleted']).toBe(true);
    }

    const systemInDb = await db.findById('systems', createdSystemId, tenantAId);
    if (systemInDb) {
      expect(systemInDb['isDeleted']).toBe(true);
    }
  });
});
