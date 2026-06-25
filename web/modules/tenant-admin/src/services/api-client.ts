/**
 * Unified API Client for Tenant Admin
 *
 * Single client with two transport methods:
 * - graphql<T>(): for GraphQL queries and mutations
 * - rest<T>(): for REST API calls
 *
 * Centralizes authentication headers, tenant identification,
 * and error handling in one place.
 */

import { getAccessToken, getTenantId, graphqlClient } from '@aquaculture/shared-ui';

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
  private getHeaders(): Record<string, string> {
    const token = getAccessToken();
    const tenantId = getTenantId();
    return {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(tenantId ? { 'X-Tenant-Id': tenantId } : {}),
    };
  }

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

  /**
   * Execute a REST API call.
   *
   * @param path    - API path (relative, e.g. `/support/tickets`)
   * @param options - Standard RequestInit options (method, body, etc.)
   * @returns Parsed JSON response
   * @throws Error with the error message from the response body
   */
  async rest<T>(path: string, options: RequestInit = {}): Promise<T> {
    const headers = this.getHeaders();
    const apiUrl = import.meta.env.VITE_API_URL || '/api';

    const response = await fetch(`${apiUrl}${path}`, {
      ...options,
      headers: {
        ...headers,
        ...((options.headers as Record<string, string>) || {}),
      },
    });

    if (!response.ok) {
      const errorBody = await response.json().catch(() => ({ message: response.statusText }));
      throw new Error(
        (errorBody as { message?: string }).message || `HTTP ${response.status}`,
      );
    }

    // Handle empty responses
    const text = await response.text();
    if (!text) {
      return {} as T;
    }

    return JSON.parse(text) as T;
  }
}

/** Singleton instance used across the module */
export const apiClient = new TenantApiClient();
