/**
 * API Client
 * Central client for GraphQL and REST API requests.
 * Handles token management, retry logic, and error handling.
 */

import { Kind, parse, print, type DocumentNode, type OperationTypeNode } from 'graphql';
import type { TypedDocumentNode } from '@graphql-typed-document-node/core';
import {
  CSRF_SECURITY_POSTURE,
  IMPERSONATION_CREDENTIAL_HEADER,
  IMPERSONATION_HANDOFF_FRAGMENT_FIELDS,
  IMPERSONATION_SESSION_HEADER,
  isImpersonationContextId,
  isImpersonationCredential,
} from '@aquaculture/shared-contracts';
import { backendHealthCircuit } from './backend-health-circuit';
import { bumpSessionEpoch } from './session-epoch';
import { tokenLifecycle } from './token-lifecycle';

// ============================================================================
// Type Definitions
// ============================================================================

/**
 * API configuration
 */
export interface ApiConfig {
  /** GraphQL endpoint URL */
  graphqlUrl: string;
  /** REST API base URL */
  restBaseUrl: string;
  /** Default timeout (ms) */
  timeout: number;
  /** Maximum retry count */
  maxRetries: number;
  /** Retry delay (ms) */
  retryDelay: number;
}

/**
 * GraphQL request options
 */
export interface GraphQLRequestOptions {
  /** Custom headers */
  headers?: Record<string, string>;
  /** Timeout override */
  timeout?: number;
  /** Signal for abort */
  signal?: AbortSignal;
}

export interface GraphQLOperationIdentity {
  readonly kind: OperationTypeNode;
  readonly name: string | null;
}

/** Derive replay safety from the executable document, never from HTTP POST. */
export function graphQLOperationIdentity(
  document: string | DocumentNode,
): GraphQLOperationIdentity {
  let parsed: DocumentNode;
  try {
    parsed = typeof document === 'string' ? parse(document) : document;
  } catch {
    throw new GraphQLClientError('Invalid GraphQL document', 'INVALID_OPERATION_DOCUMENT');
  }
  const operations = parsed.definitions.filter(
    (definition) => definition.kind === Kind.OPERATION_DEFINITION,
  );
  if (operations.length !== 1) {
    throw new GraphQLClientError(
      'GraphQL document must contain exactly one operation',
      'INVALID_OPERATION_DOCUMENT',
    );
  }
  const operation = operations[0]!;
  return Object.freeze({
    kind: operation.operation,
    name: operation.name?.value ?? null,
  });
}

/**
 * GraphQL error type
 */
export interface GraphQLErrorResponse {
  message: string;
  locations?: Array<{ line: number; column: number }>;
  path?: string[];
  extensions?: {
    code?: string;
    [key: string]: unknown;
  };
}

function isUserSessionAuthError(message: string): boolean {
  const normalized = message.toLowerCase();

  return (
    normalized.includes('authentication required') ||
    normalized.includes('no authentication token provided') ||
    normalized.includes('no auth token') ||
    normalized.includes('session expired') ||
    normalized.includes('token expired') ||
    normalized.includes('jwt expired') ||
    normalized.includes('invalid token') ||
    normalized.includes('invalid access token') ||
    normalized.includes('refresh token expired')
  );
}

function isAbortError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'name' in error &&
    (error as { name?: unknown }).name === 'AbortError'
  );
}

// ============================================================================
// Default Configuration
// ============================================================================

const defaultConfig: ApiConfig = {
  // Use relative URLs to go through nginx proxy (port 8080) which forwards to gateway-api (port 3000)
  graphqlUrl: import.meta.env.VITE_GRAPHQL_URL || '/graphql',
  restBaseUrl: import.meta.env.VITE_API_URL || '/api',
  timeout: 30000,
  maxRetries: 3,
  retryDelay: 1000,
};

/** A refresh lock must never remain pending indefinitely on a stalled body. */
const TOKEN_REFRESH_TIMEOUT_MS = 15_000;

interface RequestAbortScope {
  readonly signal: AbortSignal;
  dispose(): void;
}

/**
 * Merge the caller's cancellation with an independent transport deadline.
 * The returned scope must remain alive until the response body is consumed:
 * fetch() resolving only means the headers arrived, not that JSON/blob parsing
 * can no longer stall.
 */
function createRequestAbortScope(timeoutMs: number, callerSignal?: AbortSignal): RequestAbortScope {
  const controller = new AbortController();
  const abortFromCaller = (): void => controller.abort();

  if (callerSignal?.aborted) {
    controller.abort();
  } else {
    callerSignal?.addEventListener('abort', abortFromCaller, { once: true });
  }

  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  let disposed = false;

  return {
    signal: controller.signal,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      clearTimeout(timeoutId);
      callerSignal?.removeEventListener('abort', abortFromCaller);
    },
  };
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('The operation was aborted', 'AbortError');
}

function awaitAbortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise((resolve, reject) => {
    const onAbort = (): void => {
      signal.removeEventListener('abort', onAbort);
      reject(abortReason(signal));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    void promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

/** Release an unread retry/error body without delaying the replacement request. */
function discardResponseBody(response: Response): void {
  void response.body?.cancel().catch(() => undefined);
}

// ============================================================================
// Token Management
// ============================================================================

/**
 * Token and Tenant store — kept in memory only.
 * SECURITY: Access token is kept in-memory only (not localStorage).
 * Refresh token is in an httpOnly cookie (never accessible to JS).
 */
let accessToken: string | null = null;
let tenantId: string | null = null;
let tokenRefreshPromise: Promise<void> | null = null;

interface ActiveImpersonationContext {
  readonly sessionId: string;
  readonly credential: string;
  readonly targetTenantId: string;
}

let activeImpersonationContext: ActiveImpersonationContext | null = null;

type SharedAuthState = {
  accessToken: string | null;
  tenantId: string | null;
  activeImpersonationContext?: ActiveImpersonationContext | null;
};

const SHARED_AUTH_STATE_KEY = '__AQUACULTURE_AUTH_STATE_V2__';

function getSharedAuthState(): SharedAuthState | null {
  if (typeof window === 'undefined') return null;

  const existing = (window as any)[SHARED_AUTH_STATE_KEY];
  if (
    existing &&
    typeof existing === 'object' &&
    'accessToken' in existing &&
    'tenantId' in existing
  ) {
    return existing as SharedAuthState;
  }

  const state: SharedAuthState = {
    accessToken: null,
    tenantId: null,
    activeImpersonationContext: null,
  };
  try {
    Object.defineProperty(window, SHARED_AUTH_STATE_KEY, {
      value: state,
      writable: false,
      enumerable: false,
      configurable: false,
    });
  } catch {
    return null;
  }

  return state;
}

function getActiveImpersonationContext(): ActiveImpersonationContext | null {
  const sharedState = getSharedAuthState();
  if (sharedState && sharedState.activeImpersonationContext !== undefined) {
    return sharedState.activeImpersonationContext;
  }
  return activeImpersonationContext;
}

function clearActiveImpersonationContext(): void {
  activeImpersonationContext = null;
  const sharedState = getSharedAuthState();
  if (sharedState) sharedState.activeImpersonationContext = null;
}

/** End an act-as context without touching the authenticated admin session. */
export function clearImpersonationContext(): void {
  const current = getActiveImpersonationContext();
  clearActiveImpersonationContext();
  if (!current || tenantId !== current.targetTenantId) return;

  let restoredTenantId: string | null = null;
  try {
    restoredTenantId = localStorage.getItem('tenant_id');
  } catch {
    // The normal platform scope remains null when storage is unavailable.
  }
  applyTenantId(restoredTenantId, false);
}

/**
 * Consume the one-time credential hand-off before any API request is issued.
 * Recognized fields are removed from the address bar immediately, including
 * malformed hand-offs, so a credential never remains in browser history.
 */
function consumeImpersonationHandoffFragment(): ActiveImpersonationContext | null {
  if (typeof window === 'undefined' || window.location.hash.length <= 1) return null;

  const fragment = new URLSearchParams(window.location.hash.slice(1));
  const fields = Object.values(IMPERSONATION_HANDOFF_FRAGMENT_FIELDS);
  if (!fields.some((field) => fragment.has(field))) return null;

  const values = {
    sessionId: fragment.getAll(IMPERSONATION_HANDOFF_FRAGMENT_FIELDS.sessionId),
    credential: fragment.getAll(IMPERSONATION_HANDOFF_FRAGMENT_FIELDS.credential),
    targetTenantId: fragment.getAll(IMPERSONATION_HANDOFF_FRAGMENT_FIELDS.targetTenantId),
  };
  for (const field of fields) fragment.delete(field);

  const scrubbedUrl = new URL(window.location.href);
  scrubbedUrl.hash = fragment.toString();
  window.history.replaceState(
    window.history.state,
    '',
    `${scrubbedUrl.pathname}${scrubbedUrl.search}${scrubbedUrl.hash}`,
  );

  if (
    values.sessionId.length !== 1 ||
    values.credential.length !== 1 ||
    values.targetTenantId.length !== 1 ||
    !isImpersonationContextId(values.sessionId[0]) ||
    !isImpersonationCredential(values.credential[0]) ||
    !isImpersonationContextId(values.targetTenantId[0])
  ) {
    return null;
  }

  return Object.freeze({
    sessionId: values.sessionId[0],
    credential: values.credential[0],
    targetTenantId: values.targetTenantId[0],
  });
}

/**
 * Install a tamper-proof auth getter on window for Module Federation cross-bundle access.
 * SEC-016: Uses Object.defineProperty with writable:false + configurable:false so
 * malicious scripts cannot overwrite the getter with a token-stealing shim.
 * The frozen object delegates to a versioned shared auth state, not only to the
 * original module closure, so HMR/test reloads/MF remotes cannot keep stale tokens.
 */
let authGlobalInstalled = false;

function installAuthGlobal(): void {
  if (typeof window === 'undefined') return;
  if (authGlobalInstalled) return;

  const authObj = Object.freeze({ getAccessToken, getTenantId });

  try {
    Object.defineProperty(window, '__AQUACULTURE_AUTH__', {
      value: authObj,
      writable: false,
      enumerable: false,
      configurable: false,
    });
    authGlobalInstalled = true;
  } catch {
    // Property already defined as non-configurable (from a previous bundle load) — safe to ignore.
    // The existing frozen getter already delegates to the correct getAccessToken.
  }
}

/**
 * Set access token (in-memory only).
 * The refresh token is managed via httpOnly cookie - not stored in JS.
 */
export function setTokens(access: string, _refresh?: string): void {
  accessToken = access;
  const sharedState = getSharedAuthState();
  if (sharedState) {
    sharedState.accessToken = access;
  }

  // SECURITY: Expose frozen getter on window for Module Federation cross-bundle access
  installAuthGlobal();

  // Notify lifecycle manager that a token is available
  tokenLifecycle.notifyTokenSet(access);
}

/**
 * Clear access token only.
 * tenantId is intentionally NOT cleared here - it is preserved during
 * refresh cycles so that X-Tenant-Id header is not lost between token expiry
 * and successful refresh. For full session teardown use clearSession().
 */
export function clearTokens(): void {
  accessToken = null;
  const sharedState = getSharedAuthState();
  if (sharedState) {
    sharedState.accessToken = null;
  }
  // NOTE: tenantId is intentionally NOT cleared here.
  // It is only cleared on explicit logout via clearSession().

  // Re-install auth global in case it wasn't set yet
  installAuthGlobal();

  // Notify lifecycle manager
  tokenLifecycle.notifyTokenCleared();
}

/**
 * Clear full session (tokens + tenant ID).
 * Called on explicit logout or when refresh permanently fails.
 * Unlike clearTokens(), this also removes tenantId from memory and localStorage.
 */
export function clearSession(): void {
  clearImpersonationContext();
  accessToken = null;
  tenantId = null;
  const sharedState = getSharedAuthState();
  if (sharedState) {
    sharedState.accessToken = null;
    sharedState.tenantId = null;
  }

  try {
    localStorage.removeItem('tenant_id');
  } catch {
    // Ignore
  }

  // Advance the cache generation on logout so a subsequent login (same browser,
  // no full reload) cannot read the prior session's tenant cache — see session-epoch.ts.
  bumpSessionEpoch();

  // Re-install auth global in case it wasn't set yet
  installAuthGlobal();

  // Notify lifecycle manager
  tokenLifecycle.notifyTokenCleared();
}

/**
 * Core refresh logic shared by silentRefresh() and handleUnauthorized().
 * Returns true if refresh succeeded, false otherwise.
 * ARCH-AUTH-002: Both proactive refresh (via tokenLifecycle) and reactive refresh
 * (via 401 handler) use this function through the shared tokenRefreshPromise lock,
 * preventing concurrent refresh calls that would revoke each other's tokens.
 */
async function performTokenRefresh(): Promise<boolean> {
  const abortScope = createRequestAbortScope(TOKEN_REFRESH_TIMEOUT_MS);
  try {
    const graphqlUrl = import.meta.env.VITE_GRAPHQL_URL || '/graphql';
    const response = await fetch(graphqlUrl, {
      method: CSRF_SECURITY_POSTURE.refresh.operationMethod,
      headers: { 'Content-Type': 'application/json' },
      credentials: CSRF_SECURITY_POSTURE.refresh.credentialsMode,
      body: JSON.stringify({
        query: `mutation { refreshToken(input: { refreshToken: "" }) { accessToken user { id email role tenantId } } }`,
      }),
      signal: abortScope.signal,
    });

    if (!response.ok) {
      discardResponseBody(response);
      return false;
    }

    const result = await response.json();
    if (result.errors || !result.data?.refreshToken?.accessToken) {
      return false;
    }

    // CRITICAL: Use setTokens() instead of direct assignment so that
    // tokenLifecycle.notifyTokenSet() fires, transitioning from REFRESHING → READY
    setTokens(result.data.refreshToken.accessToken);

    // Restore tenant ID from refresh response. If the legacy response omits
    // user.tenantId entirely, keep the existing tenant loaded before refresh.
    // If tenantId is explicitly null, clear stale tenant scope for SUPER_ADMIN.
    const refreshedUser = result.data.refreshToken.user;
    if (refreshedUser && Object.prototype.hasOwnProperty.call(refreshedUser, 'tenantId')) {
      setTenantId(refreshedUser.tenantId ?? null);
    }

    return true;
  } catch {
    return false;
  } finally {
    abortScope.dispose();
  }
}

/**
 * Restore session via silent refresh (httpOnly cookie sends refresh token automatically).
 * Call this on app startup instead of reading tokens from localStorage.
 * Returns true if session was restored successfully.
 *
 * ARCH-AUTH-002: Uses the shared tokenRefreshPromise lock to prevent concurrent
 * refresh mutations when both proactive refresh and 401 retry fire at the same time.
 */
export async function silentRefresh(): Promise<boolean> {
  // A one-time impersonation hand-off owns the effective tenant in memory.
  // Never replace it with the platform admin's persisted tenant during refresh.
  if (!getActiveImpersonationContext()) {
    try {
      tenantId = localStorage.getItem('tenant_id');
    } catch {
      // Ignore
    }
  }

  // If a refresh is already in progress (e.g. from handleUnauthorized), join it
  if (tokenRefreshPromise) {
    try {
      await tokenRefreshPromise;
      // The other refresh succeeded and called setTokens() — check if we got a token
      return getAccessToken() !== null;
    } catch {
      return false;
    }
  }

  // Take the lock so concurrent handleUnauthorized() calls wait on us
  let resolve: () => void;
  let reject: (err: Error) => void;
  tokenRefreshPromise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  // Prevent unhandled rejection warning on this promise.
  // Concurrent callers (handleUnauthorized) catch the rejection via their own await.
  // Without this, a rejection here surfaces as "Uncaught (in promise)" in the console
  // even though silentRefresh() itself returns a boolean (not this promise).
  tokenRefreshPromise.catch(() => {
    /* handled by concurrent waiters */
  });

  try {
    const success = await performTokenRefresh();
    if (success) {
      resolve!();
    } else {
      reject!(new Error('Silent refresh failed'));
    }
    return success;
  } catch {
    reject!(new Error('Silent refresh failed'));
    return false;
  } finally {
    tokenRefreshPromise = null;
  }
}

/**
 * Backward-compatible alias for silentRefresh.
 * Previously loaded tokens from localStorage; now restores via cookie-based refresh.
 */
export function loadTokensFromStorage(): void {
  // An active impersonation tenant is intentionally never persisted.
  if (!getActiveImpersonationContext()) {
    try {
      tenantId = localStorage.getItem('tenant_id');
    } catch {
      // Ignore
    }
  }
  // Access token will be restored asynchronously via silentRefresh() in AuthContext
}

/**
 * Access token al
 */
export function getAccessToken(): string | null {
  const sharedState = getSharedAuthState();
  if (sharedState?.accessToken !== undefined) {
    return accessToken ?? sharedState.accessToken;
  }

  // Module Federation fallback: check window global if module-level var is empty
  if (!accessToken && typeof window !== 'undefined') {
    const authGlobal = (window as any).__AQUACULTURE_AUTH__;
    if (authGlobal?.getAccessToken && authGlobal.getAccessToken !== getAccessToken) {
      return authGlobal.getAccessToken();
    }
  }
  return accessToken;
}

// ── Tenant Change Callback Registry ──

/**
 * SECURITY: Registry for callbacks to execute when tenant changes.
 * Used by Zustand stores (sensor, edge I/O) to clear stale tenant data
 * and prevent cross-tenant data leaks during impersonation / tenant switch.
 */
const tenantChangeCallbacks: Set<(oldTenantId: string) => void> = new Set();

/**
 * Register a callback to be invoked when the active tenant changes.
 * The callback receives the OLD tenant ID so it can selectively clear data.
 *
 * @param fn - Callback receiving the previous tenantId
 * @returns Unregister function
 */
export function onTenantChange(fn: (oldTenantId: string) => void): () => void {
  tenantChangeCallbacks.add(fn);
  return () => {
    tenantChangeCallbacks.delete(fn);
  };
}

/**
 * Tenant ID'yi ayarla.
 *
 * SECURITY: When the tenant ID changes, all registered tenant-change callbacks
 * are invoked with the OLD tenant ID so that modules can purge stale data.
 */
function applyTenantId(id: string | null, persist: boolean): void {
  const previousTenantId = tenantId;
  tenantId = id;
  const sharedState = getSharedAuthState();
  if (sharedState) {
    sharedState.tenantId = id;
  }

  if (persist) {
    try {
      if (id) {
        localStorage.setItem('tenant_id', id);
      } else {
        localStorage.removeItem('tenant_id');
      }
    } catch {
      // Ignore localStorage errors silently in production
    }
  }

  // SECURITY: Notify listeners when the active tenant actually changed
  if (previousTenantId && previousTenantId !== id) {
    // Advance the cache generation so React Query keys for the new (or
    // re-entered) tenant are fresh — see session-epoch.ts.
    bumpSessionEpoch();
    for (const cb of tenantChangeCallbacks) {
      try {
        cb(previousTenantId);
      } catch {
        // Best-effort — store may already be destroyed
      }
    }
  }
}

export function setTenantId(id: string | null): void {
  const impersonation = getActiveImpersonationContext();
  if (impersonation) {
    // Auth refresh returns the SUPER_ADMIN's system-scope tenant (null). That
    // response must not erase the separately authorized act-as tenant.
    if (id !== impersonation.targetTenantId) return;
    applyTenantId(impersonation.targetTenantId, false);
    return;
  }
  applyTenantId(id, true);
}

/**
 * Get tenant ID (from memory or localStorage).
 * SEC-013: Always read from localStorage if in-memory value is absent — do not
 * cache the localStorage value at module level, which would cause stale tenant
 * ID headers after a tenant switch without a page reload.
 * setTenantId() remains the canonical authority; memory cache is only for the
 * current session once explicitly set.
 */
export function getTenantId(): string | null {
  const impersonation = getActiveImpersonationContext();
  if (impersonation) return impersonation.targetTenantId;

  // Check memory first (set explicitly via setTenantId)
  if (tenantId) return tenantId;

  const sharedState = getSharedAuthState();
  if (sharedState?.tenantId) return sharedState.tenantId;

  // Module Federation fallback: check window global if module-level var is empty
  if (typeof window !== 'undefined') {
    const authGlobal = (window as any).__AQUACULTURE_AUTH__;
    if (authGlobal?.getTenantId && authGlobal.getTenantId !== getTenantId) {
      const globalTenantId = authGlobal.getTenantId();
      if (globalTenantId) return globalTenantId;
    }
  }

  // Fall back to localStorage — but do NOT cache to module-level var
  // so that tenant switches are always reflected without a page reload
  try {
    return localStorage.getItem('tenant_id');
  } catch {
    // Ignore localStorage errors silently in production
  }
  return null;
}

const initialImpersonationContext = consumeImpersonationHandoffFragment();
if (initialImpersonationContext) {
  activeImpersonationContext = initialImpersonationContext;
  const sharedState = getSharedAuthState();
  if (sharedState) sharedState.activeImpersonationContext = initialImpersonationContext;
  applyTenantId(initialImpersonationContext.targetTenantId, false);
}

function applyAuthorityContextHeaders(headers: Record<string, string>): void {
  for (const header of Object.keys(headers)) {
    if (
      header.toLowerCase() === IMPERSONATION_CREDENTIAL_HEADER ||
      header.toLowerCase() === IMPERSONATION_SESSION_HEADER
    ) {
      Reflect.deleteProperty(headers, header);
    }
  }

  const impersonation = getActiveImpersonationContext();
  if (impersonation) {
    headers['X-Tenant-Id'] = impersonation.targetTenantId;
    headers[IMPERSONATION_CREDENTIAL_HEADER] = impersonation.credential;
    headers[IMPERSONATION_SESSION_HEADER] = impersonation.sessionId;
    return;
  }

  const currentTenantId = getTenantId();
  if (currentTenantId) headers['X-Tenant-Id'] = currentTenantId;
}

// ============================================================================
// GraphQL Client
// ============================================================================

/**
 * GraphQL client
 */
class GraphQLClient {
  private config: ApiConfig;

  constructor(config: Partial<ApiConfig> = {}) {
    this.config = { ...defaultConfig, ...config };
  }

  /**
   * Execute a GraphQL query or mutation
   */
  async request<TData, TVariables>(
    query: TypedDocumentNode<TData, TVariables>,
    variables: TVariables,
    options?: GraphQLRequestOptions,
  ): Promise<TData>;
  async request<TData = unknown, TVariables = Record<string, unknown>>(
    query: string | DocumentNode,
    variables?: TVariables,
    options?: GraphQLRequestOptions,
  ): Promise<TData>;
  async request<TData = unknown, TVariables = Record<string, unknown>>(
    query: string | DocumentNode,
    variables?: TVariables,
    options?: GraphQLRequestOptions,
  ): Promise<TData> {
    const abortScope = createRequestAbortScope(
      options?.timeout || this.config.timeout,
      options?.signal,
    );
    try {
      return await this.requestWithAuthReplay(query, variables, options, 0, abortScope);
    } catch (error) {
      if (abortScope.signal.aborted || isAbortError(error)) {
        if (error instanceof GraphQLClientError && error.code === 'TIMEOUT') {
          throw error;
        }
        throw new GraphQLClientError('Request timed out', 'TIMEOUT');
      }
      throw error;
    } finally {
      abortScope.dispose();
    }
  }

  private async requestWithAuthReplay<TData, TVariables>(
    query: string | DocumentNode,
    variables: TVariables | undefined,
    options: GraphQLRequestOptions | undefined,
    retryCount: number,
    abortScope: RequestAbortScope,
  ): Promise<TData> {
    const { headers: customHeaders } = options || {};

    // Convert DocumentNode to string if needed (e.g. from graphql-tag gql`...`)
    const operation = graphQLOperationIdentity(query);
    const queryString = typeof query === 'string' ? query : print(query);

    // LIFECYCLE BARRIER: Wait for token to be ready before sending request.
    // Skip the barrier for the refreshToken mutation itself to avoid deadlock
    // (refresh must fire to PRODUCE the token that the barrier waits for).
    const isRefreshMutation = operation.kind === 'mutation' && operation.name === 'RefreshToken';
    if (!isRefreshMutation) {
      try {
        await awaitAbortable(tokenLifecycle.waitForReady(), abortScope.signal);
      } catch {
        if (abortScope.signal.aborted) {
          throw abortReason(abortScope.signal);
        }
        // Barrier timed out or auth permanently failed.
        // If we have a token in memory anyway (race condition edge case), proceed.
        if (!getAccessToken()) {
          throw new GraphQLClientError('Authentication required', 'UNAUTHENTICATED');
        }
      }
    }

    // Build request headers
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...customHeaders,
    };

    // Access token from in-memory store (with Module Federation window fallback)
    const currentToken = getAccessToken();
    if (currentToken) {
      headers['Authorization'] = `Bearer ${currentToken}`;
    }

    // Canonical tenant + optional short-lived impersonation credential.
    applyAuthorityContextHeaders(headers);

    // Add request ID for distributed tracing
    headers['X-Request-Id'] = this.generateRequestId();

    try {
      const response = await fetch(this.config.graphqlUrl, {
        method: CSRF_SECURITY_POSTURE.refresh.operationMethod,
        headers,
        credentials: CSRF_SECURITY_POSTURE.refresh.credentialsMode,
        body: JSON.stringify({
          query: queryString,
          variables,
        }),
        signal: abortScope.signal,
      });

      // 401 — attempt a single token refresh, then retry.
      // retryCount === 0 caps the retry to exactly one attempt (CRIT-01: no infinite loop).
      if (response.status === 401 && retryCount === 0) {
        discardResponseBody(response);
        try {
          await this.handleUnauthorized(abortScope.signal);
        } catch (error) {
          if (abortScope.signal.aborted || isAbortError(error)) {
            throw error;
          }
          // Refresh failed — clear full session and throw so callers can redirect to /login
          clearSession();
          throw new GraphQLClientError('Session expired', 'UNAUTHENTICATED');
        }
        if (operation.kind !== 'query') {
          throw new GraphQLClientError(
            `Authentication refreshed but ${operation.kind} ${operation.name ?? '<anonymous>'} was not replayed`,
            'UNSAFE_AUTH_REPLAY_BLOCKED',
          );
        }
        return this.requestWithAuthReplay(query, variables, options, retryCount + 1, abortScope);
      }

      // A 5xx (nginx 502/503/504 when the gateway is down, or any server error)
      // returns an HTML/text body, NOT GraphQL JSON. Calling response.json() on it
      // throws a bare SyntaxError that callers can't classify, so the UI treats
      // loaded data as failed and blanks it. Surface a TYPED transport error first
      // so callers can show "backend unavailable" and keep showing cached data.
      // 4xx (incl. 401/403) is left to the auth + GraphQL-error handling below.
      if (response.status >= 500) {
        discardResponseBody(response);
        // Feed the outage breaker so refetchOnWindowFocus/Reconnect stop storming
        // a dead gateway (see backend-health-circuit).
        backendHealthCircuit.recordFailure();
        const code =
          response.status >= 502 && response.status <= 504
            ? 'BACKEND_UNAVAILABLE'
            : 'NETWORK_ERROR';
        throw new GraphQLClientError(`Backend unavailable (HTTP ${response.status})`, code);
      }

      // Response parse
      const result = await awaitAbortable(response.json(), abortScope.signal);
      // A parsed body means the transport is healthy (even a GraphQL-level error
      // is a 200) — close the outage breaker so refetches resume.
      backendHealthCircuit.recordSuccess();

      // Check for GraphQL errors
      if (result.errors && result.errors.length > 0) {
        const error = result.errors[0] as GraphQLErrorResponse;

        // Check for user-session auth errors (HTTP 200 but token expired/invalid).
        // Do not match every "Invalid ..." message: downstream service-identity
        // failures are backend/service-call errors, not a reason to clear the
        // browser session.
        const isAuthError =
          error.extensions?.code === 'UNAUTHENTICATED' ||
          (error.extensions?.code === 'FORBIDDEN' && isUserSessionAuthError(error.message)) ||
          isUserSessionAuthError(error.message);

        if (isAuthError && retryCount === 0) {
          try {
            await this.handleUnauthorized(abortScope.signal);
          } catch (refreshError) {
            if (abortScope.signal.aborted || isAbortError(refreshError)) {
              throw refreshError;
            }
            // SECURITY: fail-closed — if token refresh fails on an auth error,
            // the session is irrecoverable. Clear it to force re-login instead
            // of leaving the user in a deadlocked state with a broken token.
            clearSession();
            throw new GraphQLClientError('Session expired', 'UNAUTHENTICATED');
          }
          if (operation.kind !== 'query') {
            throw new GraphQLClientError(
              `Authentication refreshed but ${operation.kind} ${operation.name ?? '<anonymous>'} was not replayed`,
              'UNSAFE_AUTH_REPLAY_BLOCKED',
            );
          }
          return this.requestWithAuthReplay(query, variables, options, retryCount + 1, abortScope);
        }

        throw new GraphQLClientError(
          error.message,
          error.extensions?.code || 'GRAPHQL_ERROR',
          result.errors,
        );
      }

      return result.data as TData;
    } catch (error) {
      // Abort error
      if (abortScope.signal.aborted || isAbortError(error)) {
        throw new GraphQLClientError('Request timed out', 'TIMEOUT');
      }

      // Network error
      if (error instanceof TypeError && error.message.includes('fetch')) {
        throw new GraphQLClientError('Unable to connect to server', 'NETWORK_ERROR');
      }
      throw error;
    }
  }

  /**
   * Handle 401 Unauthorized — refresh token and dedup concurrent refresh calls
   */
  private async handleUnauthorized(signal: AbortSignal): Promise<void> {
    let refresh = tokenRefreshPromise;
    if (refresh === null) {
      refresh = this.refreshAccessToken();
      tokenRefreshPromise = refresh;
      void refresh
        .finally(() => {
          if (tokenRefreshPromise === refresh) tokenRefreshPromise = null;
        })
        .catch(() => undefined);
      await awaitAbortable(refresh, signal);
      return;
    }
    await awaitAbortable(refresh, signal);
  }

  /**
   * Refresh access token via shared performTokenRefresh().
   * ARCH-AUTH-002: Delegates to the shared refresh function so that
   * proactive refresh (via tokenLifecycle) and reactive refresh (via 401)
   * never fire concurrent refresh mutations.
   */
  private async refreshAccessToken(): Promise<void> {
    const success = await performTokenRefresh();
    if (!success) {
      clearSession();
      throw new GraphQLClientError('Token refresh failed', 'REFRESH_FAILED');
    }
  }

  /**
   * Generate a unique request ID.
   * SEC-015: Use crypto.randomUUID() for production-grade entropy.
   */
  private generateRequestId(): string {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
    // Fallback for environments without crypto.randomUUID
    return `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
  }
}

// ============================================================================
// GraphQL Error Class
// ============================================================================

export class GraphQLClientError extends Error {
  code: string;
  graphqlErrors?: GraphQLErrorResponse[];

  constructor(message: string, code: string, graphqlErrors?: GraphQLErrorResponse[]) {
    super(message);
    this.name = 'GraphQLClientError';
    this.code = code;
    this.graphqlErrors = graphqlErrors;
  }
}

// ============================================================================
// REST Client
// ============================================================================

/**
 * REST API client
 */
class RestClient {
  private config: ApiConfig;

  constructor(config: Partial<ApiConfig> = {}) {
    this.config = { ...defaultConfig, ...config };
  }

  /**
   * Send an HTTP request
   */
  /**
   * Shared transport: auth + tenant headers, lifecycle barrier,
   * timeout, response-body consumption, and single-shot 401 refresh-and-retry.
   * FARM-MEDIUM-091 routes farm uploads/tiles through this instead of
   * re-implementing headers per call. Keeping consumption inside this method is
   * security-critical: the abort scope must cover a stalled JSON/blob body too.
   */
  private async send<T>(
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    path: string,
    options:
      | {
          body?: unknown;
          params?: Record<string, string | number | boolean>;
          headers?: Record<string, string>;
          timeout?: number;
          signal?: AbortSignal;
        }
      | undefined,
    consumeResponse: (response: Response) => Promise<T>,
    retryCount = 0,
  ): Promise<T> {
    const { body, params, headers: customHeaders, timeout, signal: callerSignal } = options || {};

    // LIFECYCLE BARRIER: Wait for token to be ready before sending request.
    // REST calls never contain refreshToken mutations, so always await.
    try {
      await tokenLifecycle.waitForReady();
    } catch {
      // Barrier timed out or auth permanently failed.
      // If we have a token in memory anyway, proceed.
      if (!getAccessToken()) {
        throw new RestClientError('Authentication required', 401);
      }
    }

    // Build URL
    let url = `${this.config.restBaseUrl}${path}`;
    if (params) {
      const searchParams = new URLSearchParams();
      Object.entries(params).forEach(([key, value]) => {
        searchParams.append(key, String(value));
      });
      url += `?${searchParams.toString()}`;
    }

    // FARM-MEDIUM-091: a FormData body is a multipart upload. Let the browser set
    // Content-Type (with its boundary) and pass the FormData through untouched —
    // forcing application/json + JSON.stringify corrupts the multipart upload.
    const isMultipart = typeof FormData !== 'undefined' && body instanceof FormData;

    // Headers
    const headers: Record<string, string> = {
      ...(isMultipart ? {} : { 'Content-Type': 'application/json' }),
      ...customHeaders,
    };

    // Access token from in-memory store (with Module Federation window fallback)
    const currentToken = getAccessToken();
    if (currentToken) {
      headers['Authorization'] = `Bearer ${currentToken}`;
    }

    // Canonical tenant + optional short-lived impersonation credential.
    applyAuthorityContextHeaders(headers);

    let requestBody: BodyInit | undefined;
    if (typeof FormData !== 'undefined' && body instanceof FormData) {
      requestBody = body;
    } else if (body !== undefined && body !== null) {
      requestBody = JSON.stringify(body);
    }

    // Timeout
    const abortScope = createRequestAbortScope(timeout || this.config.timeout, callerSignal);

    try {
      const response = await fetch(url, {
        method,
        headers,
        credentials: CSRF_SECURITY_POSTURE.refresh.credentialsMode,
        body: requestBody,
        signal: abortScope.signal,
      });

      // 401 — attempt a single token refresh, then retry.
      // retryCount === 0 caps the retry to exactly one attempt (no infinite loop).
      if (response.status === 401 && retryCount === 0) {
        discardResponseBody(response);
        abortScope.dispose();
        try {
          await this.handleUnauthorized();
        } catch {
          // Refresh failed — clear full session and throw
          clearSession();
          throw new RestClientError('Session expired', 401);
        }
        return this.send(method, path, options, consumeResponse, retryCount + 1);
      }

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new RestClientError(
          errorData.message || `HTTP ${response.status}`,
          response.status,
          errorData,
        );
      }

      return await consumeResponse(response);
    } finally {
      abortScope.dispose();
    }
  }

  /**
   * Send an HTTP request and parse the JSON body (undefined for 204).
   */
  async request<T = unknown>(
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    path: string,
    options?: {
      body?: unknown;
      params?: Record<string, string | number | boolean>;
      headers?: Record<string, string>;
      timeout?: number;
      signal?: AbortSignal;
    },
    retryCount = 0,
  ): Promise<T> {
    return this.send(
      method,
      path,
      options,
      async (response) => {
        if (response.status === 204) {
          return undefined as T;
        }
        return (await response.json()) as T;
      },
      retryCount,
    );
  }

  /**
   * Like request(), but returns the raw Blob instead of parsing JSON — for binary
   * endpoints (marine map tiles via GET, AOI analysis images via POST) — through
   * the same shared auth/tenant + 401-refresh transport (FARM-MEDIUM-091,
   * replaces marine-data's hand-rolled fetch).
   */
  async requestBlob(
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    path: string,
    options?: {
      body?: unknown;
      params?: Record<string, string | number | boolean>;
      headers?: Record<string, string>;
      timeout?: number;
      signal?: AbortSignal;
    },
  ): Promise<Blob> {
    return this.send(method, path, options, (response) => response.blob());
  }

  /**
   * Handle 401 Unauthorized — refresh token and dedup concurrent refresh calls
   */
  private async handleUnauthorized(): Promise<void> {
    // If a refresh is already in progress, wait for it
    if (tokenRefreshPromise) {
      await tokenRefreshPromise;
      return;
    }

    // Refresh token via httpOnly cookie (sent automatically by browser)
    tokenRefreshPromise = this.refreshAccessToken();

    try {
      await tokenRefreshPromise;
    } finally {
      tokenRefreshPromise = null;
    }
  }

  /**
   * Refresh access token via shared performTokenRefresh().
   * ARCH-AUTH-002: Delegates to the shared refresh function so that
   * proactive refresh (via tokenLifecycle) and reactive refresh (via 401)
   * never fire concurrent refresh mutations.
   */
  private async refreshAccessToken(): Promise<void> {
    const success = await performTokenRefresh();
    if (!success) {
      clearSession();
      throw new RestClientError('Token refresh failed', 401);
    }
  }

  // Convenience methods
  get<T>(path: string, params?: Record<string, string | number | boolean>) {
    return this.request<T>('GET', path, { params });
  }

  post<T>(path: string, body?: unknown) {
    return this.request<T>('POST', path, { body });
  }

  put<T>(path: string, body?: unknown) {
    return this.request<T>('PUT', path, { body });
  }

  patch<T>(path: string, body?: unknown) {
    return this.request<T>('PATCH', path, { body });
  }

  delete<T>(path: string) {
    return this.request<T>('DELETE', path);
  }
}

// ============================================================================
// REST Error Class
// ============================================================================

export class RestClientError extends Error {
  statusCode: number;
  data?: unknown;

  constructor(message: string, statusCode: number, data?: unknown) {
    super(message);
    this.name = 'RestClientError';
    this.statusCode = statusCode;
    this.data = data;
  }
}

// ============================================================================
// Singleton Clients
// ============================================================================

export const graphqlClient = new GraphQLClient();
export const restClient = new RestClient();

/**
 * Pre-auth GraphQL client — the SANCTIONED transport for operations that run BEFORE
 * a session exists (forgot-password, reset-password, validate/accept-invitation).
 *
 * It is the replacement for raw `fetch('/graphql')` in pre-auth forms (plan A7 /
 * the `web-no-raw-graphql-rest-fetch` gate). Unlike `graphqlClient` it deliberately:
 *   - does NOT await the token-lifecycle barrier (there is no token yet — awaiting it
 *     would deadlock the very flow that mints the first token), and
 *   - sends NO `Authorization` / `X-Tenant-Id` header (the op is unauthenticated and
 *     tenant-agnostic; the resolver must treat it as public).
 * It KEEPS the typed 5xx transport-error handling so a gateway 502 during a pre-auth
 * op surfaces a classified `GraphQLClientError` instead of a bare JSON-parse crash,
 * and feeds the same backend-health circuit as the authed client.
 */
class PublicGraphQLClient {
  private readonly graphqlUrl = defaultConfig.graphqlUrl;
  private readonly timeoutMs = defaultConfig.timeout;

  private requestId(): string {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
    return `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
  }

  async request<TData = unknown, TVariables = Record<string, unknown>>(
    query: string | DocumentNode,
    variables?: TVariables,
    options?: GraphQLRequestOptions,
  ): Promise<TData> {
    const { headers: customHeaders, timeout, signal } = options || {};
    const queryString = typeof query === 'string' ? query : print(query);

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-Request-Id': this.requestId(),
      ...customHeaders,
    };

    const abortScope = createRequestAbortScope(timeout || this.timeoutMs, signal);

    try {
      const response = await fetch(this.graphqlUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify({ query: queryString, variables }),
        signal: abortScope.signal,
      });

      // 5xx (nginx 502/503/504 / server error) returns HTML, not GraphQL JSON.
      // Surface a TYPED transport error before response.json() throws an
      // unclassifiable SyntaxError. (Mirror of the authed GraphQLClient.)
      if (response.status >= 500) {
        discardResponseBody(response);
        backendHealthCircuit.recordFailure();
        const code =
          response.status >= 502 && response.status <= 504
            ? 'BACKEND_UNAVAILABLE'
            : 'NETWORK_ERROR';
        throw new GraphQLClientError(`Backend unavailable (HTTP ${response.status})`, code);
      }

      const result = await response.json();
      backendHealthCircuit.recordSuccess();

      if (result.errors?.length) {
        throw new GraphQLClientError(
          result.errors[0]?.message || 'GraphQL error',
          'GRAPHQL_ERROR',
          result.errors,
        );
      }
      return result.data as TData;
    } finally {
      abortScope.dispose();
    }
  }
}

export const publicGraphqlClient = new PublicGraphQLClient();

export default graphqlClient;
