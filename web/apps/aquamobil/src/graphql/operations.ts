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

// Feeding queries and mutations
export const GET_TODAYS_FEEDING_PLAN = `
  query TodaysFeedingPlan($date: Date!) {
    dailyFeedingExecutions(date: $date) {
      id
      equipmentId
      equipmentName
      equipmentCode
      calculations
      plannedFeedKg
      actualFeedKg
      status
      hasTransitionWarning
    }
  }
`;

export const RECORD_DAILY_FEEDING = `
  mutation RecordDailyFeeding($input: RecordDailyFeedingInput!) {
    recordDailyFeeding(input: $input) {
      id
      actualFeedKg
      status
      feedingMethod
      feederName
    }
  }
`;

// QUAL-01: AUTH mutations (LOGIN, REFRESH_TOKEN) are intentionally defined inline
// in hooks/useAuth.tsx where they are used. The duplicate exports previously in this
// file have been removed to avoid maintenance drift between two copies.
