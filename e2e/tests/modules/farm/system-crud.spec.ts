/**
 * System CRUD + Hierarchy E2E Tests
 *
 * Tests:
 * 1. createSystem -> system(id) -> systems(filter)
 * 2. System-Site relationship: system.siteId
 * 3. Parent-Child hierarchy: parentSystemId
 * 4. deleteSystem -> systemDeletePreview -> CASCADE effects
 * 5. Status transitions: OPERATIONAL -> MAINTENANCE -> OFFLINE
 * 6. Cross-tenant isolation
 */
import { assertDefined } from '../../../helpers/assertions';
import { TestDatabase } from '../../../helpers/db.helper';
import { GraphQLTestClient } from '../../../helpers/graphql-client';
import { generateCrossTenantTokens } from '../../../helpers/jwt.helper';

// ---------------------------------------------------------------------------
// GraphQL Fragments
// ---------------------------------------------------------------------------

const SYSTEM_FIELDS = `
  id
  tenantId
  siteId
  departmentId
  parentSystemId
  name
  code
  type
  status
  description
  totalVolumeM3
  maxBiomassKg
  tankCount
  isActive
  createdAt
  updatedAt
`;

const CREATE_SITE = `
  mutation CreateSite($input: CreateSiteInput!) {
    createSite(input: $input) {
      id
      name
    }
  }
`;

const CREATE_DEPARTMENT = `
  mutation CreateDepartment($input: CreateDepartmentInput!) {
    createDepartment(input: $input) {
      id
      name
    }
  }
`;

const CREATE_SYSTEM = `
  mutation CreateSystem($input: CreateSystemInput!) {
    createSystem(input: $input) {
      ${SYSTEM_FIELDS}
    }
  }
`;

const UPDATE_SYSTEM = `
  mutation UpdateSystem($input: UpdateSystemInput!) {
    updateSystem(input: $input) {
      ${SYSTEM_FIELDS}
    }
  }
`;

const DELETE_SYSTEM = `
  mutation DeleteSystem($id: ID!, $cascade: Boolean!) {
    deleteSystem(id: $id, cascade: $cascade)
  }
`;

const GET_SYSTEM = `
  query System($id: ID!) {
    system(id: $id) {
      ${SYSTEM_FIELDS}
    }
  }
`;

const LIST_SYSTEMS = `
  query Systems($filter: SystemFilterInput, $pagination: FarmPaginationInput) {
    systems(filter: $filter, pagination: $pagination) {
      items {
        ${SYSTEM_FIELDS}
      }
      total
    }
  }
`;

const SYSTEM_DELETE_PREVIEW = `
  query SystemDeletePreview($id: ID!) {
    systemDeletePreview(id: $id) {
      canDelete
      blockers
      affectedItems {
        childSystems {
          id
          name
        }
        totalCount
      }
    }
  }
`;

const CHILD_SYSTEMS = `
  query ChildSystems($parentSystemId: ID!) {
    childSystems(parentSystemId: $parentSystemId) {
      id
      name
      parentSystemId
    }
  }
`;

const ROOT_SYSTEMS = `
  query RootSystems($siteId: ID) {
    rootSystems(siteId: $siteId) {
      id
      name
      parentSystemId
    }
  }
`;

// ---------------------------------------------------------------------------
// Test Suite
// ---------------------------------------------------------------------------

describe('System CRUD + Hierarchy E2E', () => {
  const client = GraphQLTestClient.forFarmService();
  const db = new TestDatabase();
  let tenantAToken: string;
  let tenantAId: string;
  let tenantBToken: string;
  let tenantBId: string;
  let siteId: string;
  let departmentId: string;

  beforeAll(async () => {
    await db.connect();
    const tokens = generateCrossTenantTokens();
    tenantAToken = tokens.tenantA.token;
    tenantAId = tokens.tenantA.tenantId;
    tenantBToken = tokens.tenantB.token;
    tenantBId = tokens.tenantB.tenantId;

    // Prerequisite: create site
    const siteResult = await client.executeSuccess<{
      createSite: { id: string };
    }>({
      query: CREATE_SITE,
      variables: {
        input: {
          name: `Sys Test Site ${Date.now()}`,
          code: `SYS-${Date.now().toString(36).toUpperCase()}`,
        },
      },
      token: tenantAToken,
    });
    siteId = siteResult.createSite.id;

    // Prerequisite: create department
    const deptResult = await client.executeSuccess<{
      createDepartment: { id: string };
    }>({
      query: CREATE_DEPARTMENT,
      variables: {
        input: {
          siteId,
          name: `Sys Test Dept ${Date.now()}`,
          code: `SD-${Date.now().toString(36).toUpperCase()}`,
          type: 'production',
        },
      },
      token: tenantAToken,
    });
    departmentId = deptResult.createDepartment.id;
  });

  afterAll(async () => {
    await db.cleanupTenant(tenantAId, ['systems', 'departments', 'sites']);
    await db.cleanupTenant(tenantBId, ['systems']);
    await db.disconnect();
  });

  // -------------------------------------------------------------------------
  // Test 1: Full CRUD flow
  // -------------------------------------------------------------------------
  it('should create system, read by id, and find in filtered list', async () => {
    const input = {
      siteId,
      departmentId,
      name: `E2E System ${Date.now()}`,
      code: `SYS-${Date.now().toString(36).toUpperCase()}`,
      type: 'ras',
      description: 'E2E RAS system test',
      totalVolumeM3: 500.0,
      maxBiomassKg: 2000.0,
      tankCount: 10,
    };

    // CREATE
    const createResult = await client.executeSuccess<{
      createSystem: {
        id: string;
        tenantId: string;
        siteId: string;
        departmentId: string;
        name: string;
        code: string;
        type: string;
        status: string;
        isActive: boolean;
        totalVolumeM3: number;
        maxBiomassKg: number;
        tankCount: number;
      };
    }>({
      query: CREATE_SYSTEM,
      variables: { input },
      token: tenantAToken,
    });

    const sys = createResult.createSystem;
    expect(sys.id).toBeDefined();
    expect(sys.name).toBe(input.name);
    expect(sys.code).toBe(input.code);
    expect(sys.siteId).toBe(siteId);
    expect(sys.departmentId).toBe(departmentId);
    expect(sys.type).toBe('ras');
    expect(sys.status).toBe('operational');
    expect(sys.isActive).toBe(true);
    expect(sys.totalVolumeM3).toBe(500.0);
    expect(sys.maxBiomassKg).toBe(2000.0);
    expect(sys.tankCount).toBe(10);

    // READ by ID
    const readResult = await client.executeSuccess<{
      system: { id: string; name: string; siteId: string };
    }>({
      query: GET_SYSTEM,
      variables: { id: sys.id },
      token: tenantAToken,
    });

    expect(readResult.system.id).toBe(sys.id);
    expect(readResult.system.siteId).toBe(siteId);

    // DB VERIFY
    const dbRow = await db.findById('systems', sys.id, tenantAId);
    expect(dbRow).not.toBeNull();
    expect(assertDefined(dbRow)['name']).toBe(input.name);
    expect(assertDefined(dbRow)['siteId']).toBe(siteId);

    // LIST with filter
    const listResult = await client.executeSuccess<{
      systems: {
        items: Array<{ id: string; siteId: string }>;
        total: number;
      };
    }>({
      query: LIST_SYSTEMS,
      variables: { filter: { siteId } },
      token: tenantAToken,
    });

    const found = listResult.systems.items.find((s: { id: string }) => s.id === sys.id);
    expect(found).toBeDefined();
  });

  // -------------------------------------------------------------------------
  // Test 2: System-Site relationship
  // -------------------------------------------------------------------------
  it('should correctly reference site via siteId', async () => {
    const input = {
      siteId,
      name: `Site Rel System ${Date.now()}`,
      code: `SRS-${Date.now().toString(36).toUpperCase()}`,
      type: 'flow_through',
    };

    const createResult = await client.executeSuccess<{
      createSystem: { id: string; siteId: string };
    }>({
      query: CREATE_SYSTEM,
      variables: { input },
      token: tenantAToken,
    });

    expect(createResult.createSystem.siteId).toBe(siteId);

    // Verify FK in DB
    const dbRow = await db.findById('systems', createResult.createSystem.id, tenantAId);
    expect(assertDefined(dbRow)['siteId']).toBe(siteId);

    // Site should exist
    const siteExists = await db.exists('sites', siteId, tenantAId);
    expect(siteExists).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Test 3: Parent-Child hierarchy
  // -------------------------------------------------------------------------
  it('should support parent-child system hierarchy', async () => {
    // Create parent system
    const parentInput = {
      siteId,
      name: `Parent System ${Date.now()}`,
      code: `PS-${Date.now().toString(36).toUpperCase()}`,
      type: 'ras',
    };

    const parentResult = await client.executeSuccess<{
      createSystem: { id: string; name: string; parentSystemId: string | null };
    }>({
      query: CREATE_SYSTEM,
      variables: { input: parentInput },
      token: tenantAToken,
    });

    const parentId = parentResult.createSystem.id;
    expect(parentResult.createSystem.parentSystemId).toBeNull();

    // Create child system
    const childInput = {
      siteId,
      parentSystemId: parentId,
      name: `Child System ${Date.now()}`,
      code: `CS-${Date.now().toString(36).toUpperCase()}`,
      type: 'ras',
    };

    const childResult = await client.executeSuccess<{
      createSystem: { id: string; parentSystemId: string };
    }>({
      query: CREATE_SYSTEM,
      variables: { input: childInput },
      token: tenantAToken,
    });

    expect(childResult.createSystem.parentSystemId).toBe(parentId);

    // Query child systems
    const childrenResult = await client.executeSuccess<{
      childSystems: Array<{ id: string; parentSystemId: string }>;
    }>({
      query: CHILD_SYSTEMS,
      variables: { parentSystemId: parentId },
      token: tenantAToken,
    });

    const childFound = childrenResult.childSystems.find(
      (c: { id: string }) => c.id === childResult.createSystem.id,
    );
    expect(childFound).toBeDefined();
    expect(assertDefined(childFound).parentSystemId).toBe(parentId);

    // Root systems should include parent but not child
    const rootResult = await client.executeSuccess<{
      rootSystems: Array<{ id: string; parentSystemId: string | null }>;
    }>({
      query: ROOT_SYSTEMS,
      variables: { siteId },
      token: tenantAToken,
    });

    const parentInRoots = rootResult.rootSystems.find((s: { id: string }) => s.id === parentId);
    expect(parentInRoots).toBeDefined();

    const childInRoots = rootResult.rootSystems.find(
      (s: { id: string }) => s.id === childResult.createSystem.id,
    );
    expect(childInRoots).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // Test 4: Delete with preview showing CASCADE effects
  // -------------------------------------------------------------------------
  it('should show delete preview with child systems count', async () => {
    // Create parent + child
    const parentInput = {
      siteId,
      name: `DelPreview Parent ${Date.now()}`,
      code: `DP-${Date.now().toString(36).toUpperCase()}`,
      type: 'pond',
    };

    const parentResult = await client.executeSuccess<{
      createSystem: { id: string };
    }>({
      query: CREATE_SYSTEM,
      variables: { input: parentInput },
      token: tenantAToken,
    });

    const parentId = parentResult.createSystem.id;

    // Add a child
    const childInput = {
      siteId,
      parentSystemId: parentId,
      name: `DelPreview Child ${Date.now()}`,
      code: `DC-${Date.now().toString(36).toUpperCase()}`,
      type: 'pond',
    };

    await client.executeSuccess<{
      createSystem: { id: string };
    }>({
      query: CREATE_SYSTEM,
      variables: { input: childInput },
      token: tenantAToken,
    });

    // Preview
    const previewResult = await client.executeSuccess<{
      systemDeletePreview: {
        canDelete: boolean;
        affectedItems: {
          childSystems: Array<{ id: string; name: string }>;
          totalCount: number;
        };
      };
    }>({
      query: SYSTEM_DELETE_PREVIEW,
      variables: { id: parentId },
      token: tenantAToken,
    });

    expect(
      previewResult.systemDeletePreview.affectedItems.childSystems.length,
    ).toBeGreaterThanOrEqual(1);
    expect(previewResult.systemDeletePreview.affectedItems.totalCount).toBeGreaterThanOrEqual(1);

    // Delete with cascade
    const deleteResult = await client.executeSuccess<{
      deleteSystem: boolean;
    }>({
      query: DELETE_SYSTEM,
      variables: { id: parentId, cascade: true },
      token: tenantAToken,
    });

    expect(deleteResult.deleteSystem).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Test 5: Status transitions
  // -------------------------------------------------------------------------
  it('should support status transitions: OPERATIONAL -> MAINTENANCE -> OFFLINE', async () => {
    const input = {
      siteId,
      name: `Status System ${Date.now()}`,
      code: `SS-${Date.now().toString(36).toUpperCase()}`,
      type: 'ras',
      status: 'operational',
    };

    const createResult = await client.executeSuccess<{
      createSystem: { id: string; status: string };
    }>({
      query: CREATE_SYSTEM,
      variables: { input },
      token: tenantAToken,
    });

    const systemId = createResult.createSystem.id;
    expect(createResult.createSystem.status).toBe('operational');

    // OPERATIONAL -> MAINTENANCE
    const toMaintenance = await client.executeSuccess<{
      updateSystem: { status: string };
    }>({
      query: UPDATE_SYSTEM,
      variables: { input: { id: systemId, status: 'maintenance' } },
      token: tenantAToken,
    });
    expect(toMaintenance.updateSystem.status).toBe('maintenance');

    // MAINTENANCE -> OFFLINE
    const toOffline = await client.executeSuccess<{
      updateSystem: { status: string };
    }>({
      query: UPDATE_SYSTEM,
      variables: { input: { id: systemId, status: 'offline' } },
      token: tenantAToken,
    });
    expect(toOffline.updateSystem.status).toBe('offline');

    // Verify in DB
    const dbRow = await db.findById('systems', systemId, tenantAId);
    expect(assertDefined(dbRow)['status']).toBe('offline');
  });

  // -------------------------------------------------------------------------
  // Test 6: Cross-tenant isolation
  // -------------------------------------------------------------------------
  it('should not allow Tenant B to see Tenant A system', async () => {
    const input = {
      siteId,
      name: `Iso System ${Date.now()}`,
      code: `IOS-${Date.now().toString(36).toUpperCase()}`,
      type: 'ras',
    };

    const createResult = await client.executeSuccess<{
      createSystem: { id: string };
    }>({
      query: CREATE_SYSTEM,
      variables: { input },
      token: tenantAToken,
    });

    const systemId = createResult.createSystem.id;

    // Tenant B tries to read
    const readResult = await client.execute<{
      system: { id: string } | null;
    }>({
      query: GET_SYSTEM,
      variables: { id: systemId },
      token: tenantBToken,
    });

    expect(readResult.data?.system).toBeNull();

    // Tenant B lists systems
    const listResult = await client.executeSuccess<{
      systems: { items: Array<{ id: string }> };
    }>({
      query: LIST_SYSTEMS,
      variables: {},
      token: tenantBToken,
    });

    const found = listResult.systems.items.find((s: { id: string }) => s.id === systemId);
    expect(found).toBeUndefined();
  });
});
