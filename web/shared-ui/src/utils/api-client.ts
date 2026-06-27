/**
 * API Client
 * Central client for GraphQL and REST API requests.
 * Handles token management, retry logic, and error handling.
 */

import { print, type DocumentNode } from 'graphql';
import { backendHealthCircuit } from './backend-health-circuit';
import { tokenLifecycle } from './token-lifecycle';

// ============================================================================
// CSRF Protection
// ============================================================================

/**
 * SEC-M03: Read the CSRF token from a <meta> tag or a cookie.
 *
 * The backend is expected to set the token via one of these mechanisms:
 *   1. A `<meta name="csrf-token">` tag rendered in the HTML shell, OR
 *   2. A non-httpOnly cookie named `XSRF-TOKEN` (the Angular / Django convention).
 *
 * The token is sent back on every mutating request (POST, PUT, PATCH, DELETE)
 * in the `X-CSRF-Token` header so the server can verify it against the
 * session-bound value.  GET / HEAD / OPTIONS are safe methods and are excluded.
 */
function getCsrfToken(): string | null {
  if (typeof document === 'undefined') return null;

  // Strategy 1: <meta name="csrf-token" content="...">
  const metaTag = document.querySelector<HTMLMetaElement>('meta[name="csrf-token"]');
  if (metaTag?.content) {
    return metaTag.content;
  }

  // Strategy 2: cookie named XSRF-TOKEN (non-httpOnly, set by server)
  const match = document.cookie.match(/(?:^|;\s*)XSRF-TOKEN=([^;]+)/);
  if (match?.[1]) {
    return decodeURIComponent(match[1]);
  }

  return null;
}

/** HTTP methods that mutate state and therefore require CSRF protection. */
const CSRF_PROTECTED_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Attach the X-CSRF-Token header to mutating requests.
 * Safe methods (GET, HEAD, OPTIONS) are excluded per OWASP guidelines.
 */
function attachCsrfHeader(headers: Record<string, string>, method: string): void {
  if (!CSRF_PROTECTED_METHODS.has(method.toUpperCase())) return;

  const token = getCsrfToken();
  if (token) {
    headers['X-CSRF-Token'] = token;
  }
}

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

type SharedAuthState = {
  accessToken: string | null;
  tenantId: string | null;
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

  const state: SharedAuthState = { accessToken: null, tenantId: null };
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
  try {
    const graphqlUrl = import.meta.env.VITE_GRAPHQL_URL || '/graphql';
    const response = await fetch(graphqlUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({
        query: `mutation { refreshToken(input: { refreshToken: "" }) { accessToken user { id email role tenantId } } }`,
      }),
    });

    if (!response.ok) return false;

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
  // Load tenant_id from localStorage (not sensitive)
  try {
    tenantId = localStorage.getItem('tenant_id');
  } catch (e) {
    // Ignore
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
  tokenRefreshPromise.catch(() => { /* handled by concurrent waiters */ });

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
  // Load tenant_id synchronously (non-sensitive, stays in localStorage)
  try {
    tenantId = localStorage.getItem('tenant_id');
  } catch (e) {
    // Ignore
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
  return () => { tenantChangeCallbacks.delete(fn); };
}

/**
 * Tenant ID'yi ayarla.
 *
 * SECURITY: When the tenant ID changes, all registered tenant-change callbacks
 * are invoked with the OLD tenant ID so that modules can purge stale data.
 */
export function setTenantId(id: string | null): void {
  const previousTenantId = tenantId;
  tenantId = id;
  const sharedState = getSharedAuthState();
  if (sharedState) {
    sharedState.tenantId = id;
  }

  try {
    if (id) {
      localStorage.setItem('tenant_id', id);
    } else {
      localStorage.removeItem('tenant_id');
    }
  } catch {
    // Ignore localStorage errors silently in production
  }

  // SECURITY: Notify listeners when the active tenant actually changed
  if (previousTenantId && previousTenantId !== id) {
    for (const cb of tenantChangeCallbacks) {
      try {
        cb(previousTenantId);
      } catch {
        // Best-effort — store may already be destroyed
      }
    }
  }
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
  async request<TData = unknown, TVariables = Record<string, unknown>>(
    query: string | DocumentNode,
    variables?: TVariables,
    options?: GraphQLRequestOptions,
    retryCount = 0
  ): Promise<TData> {
    const { headers: customHeaders, timeout, signal } = options || {};

    // Convert DocumentNode to string if needed (e.g. from graphql-tag gql`...`)
    const queryString = typeof query === 'string' ? query : print(query);

    // LIFECYCLE BARRIER: Wait for token to be ready before sending request.
    // Skip the barrier for the refreshToken mutation itself to avoid deadlock
    // (refresh must fire to PRODUCE the token that the barrier waits for).
    const isRefreshMutation = queryString.includes('refreshToken');
    if (!isRefreshMutation) {
      try {
        await tokenLifecycle.waitForReady();
      } catch {
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

    // Tenant ID from memory/localStorage
    const currentTenantId = getTenantId();
    if (currentTenantId) {
      headers['X-Tenant-Id'] = currentTenantId;
    }

    // Add request ID for distributed tracing
    headers['X-Request-Id'] = this.generateRequestId();

    // SEC-M03: Attach CSRF token to all GraphQL requests (always POST, which is mutating)
    attachCsrfHeader(headers, 'POST');

    // Timeout controller
    const controller = new AbortController();
    const timeoutId = setTimeout(
      () => controller.abort(),
      timeout || this.config.timeout
    );

    try {
      const response = await fetch(this.config.graphqlUrl, {
        method: 'POST',
        headers,
        credentials: 'include',
        body: JSON.stringify({
          query: queryString,
          variables,
        }),
        signal: signal || controller.signal,
      });

      clearTimeout(timeoutId);

      // 401 — attempt a single token refresh, then retry.
      // retryCount === 0 caps the retry to exactly one attempt (CRIT-01: no infinite loop).
      if (response.status === 401 && retryCount === 0) {
        try {
          await this.handleUnauthorized();
        } catch {
          // Refresh failed — clear full session and throw so callers can redirect to /login
          clearSession();
          throw new GraphQLClientError('Session expired', 'UNAUTHENTICATED');
        }
        return this.request(query, variables, options, retryCount + 1);
      }

      // A 5xx (nginx 502/503/504 when the gateway is down, or any server error)
      // returns an HTML/text body, NOT GraphQL JSON. Calling response.json() on it
      // throws a bare SyntaxError that callers can't classify, so the UI treats
      // loaded data as failed and blanks it. Surface a TYPED transport error first
      // so callers can show "backend unavailable" and keep showing cached data.
      // 4xx (incl. 401/403) is left to the auth + GraphQL-error handling below.
      if (response.status >= 500) {
        // Feed the outage breaker so refetchOnWindowFocus/Reconnect stop storming
        // a dead gateway (see backend-health-circuit).
        backendHealthCircuit.recordFailure();
        const code =
          response.status >= 502 && response.status <= 504
            ? 'BACKEND_UNAVAILABLE'
            : 'NETWORK_ERROR';
        throw new GraphQLClientError(
          `Backend unavailable (HTTP ${response.status})`,
          code,
        );
      }

      // Response parse
      const result = await response.json();
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
            await this.handleUnauthorized();
            return this.request(query, variables, options, retryCount + 1);
          } catch {
            // SECURITY: fail-closed — if token refresh fails on an auth error,
            // the session is irrecoverable. Clear it to force re-login instead
            // of leaving the user in a deadlocked state with a broken token.
            clearSession();
          }
        }

        throw new GraphQLClientError(
          error.message,
          error.extensions?.code || 'GRAPHQL_ERROR',
          result.errors
        );
      }

      return result.data as TData;
    } catch (error) {
      clearTimeout(timeoutId);

      // Abort error
      if (error instanceof Error && error.name === 'AbortError') {
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
  async request<T = unknown>(
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    path: string,
    options?: {
      body?: unknown;
      params?: Record<string, string | number | boolean>;
      headers?: Record<string, string>;
      timeout?: number;
    },
    retryCount = 0
  ): Promise<T> {
    const { body, params, headers: customHeaders, timeout } = options || {};

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

    // Headers
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...customHeaders,
    };

    // Access token from in-memory store (with Module Federation window fallback)
    const currentToken = getAccessToken();
    if (currentToken) {
      headers['Authorization'] = `Bearer ${currentToken}`;
    }

    // Attach tenant ID (from memory or localStorage)
    const currentTenantId = getTenantId();
    if (currentTenantId) {
      headers['X-Tenant-Id'] = currentTenantId;
    }

    // SEC-M03: Attach CSRF token to mutating REST requests (POST, PUT, PATCH, DELETE).
    // GET requests are safe methods and are excluded automatically by attachCsrfHeader.
    attachCsrfHeader(headers, method);

    // Timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(
      () => controller.abort(),
      timeout || this.config.timeout
    );

    try {
      const response = await fetch(url, {
        method,
        headers,
        credentials: 'include',
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      // 401 — attempt a single token refresh, then retry.
      // retryCount === 0 caps the retry to exactly one attempt (no infinite loop).
      if (response.status === 401 && retryCount === 0) {
        try {
          await this.handleUnauthorized();
        } catch {
          // Refresh failed — clear full session and throw
          clearSession();
          throw new RestClientError('Session expired', 401);
        }
        return this.request(method, path, options, retryCount + 1);
      }

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new RestClientError(
          errorData.message || `HTTP ${response.status}`,
          response.status,
          errorData
        );
      }

      // 204 No Content
      if (response.status === 204) {
        return undefined as T;
      }

      return await response.json();
    } catch (error) {
      clearTimeout(timeoutId);
      throw error;
    }
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

export default graphqlClient;
