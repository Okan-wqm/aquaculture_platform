/**
 * GraphQL operations for tenant configuration (config-service subgraph).
 *
 * The same resolver the system-settings page uses, addressed with an explicit
 * `$tenantId`. That argument is the whole reason this page can exist: without
 * it, config-service resolved scope from the caller's own JWT, and SUPER_ADMIN —
 * the platform's only tenantless principal — always landed on the SYSTEM rows.
 * A super-admin could read the platform's configuration and nobody else's.
 *
 * Consumed by hooks/useTenantConfiguration.ts, mirroring the transport in
 * hooks/usePlatformConfiguration.ts (useAdminQuery over the shared-ui
 * graphqlClient, keyed by adminKeys).
 */

import { gql } from 'graphql-tag';

/**
 * Every effective tenant-settings row for one tenant.
 *
 * `source` is the field that ends the fabricated-default era: `'system'` means
 * the tenant has not set this key and is reading the seeded default, `'tenant'`
 * means an operator decided it. admin-api's retired read path could not express
 * that distinction because it invented both.
 */
export const TENANT_CONFIGURATIONS_QUERY = gql`
  query TenantConfigurations($service: String!, $tenantId: String!) {
    effectiveConfigurationsByService(service: $service, tenantId: $tenantId) {
      key
      value
      secretMode
      source
      version
    }
  }
`;

/**
 * Upsert one tenant-settings key for one tenant.
 *
 * Admin-gated at the resolver: naming a `tenantId` requires a platform admin
 * role, and any other caller is refused rather than scoped back to itself.
 */
export const SET_TENANT_CONFIGURATION_MUTATION = gql`
  mutation SetTenantConfiguration(
    $service: String!
    $tenantId: String!
    $key: String!
    $value: String!
    $reason: String
  ) {
    setConfiguration(
      service: $service
      tenantId: $tenantId
      key: $key
      value: $value
      reason: $reason
    ) {
      key
      value
      version
    }
  }
`;
