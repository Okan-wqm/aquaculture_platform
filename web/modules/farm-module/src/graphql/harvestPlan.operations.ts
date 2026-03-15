/**
 * Harvest Plan GraphQL Operations
 *
 * All GraphQL queries and mutations for harvest plan management.
 * Maps to the backend harvest-plan.resolver.ts operations.
 *
 * @module FarmModule/GraphQL
 */

// ============================================================================
// FRAGMENTS
// ============================================================================

const HARVEST_PLAN_FIELDS = `
  id
  tenantId
  planCode
  name
  description
  batchId
  status
  harvestType
  plannedDate
  confirmedDate
  windowStartDate
  windowEndDate
  criteria
  harvestMethod
  productForm
  estimates
  financialProjection
  logistics
  customerOrder
  qualityRequirements
  actualQuantityHarvested
  actualBiomassHarvested
  actualAvgWeight
  approvedBy
  approvedAt
  createdBy
  notes
  attachments
  createdAt
  updatedAt
  daysUntilHarvest
  isWithinWindow
  isHarvestAllowed
  canEdit
  canDelete
  canApprove
  canSchedule
  canStartHarvest
  canComplete
  isOverdue
  estimatedRevenue
  estimatedProfit
  customerName
`;

// ============================================================================
// QUERIES
// ============================================================================

/**
 * Get a single harvest plan by ID
 */
export const HARVEST_PLAN_QUERY = `
  query HarvestPlan($id: ID!) {
    harvestPlan(id: $id) {
      ${HARVEST_PLAN_FIELDS}
    }
  }
`;

/**
 * Get a harvest plan by plan code
 */
export const HARVEST_PLAN_BY_CODE_QUERY = `
  query HarvestPlanByCode($planCode: String!) {
    harvestPlanByCode(planCode: $planCode) {
      ${HARVEST_PLAN_FIELDS}
    }
  }
`;

/**
 * List harvest plans with filtering and pagination
 */
export const HARVEST_PLANS_QUERY = `
  query HarvestPlans($filter: HarvestPlanFilterInput) {
    harvestPlans(filter: $filter) {
      items {
        ${HARVEST_PLAN_FIELDS}
      }
      total
      hasMore
    }
  }
`;

/**
 * Get harvest plans for a specific batch
 */
export const HARVEST_PLANS_BY_BATCH_QUERY = `
  query HarvestPlansByBatch($batchId: ID!, $activeOnly: Boolean) {
    harvestPlansByBatch(batchId: $batchId, activeOnly: $activeOnly) {
      ${HARVEST_PLAN_FIELDS}
    }
  }
`;

/**
 * Get upcoming harvest plans
 */
export const UPCOMING_HARVEST_PLANS_QUERY = `
  query UpcomingHarvestPlans($days: Int) {
    upcomingHarvestPlans(days: $days) {
      ${HARVEST_PLAN_FIELDS}
    }
  }
`;

/**
 * Get overdue harvest plans
 */
export const OVERDUE_HARVEST_PLANS_QUERY = `
  query OverdueHarvestPlans {
    overdueHarvestPlans {
      ${HARVEST_PLAN_FIELDS}
    }
  }
`;

/**
 * Get harvest plan statistics
 */
export const HARVEST_PLAN_STATS_QUERY = `
  query HarvestPlanStats {
    harvestPlanStats {
      total
      draft
      planned
      approved
      scheduled
      inProgress
      completed
      cancelled
      postponed
      totalEstimatedBiomass
      totalActualBiomass
      upcomingCount
      overdueCount
    }
  }
`;

// ============================================================================
// MUTATIONS
// ============================================================================

/**
 * Create a new harvest plan
 */
export const CREATE_HARVEST_PLAN_MUTATION = `
  mutation CreateHarvestPlan($input: CreateHarvestPlanInput!) {
    createHarvestPlan(input: $input) {
      ${HARVEST_PLAN_FIELDS}
    }
  }
`;

/**
 * Update an existing harvest plan
 */
export const UPDATE_HARVEST_PLAN_MUTATION = `
  mutation UpdateHarvestPlan($input: UpdateHarvestPlanInput!) {
    updateHarvestPlan(input: $input) {
      ${HARVEST_PLAN_FIELDS}
    }
  }
`;

/**
 * Delete a harvest plan (only draft plans)
 */
export const DELETE_HARVEST_PLAN_MUTATION = `
  mutation DeleteHarvestPlan($id: ID!) {
    deleteHarvestPlan(id: $id)
  }
`;

/**
 * Approve a harvest plan
 */
export const APPROVE_HARVEST_PLAN_MUTATION = `
  mutation ApproveHarvestPlan($id: ID!) {
    approveHarvestPlan(id: $id) {
      ${HARVEST_PLAN_FIELDS}
    }
  }
`;

/**
 * Schedule a harvest plan with a confirmed date
 */
export const SCHEDULE_HARVEST_PLAN_MUTATION = `
  mutation ScheduleHarvestPlan($id: ID!, $confirmedDate: DateTime!) {
    scheduleHarvestPlan(id: $id, confirmedDate: $confirmedDate) {
      ${HARVEST_PLAN_FIELDS}
    }
  }
`;

/**
 * Start harvest for a plan
 */
export const START_HARVEST_PLAN_MUTATION = `
  mutation StartHarvestPlan($id: ID!) {
    startHarvestPlan(id: $id) {
      ${HARVEST_PLAN_FIELDS}
    }
  }
`;

/**
 * Complete harvest for a plan with actual results
 */
export const COMPLETE_HARVEST_PLAN_MUTATION = `
  mutation CompleteHarvestPlan($id: ID!, $actualQuantity: Int!, $actualBiomass: Float!, $actualAvgWeight: Float!) {
    completeHarvestPlan(id: $id, actualQuantity: $actualQuantity, actualBiomass: $actualBiomass, actualAvgWeight: $actualAvgWeight) {
      ${HARVEST_PLAN_FIELDS}
    }
  }
`;

/**
 * Cancel a harvest plan
 */
export const CANCEL_HARVEST_PLAN_MUTATION = `
  mutation CancelHarvestPlan($id: ID!) {
    cancelHarvestPlan(id: $id) {
      ${HARVEST_PLAN_FIELDS}
    }
  }
`;

/**
 * Postpone a harvest plan to a new date
 */
export const POSTPONE_HARVEST_PLAN_MUTATION = `
  mutation PostponeHarvestPlan($id: ID!, $newDate: DateTime!) {
    postponeHarvestPlan(id: $id, newDate: $newDate) {
      ${HARVEST_PLAN_FIELDS}
    }
  }
`;
