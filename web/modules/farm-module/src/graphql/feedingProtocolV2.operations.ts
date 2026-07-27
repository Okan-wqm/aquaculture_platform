/**
 * FeedingProtocolV2 GraphQL Operations (feeding-protocol SSoT — Faz 3)
 *
 * Birleşik yemleme protokolü (v2) CRUD + ünite atama operasyonları.
 * v1 protokol operasyon dosyası Faz 8'de silindi; bu dosya
 * ProtocolBuilderTab / AssignmentsTab yüzeylerinin tek kontratıdır.
 *
 * @module FarmModule/GraphQL
 */

/** Liste + detay için ortak protokol alan seti (jsonb alanlar tipli JSON döner). */
const FEEDING_PROTOCOL_V2_FIELDS = `
  id
  name
  description
  speciesId
  speciesName
  status
  bands
  temperatureAdjustments
  defaultMealSchedule
  fcrMatrix
  settings
  isDefault
  migrationNote
  createdAt
  updatedAt
  version
`;

const PROTOCOL_ASSIGNMENT_FIELDS = `
  id
  unitId
  unitType
  unitName
  unitCode
  siteId
  protocolId
  status
  effectiveFrom
  endedAt
  overrides
  suspensions
  currentFeedId
  currentBandIndex
  lastTransitionAt
  totalTransitions
  createdAt
  updatedAt
`;

export const FEEDING_PROTOCOLS_V2_QUERY = `
  query FeedingProtocolsV2(
    $status: FeedingProtocolStatus
    $speciesId: ID
    $pagination: StandardPaginationInput
  ) {
    feedingProtocolsV2(status: $status, speciesId: $speciesId, pagination: $pagination) {
      items {
        ${FEEDING_PROTOCOL_V2_FIELDS}
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

export const FEEDING_PROTOCOL_V2_QUERY = `
  query FeedingProtocolV2($id: ID!) {
    feedingProtocolV2(id: $id) {
      ${FEEDING_PROTOCOL_V2_FIELDS}
    }
  }
`;

export const PROTOCOL_ASSIGNMENTS_QUERY = `
  query ProtocolAssignments(
    $siteId: ID
    $unitId: ID
    $protocolId: ID
    $status: ProtocolAssignmentStatus
    $pagination: StandardPaginationInput
  ) {
    protocolAssignments(
      siteId: $siteId
      unitId: $unitId
      protocolId: $protocolId
      status: $status
      pagination: $pagination
    ) {
      items {
        ${PROTOCOL_ASSIGNMENT_FIELDS}
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

export const CREATE_FEEDING_PROTOCOL_V2_MUTATION = `
  mutation CreateFeedingProtocolV2($input: CreateFeedingProtocolV2Input!) {
    createFeedingProtocolV2(input: $input) {
      ${FEEDING_PROTOCOL_V2_FIELDS}
    }
  }
`;

export const UPDATE_FEEDING_PROTOCOL_V2_MUTATION = `
  mutation UpdateFeedingProtocolV2($input: UpdateFeedingProtocolV2Input!) {
    updateFeedingProtocolV2(input: $input) {
      ${FEEDING_PROTOCOL_V2_FIELDS}
    }
  }
`;

export const ARCHIVE_FEEDING_PROTOCOL_V2_MUTATION = `
  mutation ArchiveFeedingProtocolV2($id: ID!) {
    archiveFeedingProtocolV2(id: $id) {
      id
      status
    }
  }
`;

export const ASSIGN_PROTOCOL_TO_UNIT_MUTATION = `
  mutation AssignProtocolToUnit($input: AssignProtocolToUnitInput!) {
    assignProtocolToUnit(input: $input) {
      ${PROTOCOL_ASSIGNMENT_FIELDS}
    }
  }
`;

export const UPDATE_PROTOCOL_ASSIGNMENT_MUTATION = `
  mutation UpdateProtocolAssignment($input: UpdateProtocolAssignmentInput!) {
    updateProtocolAssignment(input: $input) {
      ${PROTOCOL_ASSIGNMENT_FIELDS}
    }
  }
`;

export const UNASSIGN_PROTOCOL_FROM_UNIT_MUTATION = `
  mutation UnassignProtocolFromUnit($assignmentId: ID!) {
    unassignProtocolFromUnit(assignmentId: $assignmentId) {
      id
      status
      endedAt
    }
  }
`;

/**
 * Ünitelerin etkin su sıcaklığı + kaynak provenansı (sensör ≤6s → manuel ≤24s
 * → none). AssignmentsTab sıcaklık rozetleri bu tek toplu sorguyu okur —
 * ünite başına istek YOK (K-11 toplu okuma disiplini).
 */
export const EFFECTIVE_UNIT_TEMPERATURES_QUERY = `
  query EffectiveUnitTemperatures($unitIds: [ID!]!) {
    effectiveUnitTemperatures(unitIds: $unitIds) {
      unitId
      celsius
      source
      measuredAt
      sensorId
    }
  }
`;

// ============================================================================
// Öğün motoru v2 (Faz 6 — MealBoard)
// ============================================================================

/**
 * Gün planı + öğün alan setleri. `snapshot`/`recalcLog`/`pours` tipli JSON
 * döner (jsonb) — web MealBoard hesap provenansını olduğu gibi gösterir
 * (mobil tarafta P-25 gereği tipli alan alt kümesi kullanılır).
 */
const FEEDING_MEAL_FIELDS = `
  id
  dayPlanId
  unitId
  siteId
  mealIndex
  scheduledAt
  percentOfDaily
  plannedKg
  status
  actualKg
  pours
  varianceKg
  variancePercent
  feedId
  fedAt
  fedBy
  feedingMethod
  recalculatedAt
  notes
`;

const FEEDING_DAY_PLAN_FIELDS = `
  id
  assignmentId
  protocolId
  unitId
  siteId
  unitType
  unitName
  unitCode
  planDate
  snapshot
  plannedTotalKg
  unplannedActualKg
  mealsPlanned
  status
  skipReason
  recalcLog
  createdAt
  updatedAt
`;

export const FEEDING_DAY_PLANS_QUERY = `
  query FeedingDayPlans($planDate: String!, $siteId: ID) {
    feedingDayPlans(planDate: $planDate, siteId: $siteId) {
      ${FEEDING_DAY_PLAN_FIELDS}
      meals {
        ${FEEDING_MEAL_FIELDS}
      }
    }
  }
`;

export const RECORD_MEAL_FEEDING_MUTATION = `
  mutation RecordMealFeeding($input: RecordMealFeedingInput!) {
    recordMealFeeding(input: $input) {
      id
      status
      actualKg
      varianceKg
      variancePercent
    }
  }
`;

export const SKIP_MEAL_MUTATION = `
  mutation SkipMeal($input: SkipMealInput!) {
    skipMeal(input: $input) {
      id
      status
      actualKg
      varianceKg
      variancePercent
    }
  }
`;

export const CORRECT_MEAL_POUR_MUTATION = `
  mutation CorrectMealPour($input: CorrectMealPourInput!) {
    correctMealPour(input: $input) {
      id
      status
      actualKg
      varianceKg
      variancePercent
    }
  }
`;

export const REGENERATE_DAY_PLAN_MUTATION = `
  mutation RegenerateDayPlan($unitId: ID!) {
    regenerateDayPlan(unitId: $unitId) {
      outcome
      dayPlanId
    }
  }
`;

export const TRANSITION_UNIT_FEED_MUTATION = `
  mutation TransitionUnitFeed($unitId: ID!, $toFeedId: ID!) {
    transitionUnitFeed(unitId: $unitId, toFeedId: $toFeedId) {
      outcome
      dayPlanId
    }
  }
`;

// ============================================================================
// Tükenme tahmini (Faz 7 — K-10 snapshot dilimleme sorgusu)
// ============================================================================

export const PROTOCOL_FEED_FORECAST_QUERY = `
  query ProtocolFeedForecast($siteId: ID, $horizonDays: Int, $refresh: Boolean) {
    protocolFeedForecast(siteId: $siteId, horizonDays: $horizonDays, refresh: $refresh) {
      siteScopeKey
      poolScope
      stale
      horizonDays
      computedAt
      perFeed {
        feedId
        feedCode
        feedName
        currentStockKg
        dailyConsumptionSeries
        remainingStockSeries
        stockoutDate
        daysOfCover
        firstConsumptionDate
        coverageFromAdoptionDays
        reorderDate
        reorderQuantityKg
        procurementLeadTimeDays
        leadTimeSource
      }
      perUnit {
        unitId
        unitName
        unitCode
        currentFeedId
        terminalFeedId
        transitions {
          fromFeedId
          toFeedId
          estimatedDate
          daysFromNow
        }
      }
      alerts {
        type
        feedId
        unitId
        days
        atDay
      }
      mortalityAssumption {
        applied
        source
      }
    }
  }
`;
