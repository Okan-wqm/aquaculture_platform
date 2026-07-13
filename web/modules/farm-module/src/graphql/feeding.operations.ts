/**
 * Feeding Records & Inventory GraphQL Operations
 *
 * All GraphQL queries and mutations for feeding record management
 * and feed inventory operations.
 * Maps to the backend feeding.resolver.ts operations.
 *
 * @module FarmModule/GraphQL
 */

// ============================================================================
// FRAGMENTS
// ============================================================================

const FEEDING_RECORD_FIELDS = `
  id
  tenantId
  batchId
  tankId
  feedingDate
  feedingTime
  feedingSequence
  totalMealsToday
  feedId
  feedBatchNumber
  plannedAmount
  actualAmount
  variance
  variancePercent
  wasteAmount
  environment
  fishBehavior
  feedingMethod
  equipmentId
  feedingDurationMinutes
  feedCost
  feedCostDecimal
  currency
  fedBy
  verifiedBy
  verifiedAt
  notes
  skipReason
  createdAt
  updatedAt
  isBelowPlan
  isVarianceAcceptable
`;

const FEED_INVENTORY_FIELDS = `
  id
  tenantId
  feedId
  siteId
  departmentId
  quantityKg
  minStockKg
  status
  lotNumber
  manufacturingDate
  expiryDate
  receivedDate
  unitPricePerKg
  unitPricePerKgDecimal
  totalValue
  totalValueDecimal
  currency
  storageLocation
  notes
  createdAt
  updatedAt
  createdBy
  isLowStock
  isExpired
  daysUntilExpiry
`;

// ============================================================================
// QUERIES
// ============================================================================

/**
 * Get a single feeding record by ID
 */
export const FEEDING_RECORD_QUERY = `
  query FeedingRecord($id: ID!) {
    feedingRecord(id: $id) {
      ${FEEDING_RECORD_FIELDS}
    }
  }
`;

/**
 * List feeding records with filters and pagination
 */
export const FEEDING_RECORDS_QUERY = `
  query FeedingRecords($filter: FeedingRecordFilterInput, $pagination: FeedingPaginationInput) {
    feedingRecords(filter: $filter, pagination: $pagination) {
      items {
        ${FEEDING_RECORD_FIELDS}
      }
      total
      page
      limit
      totalPages
      hasNextPage
      hasPreviousPage
    }
  }
`;

/**
 * Get daily feeding plan for a site
 */
export const DAILY_FEEDING_PLAN_QUERY = `
  query DailyFeedingPlan($siteId: ID!, $date: DateTime) {
    dailyFeedingPlan(siteId: $siteId, date: $date) {
      date
      siteId
      plannedFeedings {
        batchId
        batchCode
        tankId
        tankCode
        feedId
        feedName
        plannedAmountKg
        actualAmountKg
        mealsPlanned
        mealsCompleted
        isComplete
      }
      totalPlannedKg
      totalActualKg
      completionPercent
    }
  }
`;

/**
 * Get feeding summary/statistics
 */
export const FEEDING_SUMMARY_QUERY = `
  query FeedingSummary($entityType: String!, $entityId: ID!, $startDate: DateTime, $endDate: DateTime) {
    feedingSummary(entityType: $entityType, entityId: $entityId, startDate: $startDate, endDate: $endDate) {
      batchId
      siteId
      startDate
      endDate
      totalFeedGivenKg
      totalPlannedKg
      varianceKg
      variancePercent
      totalFeedings
      avgFeedingKg
      totalCost
      totalCostDecimal
      currency
      byFeedType {
        feedId
        feedName
        totalKg
        percentage
        cost
      }
    }
  }
`;

/**
 * Get feed inventory with filters and pagination
 */
export const FEED_INVENTORY_QUERY = `
  query FeedInventory($filter: FeedInventoryFilterInput, $pagination: FeedingPaginationInput) {
    feedInventory(filter: $filter, pagination: $pagination) {
      items {
        ${FEED_INVENTORY_FIELDS}
      }
      total
      page
      limit
      totalPages
      hasNextPage
      hasPreviousPage
    }
  }
`;

// ============================================================================
// MUTATIONS
// ============================================================================

/**
 * Create a new feeding record
 */
export const CREATE_FEEDING_RECORD_MUTATION = `
  mutation CreateFeedingRecord($input: CreateFeedingRecordInput!) {
    createFeedingRecord(input: $input) {
      ${FEEDING_RECORD_FIELDS}
    }
  }
`;

/**
 * Update an existing feeding record
 */
export const UPDATE_FEEDING_RECORD_MUTATION = `
  mutation UpdateFeedingRecord($id: ID!, $input: UpdateFeedingRecordInput!) {
    updateFeedingRecord(id: $id, input: $input) {
      ${FEEDING_RECORD_FIELDS}
    }
  }
`;

/**
 * Add feed inventory (purchase)
 */
export const ADD_FEED_INVENTORY_MUTATION = `
  mutation AddFeedInventory($input: AddFeedInventoryInput!) {
    addFeedInventory(input: $input) {
      ${FEED_INVENTORY_FIELDS}
    }
  }
`;

/**
 * Consume feed from inventory
 */
export const CONSUME_FEED_INVENTORY_MUTATION = `
  mutation ConsumeFeedInventory($input: ConsumeFeedInventoryInput!) {
    consumeFeedInventory(input: $input) {
      ${FEED_INVENTORY_FIELDS}
    }
  }
`;

/**
 * Adjust feed inventory (correction)
 */
export const ADJUST_FEED_INVENTORY_MUTATION = `
  mutation AdjustFeedInventory($input: AdjustFeedInventoryInput!) {
    adjustFeedInventory(input: $input) {
      ${FEED_INVENTORY_FIELDS}
    }
  }
`;
