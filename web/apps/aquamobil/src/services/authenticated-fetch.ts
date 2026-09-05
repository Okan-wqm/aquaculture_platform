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
import { print } from 'graphql';

import { type GraphQLErrorPayload, readGraphQLResponse } from '@/utils/graphql-response';

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

// FE-HIGH-055: the barrier is RE-ARMABLE, not a module-const. A single const
// promise resolved once in session 1 stays resolved forever, so session 2's first
// authenticatedFetch (immediately after a logout on a shared device) would race
// ahead on session-1 stale state. Holding the promise + its resolver in mutable
// module variables — re-created by armAuthReady() — gives each session its OWN
// barrier identity, so a stale session-1 resolution is structurally unreachable
// in session 2 (tier-1 make-it-impossible).
let authReadyResolve: (() => void) | null = null;
let authReadyPromise: Promise<void>;

/**
 * (Re)create the readiness barrier: a fresh unresolved promise plus its resolver.
 * Called once at module load and again by resetAuthReady() on every session end.
 */
function armAuthReady(): void {
  authReadyResolve = null;
  authReadyPromise = new Promise<void>((resolve) => {
    authReadyResolve = resolve;
  });
}

// Arm the initial (session-1) barrier at module load.
armAuthReady();

/**
 * Mark auth as ready — called by useAuth.tsx after restoreSession completes
 * (whether successful or not) and by syncAuthStore when a token arrives. Resolves
 * the CURRENT session's barrier, unblocking pending authenticatedFetch() calls.
 * Idempotent: safe to call multiple times within a session.
 */
export function markAuthReady(): void {
  if (authReadyResolve) {
    authReadyResolve();
    authReadyResolve = null;
  }
}

/**
 * FE-HIGH-055: re-arm the barrier for a NEW session. Called by useAuth.tsx logout
 * (and, transitively, by the single-flight fail-closed logout in FE-HIGH-054)
 * AFTER the prior session's data is cleared and BEFORE the logged-out state is
 * committed. The next authenticatedFetch then blocks on this FRESH barrier until
 * session 2's own restoreSession / login resolves it via markAuthReady — never
 * firing on session-1's stale token.
 *
 * Awaiters already holding the OLD promise object keep their reference and resolve
 * normally (we only swap the module pointer for FUTURE awaiters), so an in-flight
 * session-1 request is not stranded.
 */
export function resetAuthReady(): void {
  armAuthReady();
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
// FE-HIGH-054: single-flight token refresh
//
// WHY: when N requests get a 401 at once (e.g. a token expires while a screen
// fans out several queries), each one independently calling authStore.refreshAuth()
// fires N parallel refresh POSTs → N rotations of the same refresh token. The
// server's refresh-token reuse-detection then sees the older rotations replayed
// and force-logs-the-user-out at random. Coalescing all concurrent 401s onto ONE
// refresh promise means exactly ONE refresh POST and ONE rotation per expiry
// window, eliminating the false-positive reuse logout.
//
// The result boolean is NOT cached beyond the in-flight window: the promise is
// cleared in `.finally` on resolve OR reject, so the very next 401 after settle
// starts a fresh refresh attempt.
// ---------------------------------------------------------------------------

let refreshInFlight: Promise<boolean> | null = null;

/**
 * Run a token refresh under single-flight: the first caller starts the refresh
 * and every concurrent caller awaits the SAME promise. The in-flight promise is
 * cleared once it settles so subsequent 401s can refresh again.
 *
 * Returns `false` when no refresh function is registered (no session to refresh).
 */
function runSingleFlightRefresh(): Promise<boolean> {
  if (refreshInFlight) {
    return refreshInFlight;
  }
  const refreshAuth = authStore.refreshAuth;
  if (!refreshAuth) {
    return Promise.resolve(false);
  }
  // Coalesce the refresh AND its fail-closed consequence onto ONE in-flight promise:
  // (1) a refresh that REJECTS is treated identically to a `false` result (fail-closed),
  //     so a thrown refresh never propagates a rejection to the N coalesced awaiters; and
  // (2) the logout-on-failure fires EXACTLY ONCE here — not once per coalesced 401 caller
  //     — so a single rotation failure produces a single logout() (and therefore a single
  //     resetAuthReady() re-arm of the auth barrier, FE-HIGH-055), not an N-fanout.
  refreshInFlight = refreshAuth()
    .catch(() => false)
    .then(async (refreshed): Promise<boolean> => {
      if (!refreshed && authStore.logout) {
        await authStore.logout();
      }
      return refreshed;
    })
    .finally(() => {
      refreshInFlight = null;
    });
  return refreshInFlight;
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
    // FE-HIGH-054: coalesce all concurrent 401s onto ONE refresh (single-flight)
    // so N requests do not trigger N refresh-token rotations and a reuse-detection
    // false-positive logout. Each caller re-reads accessToken/tenantId AFTER the
    // shared refresh settles, so every retry uses the freshly-rotated token.
    const refreshed = await runSingleFlightRefresh();
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
    // else: runSingleFlightRefresh() already performed the fail-closed logout
    // (exactly once across all coalesced 401s) and re-armed the auth barrier;
    // return the original 401 so the caller surfaces the auth error.
  }

  return response;
}

// ---------------------------------------------------------------------------
// graphqlRequest — typed convenience wrapper for GraphQL operations
// ---------------------------------------------------------------------------

export class GraphQLError extends Error {
  // SSoT: the error element shape is the canonical GraphQLErrorPayload from
  // @/utils/graphql-response, so the parser and this class share ONE error type
  // instead of two near-duplicate inline shapes that could drift apart.
  public readonly graphqlErrors: readonly GraphQLErrorPayload[];

  constructor(errors: readonly GraphQLErrorPayload[]) {
    super(errors[0]?.message ?? 'GraphQL error');
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
 * S1-CODEGEN / MOB-HIGH-019: ONE call shape. `document` must be a codegen
 * `TypedDocumentNode<TResult, TVars>` (every document under src/ is a codegen
 * source), so BOTH the result AND the variable types flow from the document
 * and a query/result/variable drift is a COMPILE error. There is no
 * `DocumentNode + Record<string, unknown>` escape hatch any more: that overload
 * — selected by every call that wrote one explicit result generic — typed the
 * variables as an untyped bag, and the document-text CI gate cannot see a
 * variables object. It is how a deleted input field shipped for weeks.
 *
 * @returns The `data` field from the GraphQL response, typed as the result type.
 * @throws {GraphQLError} when the response contains `errors`.
 * @throws {Error}        when the HTTP response is not ok.
 */
export async function graphqlRequest<TResult, TVars>(
  document: TypedDocumentNode<TResult, TVars>,
  ...args: VariablesArg<TVars>
): Promise<TResult> {
  const [variables] = args;
  const response = await authenticatedFetch('/graphql', {
    method: 'POST',
    body: JSON.stringify({ query: print(document), variables }),
  });

  if (!response.ok) {
    throw new Error(`HTTP error: ${response.status}`);
  }

  // SSoT: route through readGraphQLResponse so the payload is parsed from
  // `unknown` into a typed GraphQLResponse<TResult> — never `any` (which the raw
  // response.json() returns and which trips no-unsafe-assignment).
  const result = await readGraphQLResponse<TResult>(response);

  if (result.errors?.length) {
    throw new GraphQLError(result.errors);
  }

  if (!result.data) {
    throw new Error('No data returned');
  }

  return result.data;
}
