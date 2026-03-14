/**
 * HTTP Client with Error Handling & Retry Logic
 * Shared infrastructure for all domain API modules
 */

import { getAccessToken } from '@platform/shared-ui/utils/api-client';

// API URL - Shell nginx uzerinden /api prefix'i ile admin-api-service'e yonlendirilir
export const ADMIN_API_URL = import.meta.env.VITE_ADMIN_API_URL || '/api';

// ============================================================================
// Types
// ============================================================================

export interface ApiError extends Error {
  status?: number;
  code?: string;
  details?: Record<string, unknown>;
}

export interface RetryConfig {
  maxRetries: number;
  baseDelay: number;
  maxDelay: number;
}

const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxRetries: 3,
  baseDelay: 1000,
  maxDelay: 10000,
};

// ============================================================================
// Internal Helpers
// ============================================================================

const getAuthHeader = (): Record<string, string> => {
  const token = getAccessToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
};

// Generate unique request ID for tracing
const generateRequestId = (): string => {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
};

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// ============================================================================
// Core API Fetch
// ============================================================================

export async function apiFetch<T>(
  endpoint: string,
  options?: RequestInit,
  retryConfig: RetryConfig = DEFAULT_RETRY_CONFIG
): Promise<T> {
  let lastError: ApiError | null = null;

  for (let attempt = 0; attempt <= retryConfig.maxRetries; attempt++) {
    try {
      const response = await fetch(`${ADMIN_API_URL}${endpoint}`, {
        ...options,
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
          'X-Request-ID': generateRequestId(),
          ...getAuthHeader(),
          ...options?.headers,
        },
      });

      if (!response.ok) {
        const errorBody = await response.json().catch(() => ({ message: 'API Error' }));
        const error: ApiError = new Error(errorBody.message || `HTTP ${response.status}`);
        error.status = response.status;
        error.code = errorBody.code;
        error.details = errorBody.details;

        // Don't retry client errors (4xx)
        if (response.status >= 400 && response.status < 500) {
          throw error;
        }

        lastError = error;

        if (attempt < retryConfig.maxRetries) {
          const delay = Math.min(
            retryConfig.baseDelay * Math.pow(2, attempt),
            retryConfig.maxDelay
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

      const json = JSON.parse(text);
      // Unwrap API envelope: { success, data, meta }
      if (json && typeof json === 'object' && 'success' in json && 'data' in json) {
        // Paginated response: meta has 'page' field -> return {data, ...meta} to match PaginatedResult
        if (json.meta && typeof json.meta === 'object' && 'page' in json.meta) {
          return { data: json.data, ...json.meta } as T;
        }
        // Non-paginated: return data directly
        return json.data as T;
      }
      return json;
    } catch (err) {
      if (err instanceof TypeError && err.message.includes('fetch')) {
        // Network error - retry
        lastError = err as ApiError;
        if (attempt < retryConfig.maxRetries) {
          const delay = Math.min(
            retryConfig.baseDelay * Math.pow(2, attempt),
            retryConfig.maxDelay
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
    if (value !== undefined && value !== null && value !== '') {
      if (Array.isArray(value)) {
        searchParams.set(key, value.join(','));
      } else {
        searchParams.set(key, String(value));
      }
    }
  });
  return searchParams.toString();
};
