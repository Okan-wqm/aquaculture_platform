/**
 * Farm E2E Test Helpers
 *
 * GraphQL query/mutation builder ve ortak yardimci fonksiyonlar.
 * Tum farm e2e testleri bu helper'lari kullanir.
 *
 * @module E2E/Farm/Helpers
 */

import { assertDefined } from '../../../helpers/assertions';

// ============================================================================
// CONSTANTS
// ============================================================================

export const GATEWAY_URL = process.env.GATEWAY_URL || 'http://localhost:4000/graphql';

export const TENANT_A_ID = 'e2e-tenant-farm-a';
export const TENANT_B_ID = 'e2e-tenant-farm-b';
export const USER_A_ID = 'e2e-user-farm-a';
export const USER_B_ID = 'e2e-user-farm-b';

// ============================================================================
// GRAPHQL CLIENT
// ============================================================================

interface GraphQLResponse<T = Record<string, unknown>> {
  data?: T;
  errors?: Array<{
    message: string;
    extensions?: Record<string, unknown>;
    path?: string[];
  }>;
}

/**
 * GraphQL istegi gonderir. Tenant ve user header'lari otomatik eklenir.
 */
export async function gqlRequest<T = Record<string, unknown>>(
  query: string,
  variables: Record<string, unknown> = {},
  tenantId: string = TENANT_A_ID,
  userId: string = USER_A_ID,
): Promise<GraphQLResponse<T>> {
  const response = await fetch(GATEWAY_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-tenant-id': tenantId,
      'x-user-id': userId,
      'x-user-roles': 'tenant_admin,module_manager',
    },
    body: JSON.stringify({ query, variables }),
  });

  return response.json() as Promise<GraphQLResponse<T>>;
}

/**
 * Basarili response beklenir; hata varsa test fail eder.
 */
export async function gqlExpectSuccess<T = Record<string, unknown>>(
  query: string,
  variables: Record<string, unknown> = {},
  tenantId?: string,
  userId?: string,
): Promise<T> {
  const result = await gqlRequest<T>(query, variables, tenantId, userId);
  if (result.errors && result.errors.length > 0) {
    throw new Error(`GraphQL errors: ${result.errors.map((e) => e.message).join('; ')}`);
  }
  expect(result.data).toBeDefined();
  return assertDefined(result.data);
}

/**
 * Hata response beklenir; basari gelirse test fail eder.
 */
export async function gqlExpectError(
  query: string,
  variables: Record<string, unknown> = {},
  tenantId?: string,
  userId?: string,
): Promise<Array<{ message: string; extensions?: Record<string, unknown> }>> {
  const result = await gqlRequest(query, variables, tenantId, userId);
  expect(result.errors).toBeDefined();
  const errors = assertDefined(result.errors);
  expect(errors.length).toBeGreaterThan(0);
  return errors;
}

// ============================================================================
// DB HELPERS (direct Postgres via raw query through gateway)
// ============================================================================

/**
 * Benzersiz test ID prefix'i uretir (collision onleme).
 */
export function uniqueId(): string {
  return `e2e-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
}

/**
 * Benzersiz species code uretir.
 */
export function uniqueSpeciesCode(): string {
  return `SP-${Date.now().toString(36).toUpperCase()}`;
}

/**
 * Benzersiz scientific name uretir.
 */
export function uniqueScientificName(): string {
  return `Testus ${Date.now().toString(36)}ensis`;
}

/**
 * A built GraphQL operation: the query/mutation document plus its variables.
 */
export interface GraphQLOperation<TVariables = Record<string, unknown>> {
  query: string;
  variables: TVariables;
}

// ============================================================================
// GRAPHQL FRAGMENTS
// ============================================================================

export const SPECIES_FIELDS = `
  id
  tenantId
  scientificName
  commonName
  localName
  code
  description
  category
  waterType
  family
  genus
  status
  isActive
  isCleanerFish
  cleanerFishType
  tags
  notes
  createdAt
  updatedAt
`;

export const BATCH_FIELDS = `
  id
  tenantId
  batchNumber
  name
  description
  speciesId
  strain
  inputType
  batchType
  initialQuantity
  currentQuantity
  totalMortality
  cullCount
  status
  statusChangedAt
  statusReason
  isActive
  stockedAt
  expectedHarvestDate
  purchaseCost
  currency
  notes
  createdAt
  updatedAt
`;

export const BATCH_PERFORMANCE_FIELDS = `
  batchId
  batchNumber
  speciesName
  initialQuantity
  currentQuantity
  initialBiomassKg
  currentBiomassKg
  initialAvgWeightG
  currentAvgWeightG
  weightGainG
  weightGainPercent
  totalMortality
  mortalityRate
  survivalRate
  retentionRate
  cullCount
  sgr
  daysInProduction
  avgDailyGrowthG
  totalFeedConsumedKg
  totalFeedCost
  purchaseCost
  totalCost
  costPerKg
  costPerFish
  performanceIndex
  performanceStatus
`;

export const BATCH_HISTORY_FIELDS = `
  id
  eventType
  timestamp
  description
  details
  performedBy
  tankId
  tankCode
  quantityChange
  biomassChangeKg
`;

export const AVAILABLE_TANK_FIELDS = `
  id
  code
  name
  volume
  maxBiomass
  currentBiomass
  availableCapacity
  currentCount
  maxDensity
  currentDensity
  status
  departmentId
  departmentName
`;

// ============================================================================
// SPECIES HELPERS
// ============================================================================

export interface CreateSpeciesVars {
  scientificName?: string;
  commonName?: string;
  localName?: string;
  code?: string;
  category?: string;
  waterType?: string;
  status?: string;
  isCleanerFish?: boolean;
  cleanerFishType?: string;
  tags?: string[];
  notes?: string;
}

export interface CreateSpeciesInput {
  scientificName: string;
  commonName: string;
  localName?: string;
  code: string;
  category: string;
  waterType: string;
  status: string;
  tags?: string[];
  notes?: string;
}

export function buildCreateSpeciesMutation(
  vars: CreateSpeciesVars = {},
): GraphQLOperation<{ input: CreateSpeciesInput }> {
  const input: CreateSpeciesInput = {
    scientificName: vars.scientificName || uniqueScientificName(),
    commonName: vars.commonName || `Test Fish ${uniqueId()}`,
    localName: vars.localName,
    code: vars.code || uniqueSpeciesCode(),
    category: vars.category || 'FISH',
    waterType: vars.waterType || 'SALTWATER',
    status: vars.status || 'ACTIVE',
    tags: vars.tags,
    notes: vars.notes,
  };

  return {
    query: `
      mutation CreateSpecies($input: CreateSpeciesInput!) {
        createSpecies(input: $input) {
          ${SPECIES_FIELDS}
        }
      }
    `,
    variables: { input },
  };
}

/**
 * Species olusturur ve doner.
 */
export async function createTestSpecies(
  overrides: CreateSpeciesVars = {},
  tenantId?: string,
): Promise<Record<string, unknown>> {
  const { query, variables } = buildCreateSpeciesMutation(overrides);
  const data = await gqlExpectSuccess<{ createSpecies: Record<string, unknown> }>(
    query,
    variables,
    tenantId,
  );
  return data.createSpecies;
}

// ============================================================================
// BATCH HELPERS
// ============================================================================

export interface CreateBatchVars {
  name?: string;
  speciesId: string;
  inputType?: string;
  initialQuantity?: number;
  initialAvgWeightG?: number;
  initialTotalBiomassKg?: number;
  stockedAt?: string;
  expectedHarvestDate?: string;
  targetFCR?: number;
  initialLocations?: Array<{
    locationType: string;
    tankId?: string;
    pondId?: string;
    quantity: number;
    biomass: number;
  }>;
  notes?: string;
}

export interface CreateBatchInput {
  name?: string;
  speciesId: string;
  inputType: string;
  initialQuantity: number;
  initialWeight: {
    avgWeight: number;
    totalBiomass: number;
  };
  stockedAt: string;
  expectedHarvestDate?: string;
  targetFCR: number;
  initialLocations: Array<{
    locationType: string;
    tankId?: string;
    pondId?: string;
    quantity: number;
    biomass: number;
  }>;
  notes?: string;
}

export function buildCreateBatchMutation(
  vars: CreateBatchVars,
): GraphQLOperation<{ input: CreateBatchInput }> {
  const input: CreateBatchInput = {
    name: vars.name,
    speciesId: vars.speciesId,
    inputType: vars.inputType || 'FRY',
    initialQuantity: vars.initialQuantity || 10000,
    initialWeight: {
      avgWeight: vars.initialAvgWeightG || 5.0,
      totalBiomass: vars.initialTotalBiomassKg || 50.0,
    },
    stockedAt: vars.stockedAt || assertDefined(new Date().toISOString().split('T')[0]),
    expectedHarvestDate: vars.expectedHarvestDate,
    targetFCR: vars.targetFCR || 1.5,
    initialLocations: vars.initialLocations || [],
    notes: vars.notes,
  };

  return {
    query: `
      mutation CreateBatch($input: CreateBatchInput!) {
        createBatch(input: $input) {
          ${BATCH_FIELDS}
        }
      }
    `,
    variables: { input },
  };
}

/**
 * Batch olusturur ve doner.
 */
export async function createTestBatch(
  vars: CreateBatchVars,
  tenantId?: string,
): Promise<Record<string, unknown>> {
  const { query, variables } = buildCreateBatchMutation(vars);
  const data = await gqlExpectSuccess<{ createBatch: Record<string, unknown> }>(
    query,
    variables,
    tenantId,
  );
  return data.createBatch;
}
