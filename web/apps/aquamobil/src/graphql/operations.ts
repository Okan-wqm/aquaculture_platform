// ============================================================================
// AquaMobil GraphQL Operations
// ============================================================================
// Note: tenantId/userId come from @Tenant() and @CurrentUser() decorators on backend,
// NOT from GraphQL variables. They are extracted from JWT token.

// Queries - tenantId comes from X-Tenant-Id header (set from JWT)
export const GET_TANKS_WITH_BATCHES = `
  query GetTanksWithBatches {
    tanks {
      items {
        id
        name
        code
        volume
        status
        currentBiomass
        maxBiomass
        batchMetrics {
          batchId
          batchNumber
          pieces
          avgWeight
          biomass
          density
          capacityUsedPercent
          isOverCapacity
          daysSinceStocking
        }
      }
      total
    }
  }
`;

// Mutations - tenantId/userId extracted from JWT by backend decorators
export const RECORD_MORTALITY = `
  mutation RecordMortality($input: RecordMortalityInput!) {
    recordMortality(input: $input) {
      id
      batchNumber
      currentQuantity
      totalMortality
      retentionRate
      mortalityRate
    }
  }
`;

export const RECORD_CULL = `
  mutation RecordCull($input: RecordCullInput!) {
    recordCull(input: $input) {
      id
      batchNumber
      currentQuantity
      cullCount
      retentionRate
    }
  }
`;

export const CREATE_HARVEST_RECORD = `
  mutation CreateHarvestRecord($input: CreateHarvestRecordInput!) {
    createHarvestRecord(input: $input) {
      id
      recordCode
      lotNumber
      quantityHarvested
      totalBiomass
      averageWeight
      qualityGrade
      status
    }
  }
`;

// Auth
export const LOGIN = `
  mutation Login($input: LoginInput!) {
    login(input: $input) {
      accessToken
      refreshToken
      user {
        id
        email
        firstName
        lastName
        role
        tenantId
      }
    }
  }
`;

export const REFRESH_TOKEN = `
  mutation RefreshToken($refreshToken: String!) {
    refreshToken(token: $refreshToken) {
      accessToken
      refreshToken
    }
  }
`;
