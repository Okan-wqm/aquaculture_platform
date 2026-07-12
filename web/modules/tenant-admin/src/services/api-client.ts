/**
 * Unified API Client for Tenant Admin
 *
 * Single GraphQL transport. Centralizes authentication headers, tenant
 * identification, and error handling by delegating to the shared client.
 */

import { graphqlClient } from '@aquaculture/shared-ui';

// ============================================================================
// Types
// ============================================================================

export interface GraphQLError {
  message: string;
  locations?: Array<{ line: number; column: number }>;
  path?: string[];
  extensions?: Record<string, unknown>;
}

export interface GraphQLResponse<T> {
  data: T;
  errors?: GraphQLError[];
}

// ============================================================================
// API Client
// ============================================================================

export class TenantApiClient {
  /**
   * Execute a GraphQL query or mutation.
   *
   * SSoT: delegates to the shared `graphqlClient` from `@aquaculture/shared-ui`
   * so every tenant-admin GraphQL call inherits the full auth lifecycle —
   * `tokenLifecycle.waitForReady()` (fires only after the access token is
   * restored), the `X-CSRF-Token` header, the in-memory `Authorization` +
   * `X-Tenant-Id` headers, and 401 → silent-refresh → single-retry. The
   * shared client also throws on GraphQL-level errors and uses
   * `credentials: 'include'`, so no local fetch/error handling is needed.
   *
   * @param query  - GraphQL query/mutation string
   * @param variables - Optional variables object
   * @returns The `data` field from the GraphQL response
   * @throws GraphQLClientError with the first GraphQL error message, or a
   *   transport error (timeout / network / unauthenticated)
   */
  async graphql<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
    return graphqlClient.request<T>(query, variables);
  }
}

/** Singleton instance used across the module */
export const apiClient = new TenantApiClient();
