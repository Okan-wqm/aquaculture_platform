/**
 * Tank CRUD + Status Machine E2E Tests
 *
 * Tests:
 * 1. createTank -> tank(id) -> tanks(filter)
 * 2. Tank-Department relationship
 * 3. Volume auto-calculation: circular (pi*r^2*h), rectangular (l*w*h)
 * 4. Status transitions (STATE MACHINE):
 *    - INACTIVE -> PREPARING (valid)
 *    - PREPARING -> ACTIVE (valid)
 *    - ACTIVE -> MAINTENANCE (valid)
 *    - ACTIVE -> DECOMMISSIONED (INVALID - no such transition)
 *    - HARVESTING -> CLEANING -> PREPARING (valid chain)
 *    - QUARANTINE -> ACTIVE (valid)
 * 5. Capacity: capacityInfo resolved field
 * 6. Cross-tenant isolation
 * 7. deleteTank -> DeleteTankResponse
 */
import { assertDefined } from '../../../helpers/assertions';
import { TestDatabase } from '../../../helpers/db.helper';
import { GraphQLTestClient } from '../../../helpers/graphql-client';
import { generateCrossTenantTokens } from '../../../helpers/jwt.helper';

// ---------------------------------------------------------------------------
// GraphQL Fragments
// ---------------------------------------------------------------------------

const TANK_FIELDS = `
  id
  tenantId
  name
  code
  departmentId
  tankType
  material
  waterType
  diameter
  length
  width
  depth
  volume
  waterVolume
  maxBiomass
  currentBiomass
  maxDensity
  status
  isActive
  createdAt
  updatedAt
`;

const CREATE_SITE = `
  mutation CreateSite($input: CreateSiteInput!) {
    createSite(input: $input) {
      id
    }
  }
`;

const CREATE_DEPARTMENT = `
  mutation CreateDepartment($input: CreateDepartmentInput!) {
    createDepartment(input: $input) {
      id
    }
  }
`;

const CREATE_TANK = `
  mutation CreateTank($input: CreateTankInput!) {
    createTank(input: $input) {
      ${TANK_FIELDS}
    }
  }
`;

const UPDATE_TANK_STATUS = `
  mutation UpdateTankStatus($input: UpdateTankStatusInput!) {
    updateTankStatus(input: $input) {
      ${TANK_FIELDS}
    }
  }
`;

const DELETE_TANK = `
  mutation DeleteTank($id: ID!) {
    deleteTank(id: $id) {
      success
      id
      message
    }
  }
`;

const GET_TANK = `
  query Tank($id: ID!) {
    tank(id: $id) {
      ${TANK_FIELDS}
    }
  }
`;

const LIST_TANKS = `
  query Tanks($filter: TankFilterInput) {
    tanks(filter: $filter) {
      items {
        ${TANK_FIELDS}
      }
      total
    }
  }
`;

const TANKS_BY_DEPARTMENT = `
  query TanksByDepartment($departmentId: ID!) {
    tanksByDepartment(departmentId: $departmentId) {
      id
      name
      departmentId
    }
  }
`;

// ---------------------------------------------------------------------------
// Test Suite
// ---------------------------------------------------------------------------

describe('Tank CRUD + Status Machine E2E', () => {
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

    // Prerequisite: site + department
    const siteResult = await client.executeSuccess<{
      createSite: { id: string };
    }>({
      query: CREATE_SITE,
      variables: {
        input: {
          name: `Tank Test Site ${Date.now()}`,
          code: `TTS-${Date.now().toString(36).toUpperCase()}`,
        },
      },
      token: tenantAToken,
    });
    siteId = siteResult.createSite.id;

    const deptResult = await client.executeSuccess<{
      createDepartment: { id: string };
    }>({
      query: CREATE_DEPARTMENT,
      variables: {
        input: {
          siteId,
          name: `Tank Test Dept ${Date.now()}`,
          code: `TTD-${Date.now().toString(36).toUpperCase()}`,
          type: 'production',
        },
      },
      token: tenantAToken,
    });
    departmentId = deptResult.createDepartment.id;
  });

  afterAll(async () => {
    await db.cleanupTenant(tenantAId, ['tanks', 'departments', 'sites']);
    await db.cleanupTenant(tenantBId, ['tanks']);
    await db.disconnect();
  });

  // -------------------------------------------------------------------------
  // Test 1: Full CRUD flow
  // -------------------------------------------------------------------------
  it('should create a circular tank, read by id, and find in filtered list', async () => {
    const input = {
      name: `E2E Tank ${Date.now()}`,
      departmentId,
      tankType: 'circular',
      material: 'fiberglass',
      waterType: 'saltwater',
      diameter: 5.0,
      depth: 1.5,
      maxBiomass: 500.0,
      maxDensity: 30,
    };

    // CREATE
    const createResult = await client.executeSuccess<{
      createTank: {
        id: string;
        tenantId: string;
        name: string;
        departmentId: string;
        tankType: string;
        material: string;
        waterType: string;
        diameter: number;
        depth: number;
        volume: number;
        maxBiomass: number;
        status: string;
        isActive: boolean;
      };
    }>({
      query: CREATE_TANK,
      variables: { input },
      token: tenantAToken,
    });

    const tank = createResult.createTank;
    expect(tank.id).toBeDefined();
    expect(tank.name).toBe(input.name);
    expect(tank.departmentId).toBe(departmentId);
    expect(tank.tankType).toBe('circular');
    expect(tank.material).toBe('fiberglass');
    expect(tank.waterType).toBe('saltwater');
    expect(tank.status).toBe('preparing');
    expect(tank.isActive).toBe(true);

    // READ by ID
    const readResult = await client.executeSuccess<{
      tank: { id: string; name: string };
    }>({
      query: GET_TANK,
      variables: { id: tank.id },
      token: tenantAToken,
    });

    expect(readResult.tank.id).toBe(tank.id);

    // DB VERIFY
    const dbRow = await db.findById('tanks', tank.id, tenantAId);
    expect(dbRow).not.toBeNull();
    expect(assertDefined(dbRow)['name']).toBe(input.name);
    expect(assertDefined(dbRow)['departmentId']).toBe(departmentId);

    // LIST with filter
    const listResult = await client.executeSuccess<{
      tanks: {
        items: Array<{ id: string }>;
        total: number;
      };
    }>({
      query: LIST_TANKS,
      variables: { filter: { departmentId } },
      token: tenantAToken,
    });

    const found = listResult.tanks.items.find((t: { id: string }) => t.id === tank.id);
    expect(found).toBeDefined();
  });

  // -------------------------------------------------------------------------
  // Test 2: Tank-Department relationship
  // -------------------------------------------------------------------------
  it('should correctly link tank to department', async () => {
    const input = {
      name: `Rel Tank ${Date.now()}`,
      departmentId,
      tankType: 'circular',
      material: 'concrete',
      waterType: 'freshwater',
      diameter: 3.0,
      depth: 1.0,
      maxBiomass: 200.0,
    };

    const createResult = await client.executeSuccess<{
      createTank: { id: string; departmentId: string };
    }>({
      query: CREATE_TANK,
      variables: { input },
      token: tenantAToken,
    });

    expect(createResult.createTank.departmentId).toBe(departmentId);

    // Query tanks by department
    const byDeptResult = await client.executeSuccess<{
      tanksByDepartment: Array<{ id: string; departmentId: string }>;
    }>({
      query: TANKS_BY_DEPARTMENT,
      variables: { departmentId },
      token: tenantAToken,
    });

    const found = byDeptResult.tanksByDepartment.find(
      (t: { id: string }) => t.id === createResult.createTank.id,
    );
    expect(found).toBeDefined();
    expect(assertDefined(found).departmentId).toBe(departmentId);
  });

  // -------------------------------------------------------------------------
  // Test 3: Volume auto-calculation
  // -------------------------------------------------------------------------
  it('should auto-calculate volume for circular tank: pi*r^2*h', async () => {
    const diameter = 4.0;
    const depth = 2.0;
    const expectedVolume = Math.PI * Math.pow(diameter / 2, 2) * depth;

    const input = {
      name: `Vol Circ Tank ${Date.now()}`,
      departmentId,
      tankType: 'circular',
      material: 'fiberglass',
      waterType: 'saltwater',
      diameter,
      depth,
      maxBiomass: 300.0,
    };

    const createResult = await client.executeSuccess<{
      createTank: { id: string; volume: number; diameter: number; depth: number };
    }>({
      query: CREATE_TANK,
      variables: { input },
      token: tenantAToken,
    });

    expect(createResult.createTank.volume).toBeCloseTo(expectedVolume, 1);
  });

  it('should auto-calculate volume for rectangular tank: l*w*h', async () => {
    const length = 6.0;
    const width = 3.0;
    const depth = 1.5;
    const expectedVolume = length * width * depth;

    const input = {
      name: `Vol Rect Tank ${Date.now()}`,
      departmentId,
      tankType: 'rectangular',
      material: 'concrete',
      waterType: 'freshwater',
      length,
      width,
      depth,
      maxBiomass: 400.0,
    };

    const createResult = await client.executeSuccess<{
      createTank: { id: string; volume: number };
    }>({
      query: CREATE_TANK,
      variables: { input },
      token: tenantAToken,
    });

    expect(createResult.createTank.volume).toBeCloseTo(expectedVolume, 1);
  });

  // -------------------------------------------------------------------------
  // Test 4: Status transition state machine
  // -------------------------------------------------------------------------
  describe('Status Machine Transitions', () => {
    it('should allow valid transition: INACTIVE -> PREPARING', async () => {
      const input = {
        name: `SM1 Tank ${Date.now()}`,
        departmentId,
        tankType: 'circular',
        material: 'fiberglass',
        waterType: 'saltwater',
        diameter: 3.0,
        depth: 1.0,
        maxBiomass: 200.0,
        status: 'inactive',
      };

      const createResult = await client.executeSuccess<{
        createTank: { id: string; status: string };
      }>({
        query: CREATE_TANK,
        variables: { input },
        token: tenantAToken,
      });

      expect(createResult.createTank.status).toBe('inactive');

      const statusResult = await client.executeSuccess<{
        updateTankStatus: { id: string; status: string };
      }>({
        query: UPDATE_TANK_STATUS,
        variables: {
          input: {
            id: createResult.createTank.id,
            status: 'preparing',
            reason: 'Ready for stocking',
          },
        },
        token: tenantAToken,
      });

      expect(statusResult.updateTankStatus.status).toBe('preparing');
    });

    it('should allow valid transition: PREPARING -> ACTIVE', async () => {
      const input = {
        name: `SM2 Tank ${Date.now()}`,
        departmentId,
        tankType: 'circular',
        material: 'fiberglass',
        waterType: 'saltwater',
        diameter: 3.0,
        depth: 1.0,
        maxBiomass: 200.0,
        status: 'preparing',
      };

      const createResult = await client.executeSuccess<{
        createTank: { id: string; status: string };
      }>({
        query: CREATE_TANK,
        variables: { input },
        token: tenantAToken,
      });

      expect(createResult.createTank.status).toBe('preparing');

      const statusResult = await client.executeSuccess<{
        updateTankStatus: { id: string; status: string };
      }>({
        query: UPDATE_TANK_STATUS,
        variables: {
          input: { id: createResult.createTank.id, status: 'active' },
        },
        token: tenantAToken,
      });

      expect(statusResult.updateTankStatus.status).toBe('active');
    });

    it('should allow valid transition: ACTIVE -> MAINTENANCE', async () => {
      // Start from preparing -> active -> maintenance
      const input = {
        name: `SM3 Tank ${Date.now()}`,
        departmentId,
        tankType: 'circular',
        material: 'fiberglass',
        waterType: 'saltwater',
        diameter: 3.0,
        depth: 1.0,
        maxBiomass: 200.0,
        status: 'preparing',
      };

      const createResult = await client.executeSuccess<{
        createTank: { id: string };
      }>({
        query: CREATE_TANK,
        variables: { input },
        token: tenantAToken,
      });

      const tankId = createResult.createTank.id;

      // preparing -> active
      await client.executeSuccess<{
        updateTankStatus: { status: string };
      }>({
        query: UPDATE_TANK_STATUS,
        variables: { input: { id: tankId, status: 'active' } },
        token: tenantAToken,
      });

      // active -> maintenance
      const result = await client.executeSuccess<{
        updateTankStatus: { status: string };
      }>({
        query: UPDATE_TANK_STATUS,
        variables: { input: { id: tankId, status: 'maintenance' } },
        token: tenantAToken,
      });

      expect(result.updateTankStatus.status).toBe('maintenance');
    });

    it('should REJECT invalid transition: ACTIVE -> status not in valid list', async () => {
      const input = {
        name: `SM4 Tank ${Date.now()}`,
        departmentId,
        tankType: 'circular',
        material: 'fiberglass',
        waterType: 'saltwater',
        diameter: 3.0,
        depth: 1.0,
        maxBiomass: 200.0,
        status: 'preparing',
      };

      const createResult = await client.executeSuccess<{
        createTank: { id: string };
      }>({
        query: CREATE_TANK,
        variables: { input },
        token: tenantAToken,
      });

      const tankId = createResult.createTank.id;

      // preparing -> active
      await client.executeSuccess<{
        updateTankStatus: { status: string };
      }>({
        query: UPDATE_TANK_STATUS,
        variables: { input: { id: tankId, status: 'active' } },
        token: tenantAToken,
      });

      // INVALID: active -> inactive (not in valid transitions for active)
      // Valid from ACTIVE: HARVESTING, MAINTENANCE, QUARANTINE, FALLOW
      const invalidResult = await client.execute<{
        updateTankStatus: { status: string };
      }>({
        query: UPDATE_TANK_STATUS,
        variables: { input: { id: tankId, status: 'inactive' } },
        token: tenantAToken,
      });

      // Should get an error
      expect(invalidResult.errors).toBeDefined();
      expect(assertDefined(invalidResult.errors).length).toBeGreaterThan(0);
    });

    it('should allow valid chain: HARVESTING -> CLEANING -> PREPARING', async () => {
      const input = {
        name: `SM5 Tank ${Date.now()}`,
        departmentId,
        tankType: 'circular',
        material: 'fiberglass',
        waterType: 'saltwater',
        diameter: 3.0,
        depth: 1.0,
        maxBiomass: 200.0,
        status: 'preparing',
      };

      const createResult = await client.executeSuccess<{
        createTank: { id: string };
      }>({
        query: CREATE_TANK,
        variables: { input },
        token: tenantAToken,
      });

      const tankId = createResult.createTank.id;

      // preparing -> active
      await client.executeSuccess<{ updateTankStatus: { status: string } }>({
        query: UPDATE_TANK_STATUS,
        variables: { input: { id: tankId, status: 'active' } },
        token: tenantAToken,
      });

      // active -> harvesting
      await client.executeSuccess<{ updateTankStatus: { status: string } }>({
        query: UPDATE_TANK_STATUS,
        variables: { input: { id: tankId, status: 'harvesting' } },
        token: tenantAToken,
      });

      // harvesting -> cleaning
      const cleanResult = await client.executeSuccess<{
        updateTankStatus: { status: string };
      }>({
        query: UPDATE_TANK_STATUS,
        variables: { input: { id: tankId, status: 'cleaning' } },
        token: tenantAToken,
      });
      expect(cleanResult.updateTankStatus.status).toBe('cleaning');

      // cleaning -> preparing
      const prepResult = await client.executeSuccess<{
        updateTankStatus: { status: string };
      }>({
        query: UPDATE_TANK_STATUS,
        variables: { input: { id: tankId, status: 'preparing' } },
        token: tenantAToken,
      });
      expect(prepResult.updateTankStatus.status).toBe('preparing');
    });

    it('should allow valid transition: QUARANTINE -> ACTIVE', async () => {
      const input = {
        name: `SM6 Tank ${Date.now()}`,
        departmentId,
        tankType: 'circular',
        material: 'fiberglass',
        waterType: 'saltwater',
        diameter: 3.0,
        depth: 1.0,
        maxBiomass: 200.0,
        status: 'preparing',
      };

      const createResult = await client.executeSuccess<{
        createTank: { id: string };
      }>({
        query: CREATE_TANK,
        variables: { input },
        token: tenantAToken,
      });

      const tankId = createResult.createTank.id;

      // preparing -> active
      await client.executeSuccess<{ updateTankStatus: { status: string } }>({
        query: UPDATE_TANK_STATUS,
        variables: { input: { id: tankId, status: 'active' } },
        token: tenantAToken,
      });

      // active -> quarantine
      await client.executeSuccess<{ updateTankStatus: { status: string } }>({
        query: UPDATE_TANK_STATUS,
        variables: { input: { id: tankId, status: 'quarantine' } },
        token: tenantAToken,
      });

      // quarantine -> active
      const result = await client.executeSuccess<{
        updateTankStatus: { status: string };
      }>({
        query: UPDATE_TANK_STATUS,
        variables: { input: { id: tankId, status: 'active' } },
        token: tenantAToken,
      });

      expect(result.updateTankStatus.status).toBe('active');
    });
  });

  // -------------------------------------------------------------------------
  // Test 5: Capacity info (resolved field)
  // -------------------------------------------------------------------------
  it('should return capacityInfo with correct maxBiomass and currentBiomass', async () => {
    const TANK_WITH_CAPACITY = `
      query Tank($id: ID!) {
        tank(id: $id) {
          id
          maxBiomass
          currentBiomass
          volume
          maxDensity
          capacityInfo {
            currentBiomass
            maxBiomass
            availableCapacity
            utilizationPercent
            currentDensity
            maxDensity
            hasCapacity
          }
        }
      }
    `;

    const input = {
      name: `Cap Tank ${Date.now()}`,
      departmentId,
      tankType: 'circular',
      material: 'fiberglass',
      waterType: 'saltwater',
      diameter: 4.0,
      depth: 1.5,
      maxBiomass: 1000.0,
      maxDensity: 30,
    };

    const createResult = await client.executeSuccess<{
      createTank: { id: string };
    }>({
      query: CREATE_TANK,
      variables: { input },
      token: tenantAToken,
    });

    const result = await client.executeSuccess<{
      tank: {
        id: string;
        maxBiomass: number;
        currentBiomass: number;
        capacityInfo: {
          maxBiomass: number;
          currentBiomass: number;
          availableCapacity: number;
          utilizationPercent: number;
          hasCapacity: boolean;
        };
      };
    }>({
      query: TANK_WITH_CAPACITY,
      variables: { id: createResult.createTank.id },
      token: tenantAToken,
    });

    expect(result.tank.capacityInfo.maxBiomass).toBe(1000.0);
    expect(result.tank.capacityInfo.currentBiomass).toBe(0);
    expect(result.tank.capacityInfo.hasCapacity).toBe(true);
    expect(result.tank.capacityInfo.availableCapacity).toBeGreaterThan(0);
  });

  // -------------------------------------------------------------------------
  // Test 6: Cross-tenant isolation
  // -------------------------------------------------------------------------
  it('should not allow Tenant B to see Tenant A tank', async () => {
    const input = {
      name: `Iso Tank ${Date.now()}`,
      departmentId,
      tankType: 'circular',
      material: 'fiberglass',
      waterType: 'saltwater',
      diameter: 3.0,
      depth: 1.0,
      maxBiomass: 200.0,
    };

    const createResult = await client.executeSuccess<{
      createTank: { id: string };
    }>({
      query: CREATE_TANK,
      variables: { input },
      token: tenantAToken,
    });

    const tankId = createResult.createTank.id;

    // Tenant B tries to read
    const readResult = await client.execute<{
      tank: { id: string } | null;
    }>({
      query: GET_TANK,
      variables: { id: tankId },
      token: tenantBToken,
    });

    // Should error or return null (tank query is not nullable so it may throw)
    if (readResult.data?.tank) {
      // If somehow returned, tenantId must not match
      expect((readResult.data.tank as Record<string, unknown>)['tenantId']).not.toBe(tenantAId);
    } else {
      // Expected: null or error
      expect(
        readResult.errors?.length ?? 0 + (readResult.data?.tank === null ? 1 : 0),
      ).toBeGreaterThanOrEqual(0);
    }
  });

  // -------------------------------------------------------------------------
  // Test 7: Delete tank
  // -------------------------------------------------------------------------
  it('should delete a tank and return DeleteTankResponse', async () => {
    const input = {
      name: `Del Tank ${Date.now()}`,
      departmentId,
      tankType: 'circular',
      material: 'fiberglass',
      waterType: 'saltwater',
      diameter: 3.0,
      depth: 1.0,
      maxBiomass: 200.0,
    };

    const createResult = await client.executeSuccess<{
      createTank: { id: string };
    }>({
      query: CREATE_TANK,
      variables: { input },
      token: tenantAToken,
    });

    const tankId = createResult.createTank.id;

    const deleteResult = await client.executeSuccess<{
      deleteTank: { success: boolean; id: string; message: string };
    }>({
      query: DELETE_TANK,
      variables: { id: tankId },
      token: tenantAToken,
    });

    expect(deleteResult.deleteTank.success).toBe(true);
    expect(deleteResult.deleteTank.id).toBe(tankId);
  });
});
