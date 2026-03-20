/**
 * Feeding Protocol GraphQL Operations
 *
 * All GraphQL queries and mutations for feeding protocol management.
 * Maps to the backend feeding-protocol.resolver.ts operations.
 *
 * @module FarmModule/GraphQL
 */

// ============================================================================
// FRAGMENTS
// ============================================================================

const TEMPERATURE_RANGE_FIELDS = `
  min
  max
  unit
  feedingMultiplier
`;

const FEEDING_SCHEDULE_ENTRY_FIELDS = `
  time
  percentOfDaily
  notes
`;

const FEEDING_SCHEDULE_FIELDS = `
  totalMealsPerDay
  schedule {
    ${FEEDING_SCHEDULE_ENTRY_FIELDS}
  }
  adjustments {
    lowOxygenReduction
    postStressReduction
    preMedicationFasting
  }
`;

const GROWTH_STAGE_PROTOCOL_FIELDS = `
  minWeight
  maxWeight
  weightUnit
  feedPercent
  schedule {
    ${FEEDING_SCHEDULE_FIELDS}
  }
  notes
`;

const FEEDING_PROTOCOL_FIELDS = `
  id
  tenantId
  name
  description
  feedId
  species
  stage
  temperatureRanges {
    ${TEMPERATURE_RANGE_FIELDS}
  }
  growthStageProtocols {
    ${GROWTH_STAGE_PROTOCOL_FIELDS}
  }
  defaultSchedule {
    ${FEEDING_SCHEDULE_FIELDS}
  }
  targetFcr
  minDissolvedOxygen
  optimalTemperature {
    min
    max
    unit
  }
  specialConditions {
    spawningPeriod
    winterFeeding
    diseaseOutbreak
    waterQualityIssues
  }
  notes
  isActive
  isDefault
  createdBy
  updatedBy
  createdAt
  updatedAt
  version
`;

// ============================================================================
// QUERIES
// ============================================================================

/**
 * Get a single feeding protocol by ID
 */
export const FEEDING_PROTOCOL_QUERY = `
  query FeedingProtocol($id: ID!) {
    feedingProtocol(id: $id) {
      ${FEEDING_PROTOCOL_FIELDS}
    }
  }
`;

/**
 * List feeding protocols with filters and pagination
 */
// SCHEMA-CONTRACT: Farm-service uses FarmPaginationInput (page/limit), not platform PaginationInput (offset/limit)
export const FEEDING_PROTOCOLS_QUERY = `
  query FeedingProtocols($filter: FeedingProtocolFilterInput, $pagination: FarmPaginationInput) {
    feedingProtocols(filter: $filter, pagination: $pagination) {
      items {
        ${FEEDING_PROTOCOL_FIELDS}
      }
      total
      page
      limit
      totalPages
    }
  }
`;

/**
 * Get feeding protocols for a specific species
 */
export const FEEDING_PROTOCOLS_BY_SPECIES_QUERY = `
  query FeedingProtocolsBySpecies($species: String!) {
    feedingProtocolsBySpecies(species: $species) {
      ${FEEDING_PROTOCOL_FIELDS}
    }
  }
`;

/**
 * Get default feeding protocol for a species and optional stage
 */
export const DEFAULT_FEEDING_PROTOCOL_QUERY = `
  query DefaultFeedingProtocol($species: String!, $stage: String) {
    defaultFeedingProtocol(species: $species, stage: $stage) {
      ${FEEDING_PROTOCOL_FIELDS}
    }
  }
`;

// ============================================================================
// MUTATIONS
// ============================================================================

/**
 * Create a new feeding protocol
 */
export const CREATE_FEEDING_PROTOCOL_MUTATION = `
  mutation CreateFeedingProtocol($input: CreateFeedingProtocolInput!) {
    createFeedingProtocol(input: $input) {
      ${FEEDING_PROTOCOL_FIELDS}
    }
  }
`;

/**
 * Update an existing feeding protocol
 */
export const UPDATE_FEEDING_PROTOCOL_MUTATION = `
  mutation UpdateFeedingProtocol($input: UpdateFeedingProtocolInput!) {
    updateFeedingProtocol(input: $input) {
      ${FEEDING_PROTOCOL_FIELDS}
    }
  }
`;

/**
 * Delete (deactivate) a feeding protocol
 */
export const DELETE_FEEDING_PROTOCOL_MUTATION = `
  mutation DeleteFeedingProtocol($id: ID!) {
    deleteFeedingProtocol(id: $id)
  }
`;

/**
 * Set a protocol as default for its species/stage
 */
export const SET_DEFAULT_FEEDING_PROTOCOL_MUTATION = `
  mutation SetDefaultFeedingProtocol($id: ID!) {
    setDefaultFeedingProtocol(id: $id) {
      ${FEEDING_PROTOCOL_FIELDS}
    }
  }
`;
