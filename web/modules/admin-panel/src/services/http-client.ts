/**
 * HTTP Client with Error Handling & Retry Logic
 * Shared infrastructure for all domain API modules
 *
 * SECURITY:
 *  - Waits for token lifecycle barrier before firing (prevents 401 race on page load)
 *  - Retries once on 401 after a silent refresh (keeps user logged in across token expiry)
 *  - Keeps admin-panel requests platform-scoped by default
 *  - Bearer-only: admin-api carries no cookie session, so there is no CSRF
 *    token to echo (AUTH-017 / ADR-0006)
 *  - Preserves the existing exponential backoff retry for 502/503/504 errors
 */

import {
  getAccessToken,
  getTenantId,
  tokenLifecycle,
  silentRefresh,
  clearSession,
} from '@aquaculture/shared-ui';

// API URL - Shell nginx uzerinden /api prefix'i ile admin-api-service'e yonlendirilir
const adminImportMeta = import.meta as { readonly env?: { readonly VITE_ADMIN_API_URL?: string } };
export const ADMIN_API_URL = adminImportMeta.env?.VITE_ADMIN_API_URL ?? '/api';

// ============================================================================
// Types
// ============================================================================

export interface ApiError extends Error {
  status?: number;
  code?: string;
  details?: Record<string, unknown>;
}

interface ApiErrorBody {
  message?: string;
  code?: string;
  details?: Record<string, unknown>;
}

interface ApiEnvelope {
  data: unknown;
  meta?: Record<string, unknown>;
  success?: unknown;
}

export interface RetryConfig {
  maxRetries: number;
  baseDelay: number;
  maxDelay: number;
}

export interface ApiFetchOptions extends RequestInit {
  tenantScope?: 'tenant' | 'platform';
}

const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxRetries: 3,
  baseDelay: 1000,
  maxDelay: 10000,
};

const RESERVED_SECURITY_HEADERS: ReadonlySet<string> = new Set([
  'authorization',
  'x-tenant-id',
  'x-request-id',
]);

// ============================================================================
// Internal Helpers
// ============================================================================

const getAuthHeader = (): Record<string, string> => {
  const token = getAccessToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
};

/** SEC-L03: Use cryptographically secure random UUID for request correlation IDs.
 *  Math.random() is a predictable PRNG — an attacker observing a few values can predict the next. */
const generateRequestId = (): string => {
  return crypto.randomUUID();
};

const sleep = (ms: number): Promise<void> =>
  new Promise(resolve => setTimeout(resolve, ms));

/** Construct a well-typed ApiError without unsafe casts. */
const createApiError = (
  message: string,
  status?: number,
  code?: string,
  details?: Record<string, unknown>,
): ApiError => {
  const error = new Error(message) as ApiError;
  if (status !== undefined) error.status = status;
  if (code !== undefined) error.code = code;
  if (details !== undefined) error.details = details;
  return error;
};

const resolveTenantIdForScope = (tenantScope: ApiFetchOptions['tenantScope']): string | null => {
  if (tenantScope === 'platform') {
    return null;
  }
  if (tenantScope === 'tenant') {
    return getTenantId();
  }
  throw createApiError('Invalid tenant scope', 400, 'INVALID_TENANT_SCOPE');
};

const normalizeHeaders = (headers?: HeadersInit): Record<string, string> => {
  if (!headers) {
    return {};
  }

  const normalized: Record<string, string> = {};
  if (typeof Headers !== 'undefined' && headers instanceof Headers) {
    headers.forEach((value, key) => {
      normalized[key] = value;
    });
    return normalized;
  }

  if (Array.isArray(headers)) {
    for (const [key, value] of headers) {
      normalized[key] = value;
    }
    return normalized;
  }

  for (const [key, value] of Object.entries(headers)) {
    normalized[key] = String(value);
  }
  return normalized;
};

const mergeHeadersWithReservedPolicy = (
  internalHeaders: Record<string, string>,
  callerHeaders?: HeadersInit,
): HeadersInit => {
  const merged: Record<string, string> = { ...internalHeaders };
  for (const [key, value] of Object.entries(normalizeHeaders(callerHeaders))) {
    if (RESERVED_SECURITY_HEADERS.has(key.toLowerCase())) {
      continue;
    }
    merged[key] = value;
  }
  return merged;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const parseApiErrorBody = (value: unknown): ApiErrorBody => {
  if (!isRecord(value)) {
    return { message: 'API Error' };
  }

  return {
    message: typeof value.message === 'string' ? value.message : undefined,
    code: typeof value.code === 'string' ? value.code : undefined,
    details: isRecord(value.details) ? value.details : undefined,
  };
};

const parseApiEnvelope = (value: unknown): ApiEnvelope | null => {
  if (!isRecord(value) || !('success' in value) || !('data' in value)) {
    return null;
  }

  return {
    success: value.success,
    data: value.data,
    meta: isRecord(value.meta) ? value.meta : undefined,
  };
};

const queryValueToString = (value: unknown): string | null => {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  return null;
};

// ============================================================================
// Core API Fetch
// ============================================================================

export async function apiFetch<T>(
  endpoint: string,
  options?: ApiFetchOptions,
  retryConfig: RetryConfig = DEFAULT_RETRY_CONFIG,
): Promise<T> {
  // SECURITY / LIFECYCLE BARRIER: wait for the silent refresh on page load to
  // complete before firing. Without this barrier every REST call races the
  // refresh and returns 401 until the access token lands in memory.
  try {
    await tokenLifecycle.waitForReady();
  } catch {
    // Barrier timed out or rejected. WHY: proceed only if a token is already
    // available — otherwise fail fast with 401 instead of hitting the server
    // with an unauthenticated request that will be rejected anyway.
    if (!getAccessToken()) {
      throw createApiError('Authentication required', 401);
    }
  }

  const { tenantScope = 'platform', ...fetchOptions } = options ?? {};
  const method = (fetchOptions.method ?? 'GET').toUpperCase();
  let lastError: ApiError | null = null;
  let has401Retried = false;

  // ADR-0014: ONE idempotency key per logical operation, minted OUTSIDE the
  // retry loop. This client retries 502/503/504 three times on its own, so a
  // refund whose reply was lost in a gateway timeout used to be submitted
  // again as a brand-new request — and billing had no way to tell the two
  // apart. X-Request-ID stays per-attempt: it identifies the attempt, this
  // identifies the operation. Callers may override the header when several
  // requests are one operation.
  const idempotencyKey = method === 'GET' || method === 'HEAD' ? null : generateRequestId();

  for (let attempt = 0; attempt <= retryConfig.maxRetries; attempt++) {
    try {
      // Build headers fresh on every attempt so we pick up the refreshed
      // access token after a 401 → silentRefresh() retry.
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'X-Request-ID': generateRequestId(),
        ...getAuthHeader(),
      };

      // Admin-panel is a platform-admin surface. Default to platform scope so
      // stale tenant context cannot leak into cross-tenant administration calls.
      const tenantId = resolveTenantIdForScope(tenantScope);
      if (tenantId) {
        headers['X-Tenant-Id'] = tenantId;
      }

      if (idempotencyKey) {
        headers['Idempotency-Key'] = idempotencyKey;
      }

      const mergedHeaders = mergeHeadersWithReservedPolicy(
        headers,
        fetchOptions.headers,
      );

      const response = await fetch(`${ADMIN_API_URL}${endpoint}`, {
        ...fetchOptions,
        credentials: 'include',
        headers: mergedHeaders,
      });

      // ── 401 Unauthorized: attempt silent refresh once, then retry ──
      // SECURITY: retry exactly once per apiFetch() invocation to avoid a
      // refresh loop if the refresh token is also expired.
      if (response.status === 401 && !has401Retried) {
        has401Retried = true;
        try {
          const refreshed = await silentRefresh();
          if (refreshed) {
            // Re-enter the loop on the same attempt counter so the 401 retry
            // does not consume one of the 5xx retry budgets.
            attempt--;
            continue;
          }
        } catch {
          // fall through to session-expired path
        }
        // Refresh failed — session is irrecoverable.
        clearSession();
        throw createApiError('Session expired', 401);
      }

      if (!response.ok) {
        const rawErrorBody: unknown = await response.json().catch((): ApiErrorBody => ({ message: 'API Error' }));
        const errorBody = parseApiErrorBody(rawErrorBody);
        const error = createApiError(
          errorBody.message ?? 'HTTP ' + String(response.status),
          response.status,
          errorBody.code,
          errorBody.details,
        );

        // Don't retry client errors (4xx) -- they indicate invalid
        // requests that will fail identically on every attempt.
        if (response.status >= 400 && response.status < 500) {
          throw error;
        }

        // Don't retry 500 Internal Server Error -- these indicate
        // server bugs, not transient infrastructure issues. Retrying
        // creates unnecessary load on an already-struggling server.
        // Only 502/503/504 (gateway/unavailable/timeout) are retried.
        if (response.status === 500) {
          throw error;
        }

        lastError = error;

        if (attempt < retryConfig.maxRetries) {
          const delay = Math.min(
            retryConfig.baseDelay * Math.pow(2, attempt),
            retryConfig.maxDelay,
          );
          await sleep(delay);
          continue;
        }

        throw error;
      }

      // Handle empty responses
      const text = await response.text();
      if (!text) {
        return {} as T;
      }

      const json: unknown = JSON.parse(text);
      const envelope = parseApiEnvelope(json);
      if (envelope) {
        if (envelope.meta && 'page' in envelope.meta) {
          return { data: envelope.data, ...envelope.meta } as T;
        }

        return envelope.data as T;
      }

      return json as T;
    } catch (err) {
      if (err instanceof TypeError && err.message.includes('fetch')) {
        // Network error - retry
        lastError = err;
        if (attempt < retryConfig.maxRetries) {
          const delay = Math.min(
            retryConfig.baseDelay * Math.pow(2, attempt),
            retryConfig.maxDelay,
          );
          await sleep(delay);
          continue;
        }
      }
      throw err;
    }
  }

  throw lastError || new Error('Request failed after retries');
}

// ============================================================================
// Query String Builder
// ============================================================================

export const buildQueryString = (params: Record<string, unknown>): string => {
  const searchParams = new URLSearchParams();

  Object.entries(params).forEach(([key, value]) => {
    if (value === undefined || value === null || value === '') {
      return;
    }

    if (Array.isArray(value)) {
      const values = value
        .map(queryValueToString)
        .filter((item): item is string => item !== null);
      if (values.length > 0) {
        searchParams.set(key, values.join(','));
      }
      return;
    }

    const stringValue = queryValueToString(value);
    if (stringValue !== null) {
      searchParams.set(key, stringValue);
    }
  });

  return searchParams.toString();
};
