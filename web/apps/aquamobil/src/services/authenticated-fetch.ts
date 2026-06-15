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

import type { TypedDocumentNode } from '@graphql-typed-document-node/core';
import { type DocumentNode, print } from 'graphql';

import type { GraphQLResponse } from '@/types';

// ---------------------------------------------------------------------------
// Module-level auth store — kept in sync by AuthProvider via syncAuthStore()
// ---------------------------------------------------------------------------

interface AuthStore {
  accessToken: string | null;
  tenantId: string | null;
  refreshAuth: (() => Promise<boolean>) | null;
  logout: (() => Promise<void> | void) | null;
}

const authStore: AuthStore = {
  accessToken: null,
  tenantId: null,
  refreshAuth: null,
  logout: null,
};

// ---------------------------------------------------------------------------
// Auth readiness barrier
//
// WHY: On page load, AuthProvider's restoreSession() is async — the token
// arrives later via syncAuthStore(). Without a barrier, authenticatedFetch()
// calls fire before the token is in memory and get 401 Unauthorized.
//
// React Native / PWA environment cannot use shared-ui's window-based
// tokenLifecycle, so this is a parallel promise-based implementation with
// the same semantics.
// ---------------------------------------------------------------------------

let authReadyResolve: (() => void) | null = null;
const authReadyPromise = new Promise<void>((resolve) => {
  authReadyResolve = resolve;
});

/**
 * Mark auth as ready — called by useAuth.tsx after restoreSession completes
 * (whether successful or not). This unblocks pending authenticatedFetch() calls.
 * Idempotent: safe to call multiple times.
 */
export function markAuthReady(): void {
  if (authReadyResolve) {
    authReadyResolve();
    authReadyResolve = null;
  }
}

/**
 * Called by AuthProvider to keep the module-level store in sync with React state.
 * This avoids the need for hooks inside plain functions.
 */
export function syncAuthStore(
  accessToken: string | null,
  tenantId: string | null,
  refreshAuth: () => Promise<boolean>,
  logout?: () => Promise<void> | void,
): void {
  authStore.accessToken = accessToken;
  authStore.tenantId = tenantId;
  authStore.refreshAuth = refreshAuth;
  authStore.logout = logout ?? null;
  // WHY: Secondary resolution path — if a token arrives via sync (e.g.,
  // restoreSession resolved with a valid session), mark ready immediately
  // so pending requests don't wait on the useAuth.tsx finally block.
  if (accessToken) {
    markAuthReady();
  }
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
  // LIFECYCLE BARRIER: wait for AuthProvider to complete restoreSession.
  // WHY: On page load, the token arrives async via syncAuthStore(). Without
  // this barrier, requests fire before the token is in memory → 401.
  // 15s timeout prevents indefinite hang if AuthProvider never initializes.
  await Promise.race([
    authReadyPromise,
    new Promise<void>((_, reject) =>
      setTimeout(() => reject(new Error('Auth initialization timed out')), 15_000),
    ),
  ]).catch(() => {
    // Barrier timed out — proceed anyway; request will fail 401 if no token
  });

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
  // SECURITY: fail-closed — if token refresh fails, clear the session to force
  // re-login. Without this, the user is stuck in a deadlock with a broken token
  // (e.g., old HS256 token after RS256 migration) and no way to recover.
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
    } else if (authStore.logout) {
      // Refresh failed — session is irrecoverable, force clean logout
      await authStore.logout();
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
 * Variable-presence helper: an operation with NO required variables may be
 * called with no second argument, while one that requires variables forces the
 * caller to pass them — both enforced by the document's variable type.
 */
type VariablesArg<TVars> = [TVars] extends [Record<string, never>]
  ? [variables?: TVars]
  : Record<string, never> extends TVars
    ? [variables?: TVars]
    : [variables: TVars];

/**
 * Execute a GraphQL operation through the authenticated fetch pipeline.
 *
 * S1-CODEGEN: two call shapes, both fully typed and both `print()`ing the
 * DocumentNode to the wire (callers never hand-write the query text):
 *
 *   1. INFERENCE — `graphqlRequest(MY_CHANNELS, vars)` with NO explicit type
 *      args. `MY_CHANNELS` is a codegen `TypedDocumentNode<TResult, TVars>`, so
 *      BOTH the result AND the variable types flow from the document — a
 *      query/result/variable drift is a COMPILE error. This is the canonical,
 *      maximally-safe path for the generated operation constants.
 *
 *   2. EXPLICIT RESULT — `graphqlRequest<{ x: T }>(DOC, vars)` with ONE explicit
 *      type arg. Used by call sites that pin a hand-authored result shape (the
 *      nominal `Channel`/`Message`/… view types) or by inline `gql` documents
 *      not yet promoted into the codegen pluck set. `DOC` is accepted as a
 *      `DocumentNode`; `variables` is loose. The operation TEXT is still
 *      validated against the schema by the codegen CI gate, so drift is caught
 *      at build time even on this path.
 *
 * @returns The `data` field from the GraphQL response, typed as the result type.
 * @throws {GraphQLError} when the response contains `errors`.
 * @throws {Error}        when the HTTP response is not ok.
 */
export function graphqlRequest<TResult, TVars>(
  document: TypedDocumentNode<TResult, TVars>,
  ...args: VariablesArg<TVars>
): Promise<TResult>;
export function graphqlRequest<TResult>(
  document: DocumentNode,
  variables?: Record<string, unknown>,
): Promise<TResult>;
export async function graphqlRequest<TResult>(
  document: DocumentNode,
  variables?: Record<string, unknown>,
): Promise<TResult> {
  const response = await authenticatedFetch('/graphql', {
    method: 'POST',
    body: JSON.stringify({ query: print(document), variables }),
  });

  if (!response.ok) {
    throw new Error(`HTTP error: ${response.status}`);
  }

  const result: GraphQLResponse<TResult> = await response.json();

  if (result.errors?.length) {
    throw new GraphQLError(result.errors);
  }

  if (!result.data) {
    throw new Error('No data returned');
  }

  return result.data;
}
