/**
 * GraphQL Operations for Platform Configuration (config-service subgraph)
 *
 * Plain template-literal operations matching config-service's
 * ConfigurationResolver exactly (ORPHAN-HIGH-373 — the system-settings page is
 * config-service's first runtime consumer; the legacy admin-api settings
 * stores are retired 410-Gone).
 *
 * Consumed by hooks/usePlatformConfiguration.ts via useAdminQuery /
 * TanStack mutation over the shared-ui graphqlClient — the same transport
 * pattern as graphql/messaging-operations.ts.
 */

/**
 * Fetch all effective platform-scope settings.
 * Resolver: ConfigurationResolver.getEffectiveConfigurationsByService
 * Returns: EffectiveConfigurationDto[]
 *
 * `value` is GraphQLJSON: typed for seeded rows (number/boolean/json), a plain
 * string for keys first created through setConfiguration, `null` for a secret
 * with no stored value, and the redaction sentinel for a stored secret.
 */
export const PLATFORM_CONFIGURATIONS_QUERY = `
  query PlatformConfigurations($service: String!) {
    effectiveConfigurationsByService(service: $service) {
      key
      value
      secretMode
      source
      version
    }
  }
`;

/**
 * Upsert one platform-scope setting.
 * Resolver: ConfigurationResolver.setConfiguration (admin-gated; a tenantless
 * SUPER_ADMIN writes the SYSTEM-tenant platform rows).
 */
export const SET_PLATFORM_CONFIGURATION_MUTATION = `
  mutation SetPlatformConfiguration(
    $service: String!
    $key: String!
    $value: String!
    $isSecret: Boolean
    $reason: String
  ) {
    setConfiguration(
      service: $service
      key: $key
      value: $value
      isSecret: $isSecret
      reason: $reason
    ) {
      key
      value
      secretMode
      version
    }
  }
`;
