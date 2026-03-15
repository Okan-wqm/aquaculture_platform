/**
 * Hydroponics Configuration GraphQL Operations
 *
 * All GraphQL queries and mutations for hydroponics configuration management.
 * Maps to the backend setup.resolver.ts operations.
 *
 * @module HydroponicsModule/GraphQL
 */

// ============================================================================
// FRAGMENTS
// ============================================================================

const HYDROPONICS_CONFIG_FIELDS = `
  id
  tenantId
  configName
  settings
  createdAt
  updatedAt
`;

// ============================================================================
// QUERIES
// ============================================================================

/**
 * List configurations with optional type filter
 */
export const CONFIGURATIONS_QUERY = `
  query HydroponicsConfigurations($type: String) {
    hydroponicsConfigurations(type: $type) {
      ${HYDROPONICS_CONFIG_FIELDS}
    }
  }
`;

/**
 * Get a single configuration by ID
 */
export const CONFIGURATION_QUERY = `
  query HydroponicsConfiguration($id: ID!) {
    hydroponicsConfiguration(id: $id) {
      ${HYDROPONICS_CONFIG_FIELDS}
    }
  }
`;

// ============================================================================
// MUTATIONS
// ============================================================================

/**
 * Create a new configuration
 */
export const CREATE_CONFIGURATION_MUTATION = `
  mutation CreateHydroponicsConfiguration($input: CreateHydroponicsConfigInput!) {
    createHydroponicsConfiguration(input: $input) {
      ${HYDROPONICS_CONFIG_FIELDS}
    }
  }
`;

/**
 * Update an existing configuration
 */
export const UPDATE_CONFIGURATION_MUTATION = `
  mutation UpdateHydroponicsConfiguration($input: UpdateHydroponicsConfigInput!) {
    updateHydroponicsConfiguration(input: $input) {
      ${HYDROPONICS_CONFIG_FIELDS}
    }
  }
`;

/**
 * Delete a configuration
 */
export const DELETE_CONFIGURATION_MUTATION = `
  mutation DeleteHydroponicsConfiguration($id: ID!) {
    deleteHydroponicsConfiguration(id: $id)
  }
`;
