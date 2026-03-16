/**
 * API Client
 * Central client for GraphQL and REST API requests.
 * Handles token management, retry logic, and error handling.
 */

import { print, type DocumentNode } from 'graphql';

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

/**
 * Install a tamper-proof auth getter on window for Module Federation cross-bundle access.
 * SEC-016: Uses Object.defineProperty with writable:false + configurable:false so
 * malicious scripts cannot overwrite the getter with a token-stealing shim.
 * The frozen object always delegates to the closure-scoped getAccessToken, which
 * reads the in-memory accessToken variable — so it stays up-to-date after refresh.
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

  // SECURITY: Expose frozen getter on window for Module Federation cross-bundle access
  installAuthGlobal();
}

/**
 * Clear tokens
 */
export function clearTokens(): void {
  accessToken = null;
  tenantId = null;

  try {
    localStorage.removeItem('tenant_id');
  } catch (e) {
    // Ignore
  }

  // Re-install auth global in case it wasn't set yet
  installAuthGlobal();
}

/**
 * Restore session via silent refresh (httpOnly cookie sends refresh token automatically).
 * Call this on app startup instead of reading tokens from localStorage.
 * Returns true if session was restored successfully.
 */
export async function silentRefresh(): Promise<boolean> {
  // Load tenant_id from localStorage (not sensitive)
  try {
    tenantId = localStorage.getItem('tenant_id');
  } catch (e) {
    // Ignore
  }

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

    accessToken = result.data.refreshToken.accessToken;

    // Restore tenant ID from refresh response (critical for X-Tenant-Id header)
    const refreshedTenantId = result.data.refreshToken.user?.tenantId;
    if (refreshedTenantId) {
      setTenantId(refreshedTenantId);
    }

    // Re-install auth global in case it wasn't set yet
    installAuthGlobal();

    return true;
  } catch {
    return false;
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
  // Module Federation fallback: check window global if module-level var is empty
  if (!accessToken && typeof window !== 'undefined') {
    const authGlobal = (window as any).__AQUACULTURE_AUTH__;
    if (authGlobal?.getAccessToken && authGlobal.getAccessToken !== getAccessToken) {
      return authGlobal.getAccessToken();
    }
  }
  return accessToken;
}

/**
 * Tenant ID'yi ayarla
 */
export function setTenantId(id: string | null): void {
  tenantId = id;
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
          // Refresh failed — clear session and throw so callers can redirect to /login
          clearTokens();
          throw new GraphQLClientError('Session expired', 'UNAUTHENTICATED');
        }
        return this.request(query, variables, options, retryCount + 1);
      }

      // Response parse
      const result = await response.json();

      // Check for GraphQL errors
      if (result.errors && result.errors.length > 0) {
        const error = result.errors[0] as GraphQLErrorResponse;

        // Check for auth-related GraphQL errors (HTTP 200 but token expired/invalid)
        const isAuthError =
          error.extensions?.code === 'UNAUTHENTICATED' ||
          error.extensions?.code === 'FORBIDDEN' ||
          /expired|Invalid/i.test(error.message);

        if (isAuthError && retryCount === 0) {
          try {
            await this.handleUnauthorized();
            return this.request(query, variables, options, retryCount + 1);
          } catch {
            // Refresh failed — throw the original GraphQL error
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
   * Refresh access token via httpOnly cookie.
   * The refresh token cookie is sent automatically by the browser.
   * ARCH-AUTH-001: Also restores tenantId from refresh response to prevent
   * "Tenant ID is required" errors after 401 retry.
   */
  private async refreshAccessToken(): Promise<void> {
    try {
      const response = await fetch(this.config.graphqlUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          query: `mutation { refreshToken(input: { refreshToken: "" }) { accessToken user { id tenantId } } }`,
        }),
      });

      if (!response.ok) {
        clearTokens();
        throw new GraphQLClientError('Token refresh failed', 'REFRESH_FAILED');
      }

      const result = await response.json();
      if (result.errors || !result.data?.refreshToken?.accessToken) {
        clearTokens();
        throw new GraphQLClientError('Token refresh failed', 'REFRESH_FAILED');
      }

      setTokens(result.data.refreshToken.accessToken);

      // Restore tenant ID from refresh response
      const refreshedTenantId = result.data.refreshToken.user?.tenantId;
      if (refreshedTenantId) {
        setTenantId(refreshedTenantId);
      }
    } catch (error) {
      clearTokens();
      throw error;
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
          // Refresh failed — clear session and throw
          clearTokens();
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
   * Refresh access token via httpOnly cookie.
   * The refresh token cookie is sent automatically by the browser.
   * ARCH-AUTH-001: Also restores tenantId from refresh response to prevent
   * "Tenant ID is required" errors after 401 retry.
   */
  private async refreshAccessToken(): Promise<void> {
    try {
      const graphqlUrl = import.meta.env.VITE_GRAPHQL_URL || '/graphql';
      const response = await fetch(graphqlUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          query: `mutation { refreshToken(input: { refreshToken: "" }) { accessToken user { id tenantId } } }`,
        }),
      });

      if (!response.ok) {
        clearTokens();
        throw new RestClientError('Token refresh failed', response.status);
      }

      const result = await response.json();
      if (result.errors || !result.data?.refreshToken?.accessToken) {
        clearTokens();
        throw new RestClientError('Token refresh failed', 401);
      }

      setTokens(result.data.refreshToken.accessToken);

      // Restore tenant ID from refresh response
      const refreshedTenantId = result.data.refreshToken.user?.tenantId;
      if (refreshedTenantId) {
        setTenantId(refreshedTenantId);
      }
    } catch (error) {
      clearTokens();
      throw error;
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
