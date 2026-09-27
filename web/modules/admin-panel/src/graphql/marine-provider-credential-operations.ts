/**
 * GraphQL Operations for the company marine provider credential
 * (config-service subgraph, MarineProviderCredentialResolver).
 *
 * WHY a dedicated surface rather than the generic setConfiguration: the
 * credential is one secret bundle under a service/key pair only the backend
 * contract knows. These operations send the credential's fields and read back
 * status metadata; the storage key and the bundle JSON shape never reach the
 * browser, so this client cannot get either wrong (ADMIN-HIGH-135).
 *
 * Plain template-literal operations, consumed by
 * hooks/useMarineProviderCredential.ts over the shared-ui graphqlClient —
 * the same transport as graphql/platform-configuration-operations.ts.
 * Validated against the composed supergraph by
 * scripts/ci/validate-graphql-operations.mjs on every PR.
 */

/**
 * Whether a company credential is stored for a provider, and its revision.
 * Resolver: MarineProviderCredentialResolver.getMarineProviderCredentialStatus
 * (tenantless SUPER_ADMIN only; a tenant principal is refused).
 */
export const MARINE_PROVIDER_CREDENTIAL_STATUS_QUERY = `
  query MarineProviderCredentialStatus($provider: MarineProviderCredentialProvider!) {
    marineProviderCredentialStatus(provider: $provider) {
      provider
      configured
      version
      updatedAt
    }
  }
`;

/**
 * Store (or rotate) the company CDSE credential.
 * Resolver: MarineProviderCredentialResolver.setMarineProviderCdseCredential
 * (tenantless SUPER_ADMIN only; the write is recorded in configuration
 * history with the given reason).
 */
export const SET_MARINE_PROVIDER_CDSE_CREDENTIAL_MUTATION = `
  mutation SetMarineProviderCdseCredential($input: SetMarineProviderCdseCredentialInput!) {
    setMarineProviderCdseCredential(input: $input) {
      provider
      configured
      version
      updatedAt
    }
  }
`;
