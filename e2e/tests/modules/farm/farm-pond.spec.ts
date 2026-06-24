/**
 * Farm + Pond E2E Tests
 *
 * Tests:
 * 1. createFarm -> farm(id) -> farms(filter)
 * 2. Unique constraint: same tenant+name -> error
 * 3. createPond (farmId) -> pond(id) -> Farm-Pond relationship
 * 4. Cross-tenant isolation for farms
 * 5. Pond with waterType and status
 */
import { assertDefined } from '../../../helpers/assertions';
import { TestDatabase } from '../../../helpers/db.helper';
import { GraphQLTestClient } from '../../../helpers/graphql-client';
import { generateCrossTenantTokens } from '../../../helpers/jwt.helper';

// ---------------------------------------------------------------------------
// GraphQL Fragments
// ---------------------------------------------------------------------------

const FARM_FIELDS = `
  id
  name
  tenantId
  location {
    lat
    lng
  }
  address
  contactPerson
  contactPhone
  contactEmail
  description
  totalArea
  isActive
  createdAt
  updatedAt
`;

const POND_FIELDS = `
  id
  name
  farmId
  tenantId
  capacity
  depth
  surfaceArea
  waterType
  status
  isActive
  createdAt
  updatedAt
`;

const CREATE_FARM = `
  mutation CreateFarm($input: CreateFarmInput!) {
    createFarm(input: $input) {
      ${FARM_FIELDS}
    }
  }
`;

const GET_FARM = `
  query Farm($id: ID!) {
    farm(id: $id) {
      ${FARM_FIELDS}
    }
  }
`;

const LIST_FARMS = `
  query Farms($page: Int, $limit: Int, $isActive: Boolean, $search: String) {
    farms(page: $page, limit: $limit, isActive: $isActive, search: $search) {
      ${FARM_FIELDS}
    }
  }
`;

const CREATE_POND = `
  mutation CreatePond($input: CreatePondInput!) {
    createPond(input: $input) {
      ${POND_FIELDS}
    }
  }
`;

const GET_POND = `
  query Pond($id: ID!) {
    pond(id: $id) {
      ${POND_FIELDS}
    }
  }
`;

// ---------------------------------------------------------------------------
// Test Suite
// ---------------------------------------------------------------------------

describe('Farm + Pond E2E', () => {
  const client = GraphQLTestClient.forFarmService();
  const db = new TestDatabase();
  let tenantAToken: string;
  let tenantAId: string;
  let tenantBToken: string;
  let tenantBId: string;

  beforeAll(async () => {
    await db.connect();
    const tokens = generateCrossTenantTokens();
    tenantAToken = tokens.tenantA.token;
    tenantAId = tokens.tenantA.tenantId;
    tenantBToken = tokens.tenantB.token;
    tenantBId = tokens.tenantB.tenantId;
  });

  afterAll(async () => {
    await db.cleanupTenant(tenantAId, ['ponds', 'farms']);
    await db.cleanupTenant(tenantBId, ['ponds', 'farms']);
    await db.disconnect();
  });

  // -------------------------------------------------------------------------
  // Test 1: Full CRUD flow
  // -------------------------------------------------------------------------
  it('should create a farm, read by id, and find in list', async () => {
    const input = {
      name: `E2E Farm ${Date.now()}`,
      location: { lat: 40.9876, lng: 28.7654 },
      address: 'Istanbul, Turkey',
      contactPerson: 'E2E Tester',
      contactPhone: '+905551234567',
      contactEmail: 'farm@test.local',
      description: 'E2E test farm',
      totalArea: 50.5,
    };

    // CREATE
    const createResult = await client.executeSuccess<{
      createFarm: {
        id: string;
        name: string;
        tenantId: string;
        location: { lat: number; lng: number };
        address: string;
        contactPerson: string;
        isActive: boolean;
        totalArea: number;
      };
    }>({
      query: CREATE_FARM,
      variables: { input },
      token: tenantAToken,
    });

    const farm = createResult.createFarm;
    expect(farm.id).toBeDefined();
    expect(farm.name).toBe(input.name);
    expect(farm.location.lat).toBeCloseTo(input.location.lat, 2);
    expect(farm.location.lng).toBeCloseTo(input.location.lng, 2);
    expect(farm.address).toBe(input.address);
    expect(farm.contactPerson).toBe(input.contactPerson);
    expect(farm.isActive).toBe(true);
    expect(farm.totalArea).toBeCloseTo(50.5, 1);

    // READ by ID
    const readResult = await client.executeSuccess<{
      farm: { id: string; name: string; tenantId: string };
    }>({
      query: GET_FARM,
      variables: { id: farm.id },
      token: tenantAToken,
    });

    expect(readResult.farm.id).toBe(farm.id);
    expect(readResult.farm.name).toBe(input.name);

    // DB VERIFY
    const dbRow = await db.findById('farms', farm.id, tenantAId);
    expect(dbRow).not.toBeNull();
    expect(assertDefined(dbRow)['name']).toBe(input.name);
    expect(assertDefined(dbRow)['tenantId']).toBe(tenantAId);

    // LIST
    const listResult = await client.executeSuccess<{
      farms: Array<{ id: string; name: string }>;
    }>({
      query: LIST_FARMS,
      variables: { page: 1, limit: 50 },
      token: tenantAToken,
    });

    const found = listResult.farms.find((f: { id: string }) => f.id === farm.id);
    expect(found).toBeDefined();
  });

  // -------------------------------------------------------------------------
  // Test 2: Unique constraint on farm name
  // -------------------------------------------------------------------------
  it('should reject duplicate farm name within the same tenant', async () => {
    const sharedName = `Dup Farm ${Date.now()}`;

    const input1 = {
      name: sharedName,
      location: { lat: 41.0, lng: 29.0 },
    };

    await client.executeSuccess<{
      createFarm: { id: string };
    }>({
      query: CREATE_FARM,
      variables: { input: input1 },
      token: tenantAToken,
    });

    // Duplicate name
    const input2 = {
      name: sharedName,
      location: { lat: 42.0, lng: 30.0 },
    };

    const duplicateResult = await client.execute<{
      createFarm: { id: string };
    }>({
      query: CREATE_FARM,
      variables: { input: input2 },
      token: tenantAToken,
    });

    expect(duplicateResult.errors).toBeDefined();
    expect(assertDefined(duplicateResult.errors).length).toBeGreaterThan(0);
  });

  // -------------------------------------------------------------------------
  // Test 3: Create pond linked to farm
  // -------------------------------------------------------------------------
  it('should create a pond linked to a farm and verify relationship', async () => {
    // Create farm first
    const farmInput = {
      name: `Pond Farm ${Date.now()}`,
      location: { lat: 40.5, lng: 29.5 },
    };

    const farmResult = await client.executeSuccess<{
      createFarm: { id: string };
    }>({
      query: CREATE_FARM,
      variables: { input: farmInput },
      token: tenantAToken,
    });

    const farmId = farmResult.createFarm.id;

    // Create pond
    const pondInput = {
      name: `E2E Pond ${Date.now()}`,
      farmId,
      capacity: 500.0,
      waterType: 'freshwater',
      depth: 2.5,
      surfaceArea: 200.0,
      status: 'active',
    };

    const pondResult = await client.executeSuccess<{
      createPond: {
        id: string;
        name: string;
        farmId: string;
        capacity: number;
        waterType: string;
        depth: number;
        surfaceArea: number;
        status: string;
        isActive: boolean;
      };
    }>({
      query: CREATE_POND,
      variables: { input: pondInput },
      token: tenantAToken,
    });

    const pond = pondResult.createPond;
    expect(pond.id).toBeDefined();
    expect(pond.name).toBe(pondInput.name);
    expect(pond.farmId).toBe(farmId);
    expect(pond.capacity).toBeCloseTo(500.0, 1);
    expect(pond.waterType).toBe('freshwater');
    expect(pond.depth).toBeCloseTo(2.5, 1);
    expect(pond.surfaceArea).toBeCloseTo(200.0, 1);
    expect(pond.status).toBe('active');

    // READ pond by ID
    const readResult = await client.executeSuccess<{
      pond: { id: string; farmId: string; name: string };
    }>({
      query: GET_POND,
      variables: { id: pond.id },
      token: tenantAToken,
    });

    expect(readResult.pond.farmId).toBe(farmId);

    // DB VERIFY
    const dbRow = await db.findById('ponds', pond.id, tenantAId);
    expect(dbRow).not.toBeNull();
    expect(assertDefined(dbRow)['farmId']).toBe(farmId);
    expect(assertDefined(dbRow)['name']).toBe(pondInput.name);
  });

  // -------------------------------------------------------------------------
  // Test 4: Cross-tenant isolation
  // -------------------------------------------------------------------------
  it('should not allow Tenant B to see Tenant A farm', async () => {
    const input = {
      name: `Iso Farm ${Date.now()}`,
      location: { lat: 41.5, lng: 28.5 },
    };

    const createResult = await client.executeSuccess<{
      createFarm: { id: string };
    }>({
      query: CREATE_FARM,
      variables: { input },
      token: tenantAToken,
    });

    const farmId = createResult.createFarm.id;

    // Tenant B queries farm by id
    const readResult = await client.execute<{
      farm: { id: string } | null;
    }>({
      query: GET_FARM,
      variables: { id: farmId },
      token: tenantBToken,
    });

    // Should be null or error (farm is @Tenant scoped)
    if (readResult.data?.farm !== undefined && readResult.data?.farm !== null) {
      // If returned, it should not be from Tenant A
      expect((readResult.data.farm as Record<string, unknown>)['tenantId']).not.toBe(tenantAId);
    }

    // Tenant B lists farms
    const listResult = await client.executeSuccess<{
      farms: Array<{ id: string }>;
    }>({
      query: LIST_FARMS,
      variables: { page: 1, limit: 50 },
      token: tenantBToken,
    });

    const found = listResult.farms.find((f: { id: string }) => f.id === farmId);
    expect(found).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // Test 5: Pond with different water types and statuses
  // -------------------------------------------------------------------------
  it('should create ponds with different water types', async () => {
    const farmInput = {
      name: `WaterType Farm ${Date.now()}`,
      location: { lat: 39.0, lng: 27.0 },
    };

    const farmResult = await client.executeSuccess<{
      createFarm: { id: string };
    }>({
      query: CREATE_FARM,
      variables: { input: farmInput },
      token: tenantAToken,
    });

    const farmId = farmResult.createFarm.id;

    // Saltwater pond
    const saltwaterPond = await client.executeSuccess<{
      createPond: { id: string; waterType: string };
    }>({
      query: CREATE_POND,
      variables: {
        input: {
          name: `Salt Pond ${Date.now()}`,
          farmId,
          capacity: 300.0,
          waterType: 'saltwater',
        },
      },
      token: tenantAToken,
    });

    expect(saltwaterPond.createPond.waterType).toBe('saltwater');

    // Brackish pond
    const brackishPond = await client.executeSuccess<{
      createPond: { id: string; waterType: string };
    }>({
      query: CREATE_POND,
      variables: {
        input: {
          name: `Brackish Pond ${Date.now()}`,
          farmId,
          capacity: 250.0,
          waterType: 'brackish',
        },
      },
      token: tenantAToken,
    });

    expect(brackishPond.createPond.waterType).toBe('brackish');
  });
});
