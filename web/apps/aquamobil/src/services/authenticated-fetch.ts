// ============================================================================
// D07 API-01: Centralized HTTP interceptor for AquaMobil
//
// All authenticated GraphQL and REST calls go through this module.
// Features:
//   - Automatic Bearer token + X-Tenant-Id injection
//   - Automatic 401 -> silent token refresh -> retry (once)
//   - SEC-06: CSRF defense header on every request
//
// NOT covered (intentionally):
//   - useAuth.tsx internal calls (login, logout, refresh) - circular dependency
//   - useOfflineQueue.tsx sync calls - offline queue has its own auth handling
//   - useNetworkStatus.ts probe - unauthenticated HEAD request
// ============================================================================

import type { GraphQLResponse } from '@/types';

// ---------------------------------------------------------------------------
// Module-level auth store — kept in sync by AuthProvider via syncAuthStore()
// ---------------------------------------------------------------------------

interface AuthStore {
  accessToken: string | null;
  tenantId: string | null;
  refreshAuth: (() => Promise<boolean>) | null;
}

const authStore: AuthStore = {
  accessToken: null,
  tenantId: null,
  refreshAuth: null,
};

/**
 * Called by AuthProvider to keep the module-level store in sync with React state.
 * This avoids the need for hooks inside plain functions.
 */
export function syncAuthStore(
  accessToken: string | null,
  tenantId: string | null,
  refreshAuth: () => Promise<boolean>,
): void {
  authStore.accessToken = accessToken;
  authStore.tenantId = tenantId;
  authStore.refreshAuth = refreshAuth;
}

// ---------------------------------------------------------------------------
// authenticatedFetch — drop-in replacement for fetch('/graphql', ...)
// ---------------------------------------------------------------------------

/**
 * Wraps the native `fetch` with:
 *   1. Automatic Authorization / X-Tenant-Id / X-Requested-With headers
 *   2. On 401: one silent token refresh attempt + retry
 *
 * Callers that need to override headers (e.g. `credentials: 'include'`) can
 * pass them via `options` — they will be merged on top of the defaults.
 */
export async function authenticatedFetch(
  url: string,
  options?: RequestInit,
): Promise<Response> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-Requested-With': 'XMLHttpRequest',
    ...(authStore.accessToken ? { Authorization: `Bearer ${authStore.accessToken}` } : {}),
    ...(authStore.tenantId ? { 'X-Tenant-Id': authStore.tenantId } : {}),
    // Caller-supplied headers win (spread last)
    ...(options?.headers as Record<string, string> | undefined),
  };

  let response = await fetch(url, {
    ...options,
    headers,
    credentials: options?.credentials ?? 'include',
  });

  // 401 -> attempt one silent refresh, then retry the original request.
  // BUG-18: After refresh, re-read BOTH accessToken AND tenantId from the
  // auth store. The refresh response may carry an updated tenantId, and the
  // retry must send the fresh value in the X-Tenant-Id header. Previously
  // only Authorization was updated, leaving a stale or missing X-Tenant-Id.
  if (response.status === 401 && authStore.refreshAuth) {
    const refreshed = await authStore.refreshAuth();
    if (refreshed && authStore.accessToken) {
      headers['Authorization'] = `Bearer ${authStore.accessToken}`;
      if (authStore.tenantId) {
        headers['X-Tenant-Id'] = authStore.tenantId;
      }
      response = await fetch(url, {
        ...options,
        headers,
        credentials: options?.credentials ?? 'include',
      });
    }
  }

  return response;
}

// ---------------------------------------------------------------------------
// graphqlRequest — typed convenience wrapper for GraphQL operations
// ---------------------------------------------------------------------------

export class GraphQLError extends Error {
  public readonly graphqlErrors: Array<{ message: string; path?: string[]; extensions?: Record<string, unknown> }>;

  constructor(errors: Array<{ message: string; path?: string[]; extensions?: Record<string, unknown> }>) {
    super(errors[0]?.message || 'GraphQL error');
    this.name = 'GraphQLError';
    this.graphqlErrors = errors;
  }
}

/**
 * Execute a GraphQL operation through the authenticated fetch pipeline.
 *
 * @returns The `data` field from the GraphQL response, typed as `T`.
 * @throws {GraphQLError} when the response contains `errors`.
 * @throws {Error}        when the HTTP response is not ok.
 */
export async function graphqlRequest<T>(
  query: string,
  variables?: Record<string, unknown>,
): Promise<T> {
  const response = await authenticatedFetch('/graphql', {
    method: 'POST',
    body: JSON.stringify({ query, variables }),
  });

  if (!response.ok) {
    throw new Error(`HTTP error: ${response.status}`);
  }

  const result: GraphQLResponse<T> = await response.json();

  if (result.errors?.length) {
    throw new GraphQLError(result.errors);
  }

  if (!result.data) {
    throw new Error('No data returned');
  }

  return result.data;
}
