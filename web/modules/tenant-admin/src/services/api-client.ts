/**
 * Unified API Client for Tenant Admin
 *
 * Single client with two transport methods:
 * - graphql<T>(): delegates to shared graphqlClient (lifecycle barrier + 401 retry + CSRF)
 * - rest<T>():    adds lifecycle barrier, tenant header, and 401 → refresh → retry
 *
 * WHY: Previously graphql() used raw fetch() with no token-lifecycle barrier,
 * so requests that fired on page load beat silentRefresh() and returned 401.
 * Delegating to the shared graphqlClient gives us:
 *   - await tokenLifecycle.waitForReady() before every request
 *   - automatic 401 → silentRefresh → retry (single attempt, fail-closed)
 *   - CSRF token injection (SEC-M03)
 *   - Module Federation cross-bundle token propagation
 *
 * All typed wrappers in lib/api.ts and the consuming hooks continue to work
 * unchanged — the public surface of TenantApiClient is preserved.
 */

import {
  graphqlClient,
  getAccessToken,
  getTenantId,
  tokenLifecycle,
  silentRefresh,
  clearSession,
} from '@aquaculture/shared-ui';

// ============================================================================
// Types (kept exported for backward compatibility with existing consumers)
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
   * Delegates to the shared `graphqlClient` which already provides:
   *   - Lifecycle barrier (await tokenLifecycle.waitForReady())
   *   - 401 detection → silentRefresh() → single retry
   *   - CSRF token header on mutating requests
   *   - X-Tenant-Id header from the shared tenant store
   *
   * @param query     - GraphQL query/mutation string
   * @param variables - Optional variables object
   * @returns The `data` field from the GraphQL response
   * @throws GraphQLClientError (from shared-ui) on HTTP / GraphQL / auth failure
   */
  async graphql<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
    // WHY: Shared client handles every concern (barrier, refresh, retry, CSRF).
    // Keeping a thin wrapper here preserves the public `apiClient.graphql<T>()`
    // surface used by lib/api.ts, services/tenant-api.service.ts, and the hooks.
    return graphqlClient.request<T>(query, variables);
  }

  /**
   * Execute a REST API call.
   *
   * WHY: The shared `restClient` exposes a method-first signature (get/post/…)
   * that would force a breaking change here. To preserve the existing
   * `rest<T>(path, RequestInit)` contract used by consumers, we implement the
   * same lifecycle + refresh + retry logic inline on top of fetch.
   *
   * @param path    - API path (relative, e.g. `/support/tickets`)
   * @param options - Standard RequestInit options (method, body, headers, …)
   * @returns Parsed JSON response, or `{}` for empty bodies
   * @throws Error with the error message from the response body
   */
  async rest<T>(path: string, options: RequestInit = {}): Promise<T> {
    // LIFECYCLE BARRIER: wait until the token lifecycle reports READY so we
    // never race silentRefresh() at app boot. If the barrier fails but we have
    // a token in memory anyway, proceed; otherwise bubble up so the caller can
    // redirect to /login.
    try {
      await tokenLifecycle.waitForReady();
    } catch {
      if (!getAccessToken()) {
        throw new Error('Authentication required');
      }
    }

    return this.sendRest<T>(path, options, /* isRetry */ false);
  }

  /**
   * Internal REST sender. Separated from `rest()` so the 401 handler can
   * recursively retry the request exactly once after a successful refresh
   * without re-entering the lifecycle barrier.
   */
  private async sendRest<T>(
    path: string,
    options: RequestInit,
    isRetry: boolean,
  ): Promise<T> {
    const apiUrl = import.meta.env.VITE_API_URL || '/api';
    const token = getAccessToken();
    const tenantId = getTenantId();

    // WHY: Merge caller-provided headers LAST so explicit overrides win, but
    // Content-Type / Authorization / X-Tenant-Id are present by default.
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(tenantId ? { 'X-Tenant-Id': tenantId } : {}),
      ...((options.headers as Record<string, string>) || {}),
    };

    const response = await fetch(`${apiUrl}${path}`, {
      ...options,
      headers,
      credentials: 'include',
    });

    // 401 → attempt a single silent refresh, then retry once. If refresh
    // fails, clear the session and throw so the caller can redirect to login.
    if (response.status === 401 && !isRetry) {
      const refreshed = await silentRefresh();
      if (!refreshed) {
        clearSession();
        throw new Error('Session expired');
      }
      return this.sendRest<T>(path, options, /* isRetry */ true);
    }

    if (!response.ok) {
      const errorBody = await response
        .json()
        .catch(() => ({ message: response.statusText }));
      throw new Error(
        (errorBody as { message?: string }).message || `HTTP ${response.status}`,
      );
    }

    // Handle empty responses (e.g. 204 No Content)
    const text = await response.text();
    if (!text) {
      return {} as T;
    }

    return JSON.parse(text) as T;
  }
}

/** Singleton instance used across the module */
export const apiClient = new TenantApiClient();
