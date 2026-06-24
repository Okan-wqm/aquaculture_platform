/**
 * Site CRUD + Cross-Tenant E2E Tests
 *
 * Tests:
 * 1. createSite -> site(id) -> DB verify -> sites(filter) -> listed
 * 2. updateSite (name, status) -> site(id) -> updated values
 * 3. deleteSite -> siteDeletePreview -> sites -> removed
 * 4. Cross-tenant isolation: Tenant B cannot see Tenant A's site
 * 5. Status transitions: ACTIVE -> MAINTENANCE -> INACTIVE -> CLOSED
 * 6. Unique constraint: same tenant+code or tenant+name -> error
 */
import { assertDefined } from '../../../helpers/assertions';
import { TestDatabase } from '../../../helpers/db.helper';
import { GraphQLTestClient } from '../../../helpers/graphql-client';
import { generateCrossTenantTokens } from '../../../helpers/jwt.helper';

// ---------------------------------------------------------------------------
// GraphQL Fragments
// ---------------------------------------------------------------------------

const SITE_FIELDS = `
  id
  tenantId
  name
  code
  description
  type
  status
  isActive
  timezone
  createdAt
  updatedAt
`;

const CREATE_SITE = `
  mutation CreateSite($input: CreateSiteInput!) {
    createSite(input: $input) {
      ${SITE_FIELDS}
    }
  }
`;

const UPDATE_SITE = `
  mutation UpdateSite($input: UpdateSiteInput!) {
    updateSite(input: $input) {
      ${SITE_FIELDS}
    }
  }
`;

const DELETE_SITE = `
  mutation DeleteSite($id: ID!, $cascade: Boolean!) {
    deleteSite(id: $id, cascade: $cascade)
  }
`;

const GET_SITE = `
  query Site($id: ID!) {
    site(id: $id) {
      ${SITE_FIELDS}
    }
  }
`;

const LIST_SITES = `
  query Sites($filter: SiteFilterInput, $pagination: FarmPaginationInput) {
    sites(filter: $filter, pagination: $pagination) {
      items {
        ${SITE_FIELDS}
      }
      total
    }
  }
`;

const SITE_DELETE_PREVIEW = `
  query SiteDeletePreview($id: ID!) {
    siteDeletePreview(id: $id) {
      canDelete
      blockers
      affectedItems {
        totalCount
      }
    }
  }
`;

// ---------------------------------------------------------------------------
// Test Suite
// ---------------------------------------------------------------------------

describe('Site CRUD + Cross-Tenant E2E', () => {
  const client = GraphQLTestClient.forFarmService();
  const db = new TestDatabase();
  const createdIds: string[] = [];
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
    // Cleanup created test data
    if (createdIds.length > 0) {
      await db.cleanupTenant(tenantAId, ['sites']);
      await db.cleanupTenant(tenantBId, ['sites']);
    }
    await db.disconnect();
  });

  // -------------------------------------------------------------------------
  // Test 1: Full CRUD flow
  // -------------------------------------------------------------------------
  it('should create a site, read it by id, verify in DB, and find in list', async () => {
    const input = {
      name: `E2E Test Site ${Date.now()}`,
      code: `TS-${Date.now().toString(36).toUpperCase()}`,
      description: 'E2E test site for CRUD validation',
      timezone: 'Europe/Istanbul',
    };

    // CREATE
    const createResult = await client.executeSuccess<{
      createSite: {
        id: string;
        tenantId: string;
        name: string;
        code: string;
        description: string;
        status: string;
        isActive: boolean;
        timezone: string;
      };
    }>({
      query: CREATE_SITE,
      variables: { input },
      token: tenantAToken,
    });

    const site = createResult.createSite;
    createdIds.push(site.id);

    expect(site.id).toBeDefined();
    expect(site.name).toBe(input.name);
    expect(site.code).toBe(input.code);
    expect(site.description).toBe(input.description);
    expect(site.status).toBe('active');
    expect(site.isActive).toBe(true);

    // READ by ID
    const readResult = await client.executeSuccess<{
      site: {
        id: string;
        name: string;
        code: string;
        status: string;
        tenantId: string;
      };
    }>({
      query: GET_SITE,
      variables: { id: site.id },
      token: tenantAToken,
    });

    expect(readResult.site).toBeDefined();
    expect(readResult.site.id).toBe(site.id);
    expect(readResult.site.name).toBe(input.name);

    // VERIFY in DB
    const dbRow = await db.findById('sites', site.id, tenantAId);
    expect(dbRow).not.toBeNull();
    expect(assertDefined(dbRow)['name']).toBe(input.name);
    expect(assertDefined(dbRow)['code']).toBe(input.code);
    expect(assertDefined(dbRow)['tenantId']).toBe(tenantAId);

    // LIST with filter
    const listResult = await client.executeSuccess<{
      sites: {
        items: Array<{ id: string; name: string }>;
        total: number;
      };
    }>({
      query: LIST_SITES,
      variables: { filter: { isActive: true } },
      token: tenantAToken,
    });

    const found = listResult.sites.items.find((s: { id: string }) => s.id === site.id);
    expect(found).toBeDefined();
  });

  // -------------------------------------------------------------------------
  // Test 2: Update site
  // -------------------------------------------------------------------------
  it('should update site name and status', async () => {
    // First create a site
    const input = {
      name: `Update Test ${Date.now()}`,
      code: `UP-${Date.now().toString(36).toUpperCase()}`,
    };

    const createResult = await client.executeSuccess<{
      createSite: { id: string; name: string; status: string };
    }>({
      query: CREATE_SITE,
      variables: { input },
      token: tenantAToken,
    });

    const siteId = createResult.createSite.id;
    createdIds.push(siteId);

    // UPDATE
    const updateInput = {
      id: siteId,
      name: `Updated Name ${Date.now()}`,
      status: 'maintenance',
    };

    const updateResult = await client.executeSuccess<{
      updateSite: { id: string; name: string; status: string };
    }>({
      query: UPDATE_SITE,
      variables: { input: updateInput },
      token: tenantAToken,
    });

    expect(updateResult.updateSite.name).toBe(updateInput.name);
    expect(updateResult.updateSite.status).toBe('maintenance');

    // Verify via GET
    const getResult = await client.executeSuccess<{
      site: { id: string; name: string; status: string };
    }>({
      query: GET_SITE,
      variables: { id: siteId },
      token: tenantAToken,
    });

    expect(getResult.site.name).toBe(updateInput.name);
    expect(getResult.site.status).toBe('maintenance');
  });

  // -------------------------------------------------------------------------
  // Test 3: Delete site with preview
  // -------------------------------------------------------------------------
  it('should preview deletion and then soft-delete a site', async () => {
    const input = {
      name: `Delete Test ${Date.now()}`,
      code: `DL-${Date.now().toString(36).toUpperCase()}`,
    };

    const createResult = await client.executeSuccess<{
      createSite: { id: string };
    }>({
      query: CREATE_SITE,
      variables: { input },
      token: tenantAToken,
    });

    const siteId = createResult.createSite.id;
    createdIds.push(siteId);

    // DELETE PREVIEW
    const previewResult = await client.executeSuccess<{
      siteDeletePreview: {
        canDelete: boolean;
        blockers: string[];
        affectedItems: { totalCount: number };
      };
    }>({
      query: SITE_DELETE_PREVIEW,
      variables: { id: siteId },
      token: tenantAToken,
    });

    expect(previewResult.siteDeletePreview.canDelete).toBe(true);

    // DELETE
    const deleteResult = await client.executeSuccess<{
      deleteSite: boolean;
    }>({
      query: DELETE_SITE,
      variables: { id: siteId, cascade: false },
      token: tenantAToken,
    });

    expect(deleteResult.deleteSite).toBe(true);

    // VERIFY: site should be soft-deleted (not returned by default queries)
    const getResult = await client.execute<{
      site: { id: string } | null;
    }>({
      query: GET_SITE,
      variables: { id: siteId },
      token: tenantAToken,
    });

    // Either null or the query filters soft-deleted records
    const siteAfterDelete = getResult.data?.site;
    if (siteAfterDelete !== null && siteAfterDelete !== undefined) {
      // If returned, verify DB shows isDeleted=true
      const dbRow = await db.findById('sites', siteId, tenantAId);
      expect(assertDefined(dbRow)['isDeleted']).toBe(true);
    }
  });

  // -------------------------------------------------------------------------
  // Test 4: Cross-tenant isolation
  // -------------------------------------------------------------------------
  it('should not allow Tenant B to see Tenant A site', async () => {
    const input = {
      name: `Isolation Test ${Date.now()}`,
      code: `IS-${Date.now().toString(36).toUpperCase()}`,
    };

    const createResult = await client.executeSuccess<{
      createSite: { id: string; tenantId: string };
    }>({
      query: CREATE_SITE,
      variables: { input },
      token: tenantAToken,
    });

    const siteId = createResult.createSite.id;
    createdIds.push(siteId);

    // Tenant B tries to read Tenant A's site
    const tenantBResult = await client.execute<{
      site: { id: string } | null;
    }>({
      query: GET_SITE,
      variables: { id: siteId },
      token: tenantBToken,
    });

    // Site should NOT be visible to Tenant B
    const siteFromB = tenantBResult.data?.site;
    expect(siteFromB).toBeNull();

    // Tenant B list should NOT contain Tenant A's site
    const listResult = await client.executeSuccess<{
      sites: { items: Array<{ id: string }> };
    }>({
      query: LIST_SITES,
      variables: {},
      token: tenantBToken,
    });

    const foundInB = listResult.sites.items.find((s: { id: string }) => s.id === siteId);
    expect(foundInB).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // Test 5: Status transitions
  // -------------------------------------------------------------------------
  it('should support status transitions: ACTIVE -> MAINTENANCE -> INACTIVE -> CLOSED', async () => {
    const input = {
      name: `Status Test ${Date.now()}`,
      code: `ST-${Date.now().toString(36).toUpperCase()}`,
      status: 'active' as const,
    };

    const createResult = await client.executeSuccess<{
      createSite: { id: string; status: string };
    }>({
      query: CREATE_SITE,
      variables: { input },
      token: tenantAToken,
    });

    const siteId = createResult.createSite.id;
    createdIds.push(siteId);
    expect(createResult.createSite.status).toBe('active');

    // ACTIVE -> MAINTENANCE
    const toMaintenance = await client.executeSuccess<{
      updateSite: { status: string };
    }>({
      query: UPDATE_SITE,
      variables: { input: { id: siteId, status: 'maintenance' } },
      token: tenantAToken,
    });
    expect(toMaintenance.updateSite.status).toBe('maintenance');

    // MAINTENANCE -> INACTIVE
    const toInactive = await client.executeSuccess<{
      updateSite: { status: string };
    }>({
      query: UPDATE_SITE,
      variables: { input: { id: siteId, status: 'inactive' } },
      token: tenantAToken,
    });
    expect(toInactive.updateSite.status).toBe('inactive');

    // INACTIVE -> CLOSED
    const toClosed = await client.executeSuccess<{
      updateSite: { status: string };
    }>({
      query: UPDATE_SITE,
      variables: { input: { id: siteId, status: 'closed' } },
      token: tenantAToken,
    });
    expect(toClosed.updateSite.status).toBe('closed');

    // Verify final state in DB
    const dbRow = await db.findById('sites', siteId, tenantAId);
    expect(assertDefined(dbRow)['status']).toBe('closed');
  });

  // -------------------------------------------------------------------------
  // Test 6: Unique constraint
  // -------------------------------------------------------------------------
  it('should reject duplicate code within the same tenant', async () => {
    const sharedCode = `UC-${Date.now().toString(36).toUpperCase()}`;

    const input1 = {
      name: `Unique Test A ${Date.now()}`,
      code: sharedCode,
    };

    const createResult = await client.executeSuccess<{
      createSite: { id: string };
    }>({
      query: CREATE_SITE,
      variables: { input: input1 },
      token: tenantAToken,
    });
    createdIds.push(createResult.createSite.id);

    // Same code, different name -> should fail due to unique(tenantId, code)
    const input2 = {
      name: `Unique Test B ${Date.now() + 1}`,
      code: sharedCode,
    };

    const duplicateResult = await client.execute<{
      createSite: { id: string };
    }>({
      query: CREATE_SITE,
      variables: { input: input2 },
      token: tenantAToken,
    });

    // Should have errors
    expect(duplicateResult.errors).toBeDefined();
    expect(assertDefined(duplicateResult.errors).length).toBeGreaterThan(0);
  });

  it('should reject duplicate name within the same tenant', async () => {
    const sharedName = `Duplicate Name ${Date.now()}`;

    const input1 = {
      name: sharedName,
      code: `DN1-${Date.now().toString(36).toUpperCase()}`,
    };

    const createResult = await client.executeSuccess<{
      createSite: { id: string };
    }>({
      query: CREATE_SITE,
      variables: { input: input1 },
      token: tenantAToken,
    });
    createdIds.push(createResult.createSite.id);

    const input2 = {
      name: sharedName,
      code: `DN2-${Date.now().toString(36).toUpperCase()}`,
    };

    const duplicateResult = await client.execute<{
      createSite: { id: string };
    }>({
      query: CREATE_SITE,
      variables: { input: input2 },
      token: tenantAToken,
    });

    expect(duplicateResult.errors).toBeDefined();
    expect(assertDefined(duplicateResult.errors).length).toBeGreaterThan(0);
  });
});
