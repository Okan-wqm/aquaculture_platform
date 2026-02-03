/**
 * GraphQL Utilities for React Query Integration
 *
 * Features:
 * - Request deduplication (via React Query)
 * - Retry logic with error exclusions
 * - Request cancellation with AbortController
 * - Proper error handling with field-specific validation errors
 * - Tenant context verification
 */

import { QueryClient, QueryFunctionContext, UseQueryOptions, UseMutationOptions } from '@tanstack/react-query';
import { graphqlClient, GraphQLClientError, GraphQLErrorResponse, getTenantId, getAccessToken } from './api-client';

// ============================================================================
// Types
// ============================================================================

/**
 * GraphQL error with validation details
 */
export interface GraphQLValidationError {
  field: string;
  message: string;
  code?: string;
}

/**
 * Parsed GraphQL error response
 */
export interface ParsedGraphQLError {
  message: string;
  code: string;
  isAuthError: boolean;
  isValidationError: boolean;
  isNetworkError: boolean;
  validationErrors: GraphQLValidationError[];
  originalErrors?: GraphQLErrorResponse[];
}

/**
 * GraphQL query options with abort controller support
 */
export interface GraphQLQueryOptions {
  /** Custom abort signal */
  signal?: AbortSignal;
  /** Custom headers */
  headers?: Record<string, string>;
  /** Custom timeout in ms */
  timeout?: number;
}

/**
 * Query key factory for consistent key structure
 */
export type QueryKeyFactory<T extends string> = {
  all: readonly [T];
  lists: () => readonly [T, 'list'];
  list: (filter?: unknown) => readonly [T, 'list', { filter: unknown }];
  details: () => readonly [T, 'detail'];
  detail: (id: string) => readonly [T, 'detail', string];
};

// ============================================================================
// Error Handling
// ============================================================================

/**
 * HTTP status codes that should not trigger retry
 */
const NON_RETRYABLE_STATUS_CODES = [400, 401, 403, 404, 422];

/**
 * GraphQL error codes that should not trigger retry
 */
const NON_RETRYABLE_ERROR_CODES = [
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'BAD_USER_INPUT',
  'VALIDATION_ERROR',
  'NOT_FOUND',
];

/**
 * Parse GraphQL errors into a structured format
 */
export function parseGraphQLError(error: unknown): ParsedGraphQLError {
  // Default error structure
  const defaultError: ParsedGraphQLError = {
    message: 'An unexpected error occurred',
    code: 'UNKNOWN_ERROR',
    isAuthError: false,
    isValidationError: false,
    isNetworkError: false,
    validationErrors: [],
  };

  if (!error) {
    return defaultError;
  }

  // Handle GraphQLClientError
  if (error instanceof GraphQLClientError) {
    const validationErrors = extractValidationErrors(error.graphqlErrors);

    return {
      message: error.message,
      code: error.code,
      isAuthError: ['UNAUTHENTICATED', 'FORBIDDEN', 'REFRESH_FAILED'].includes(error.code),
      isValidationError: error.code === 'VALIDATION_ERROR' || error.code === 'BAD_USER_INPUT' || validationErrors.length > 0,
      isNetworkError: error.code === 'NETWORK_ERROR' || error.code === 'TIMEOUT',
      validationErrors,
      originalErrors: error.graphqlErrors,
    };
  }

  // Handle standard Error
  if (error instanceof Error) {
    const isNetworkError = error.name === 'AbortError' ||
      error.message.includes('fetch') ||
      error.message.includes('network');

    return {
      message: error.message,
      code: error.name === 'AbortError' ? 'ABORTED' : 'ERROR',
      isAuthError: false,
      isValidationError: false,
      isNetworkError,
      validationErrors: [],
    };
  }

  // Handle unknown error types
  if (typeof error === 'string') {
    return {
      ...defaultError,
      message: error,
    };
  }

  return defaultError;
}

/**
 * Extract validation errors from GraphQL error response
 */
function extractValidationErrors(errors?: GraphQLErrorResponse[]): GraphQLValidationError[] {
  if (!errors || errors.length === 0) {
    return [];
  }

  const validationErrors: GraphQLValidationError[] = [];

  for (const error of errors) {
    // Check for validation errors in extensions
    const extensions = error.extensions;

    if (extensions?.validationErrors && Array.isArray(extensions.validationErrors)) {
      for (const ve of extensions.validationErrors) {
        validationErrors.push({
          field: ve.field || ve.property || 'unknown',
          message: ve.message || ve.constraints?.[Object.keys(ve.constraints)[0]] || error.message,
          code: ve.code,
        });
      }
    }

    // Check for field path in error
    if (error.path && error.path.length > 0) {
      const field = error.path[error.path.length - 1];
      if (typeof field === 'string') {
        validationErrors.push({
          field,
          message: error.message,
          code: extensions?.code as string,
        });
      }
    }

    // Check for class-validator style errors
    const exception = extensions?.exception as { response?: { message?: unknown } } | undefined;
    if (exception?.response?.message) {
      const messages = exception.response.message;
      if (Array.isArray(messages)) {
        for (const msg of messages) {
          if (typeof msg === 'string') {
            // Try to extract field name from message like "name must be a string"
            const match = msg.match(/^(\w+)\s/);
            validationErrors.push({
              field: match?.[1] || 'unknown',
              message: msg,
            });
          } else if (typeof msg === 'object' && msg.property) {
            validationErrors.push({
              field: msg.property,
              message: Object.values(msg.constraints || {})[0] as string || msg.message,
              code: msg.code,
            });
          }
        }
      }
    }
  }

  return validationErrors;
}

/**
 * Get field-specific error message
 */
export function getFieldError(error: ParsedGraphQLError, fieldName: string): string | undefined {
  return error.validationErrors.find(ve => ve.field === fieldName)?.message;
}

/**
 * Check if error should trigger retry
 */
export function shouldRetry(error: unknown, failureCount: number, maxRetries: number = 3): boolean {
  // Don't retry if max retries reached
  if (failureCount >= maxRetries) {
    return false;
  }

  const parsed = parseGraphQLError(error);

  // Don't retry auth errors
  if (parsed.isAuthError) {
    return false;
  }

  // Don't retry validation errors
  if (parsed.isValidationError) {
    return false;
  }

  // Don't retry specific error codes
  if (NON_RETRYABLE_ERROR_CODES.includes(parsed.code)) {
    return false;
  }

  // Retry network errors
  if (parsed.isNetworkError) {
    return true;
  }

  // Default: retry unknown errors
  return true;
}

// ============================================================================
// Query Key Factory
// ============================================================================

/**
 * Create a query key factory for a specific entity type
 */
export function createQueryKeyFactory<T extends string>(entity: T): QueryKeyFactory<T> {
  return {
    all: [entity] as const,
    lists: () => [entity, 'list'] as const,
    list: (filter?: unknown) => [entity, 'list', { filter }] as const,
    details: () => [entity, 'detail'] as const,
    detail: (id: string) => [entity, 'detail', id] as const,
  };
}

// Pre-defined query key factories
export const sensorKeys = createQueryKeyFactory('sensor');
export const edgeDeviceKeys = createQueryKeyFactory('edgeDevice');
export const equipmentKeys = createQueryKeyFactory('equipment');
export const siteKeys = createQueryKeyFactory('site');
export const departmentKeys = createQueryKeyFactory('department');
export const systemKeys = createQueryKeyFactory('system');

// ============================================================================
// GraphQL Fetch with Cancellation
// ============================================================================

/**
 * GraphQL fetch function with abort controller support for React Query
 */
export async function graphqlFetchWithCancellation<TData, TVariables = Record<string, unknown>>(
  query: string,
  variables?: TVariables,
  options?: GraphQLQueryOptions
): Promise<TData> {
  return graphqlClient.request<TData, TVariables>(query, variables, {
    signal: options?.signal,
    headers: options?.headers,
    timeout: options?.timeout,
  });
}

/**
 * Create a query function that supports cancellation
 * Use this with React Query's queryFn
 */
export function createCancellableQueryFn<TData, TVariables = Record<string, unknown>>(
  query: string,
  variablesOrFn?: TVariables | ((context: QueryFunctionContext) => TVariables)
) {
  return async (context: QueryFunctionContext): Promise<TData> => {
    const variables = typeof variablesOrFn === 'function'
      ? (variablesOrFn as (context: QueryFunctionContext) => TVariables)(context)
      : variablesOrFn;

    return graphqlFetchWithCancellation<TData, TVariables>(query, variables, {
      signal: context.signal,
    });
  };
}

// ============================================================================
// Query Client Configuration
// ============================================================================

/**
 * Default retry function that excludes certain errors
 */
export function defaultRetryFn(failureCount: number, error: unknown): boolean {
  return shouldRetry(error, failureCount);
}

/**
 * Create a configured QueryClient with proper defaults
 */
export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        // Retry configuration
        retry: defaultRetryFn,
        retryDelay: (attemptIndex) => Math.min(1000 * 2 ** attemptIndex, 30000),

        // Stale/cache configuration
        staleTime: 30000, // 30 seconds
        gcTime: 5 * 60 * 1000, // 5 minutes (formerly cacheTime)

        // Refetch configuration
        refetchOnWindowFocus: false, // Disable aggressive refetching
        refetchOnReconnect: true,

        // Network mode
        networkMode: 'online',
      },
      mutations: {
        // Retry only once for mutations
        retry: 1,
        retryDelay: 1000,
        networkMode: 'online',
      },
    },
  });
}

// ============================================================================
// React Query Option Helpers
// ============================================================================

/**
 * Create query options with standard configuration
 */
export function createQueryOptions<TData, TError = ParsedGraphQLError>(
  options: Omit<UseQueryOptions<TData, TError>, 'queryKey' | 'queryFn'> & {
    queryKey: readonly unknown[];
    queryFn: (context: QueryFunctionContext) => Promise<TData>;
  }
): UseQueryOptions<TData, TError> {
  return {
    ...options,
    retry: (failureCount, error) => shouldRetry(error, failureCount),
  } as UseQueryOptions<TData, TError>;
}

/**
 * Create mutation options with error handling
 */
export function createMutationOptions<TData, TVariables, TError = ParsedGraphQLError>(
  options: UseMutationOptions<TData, TError, TVariables>
): UseMutationOptions<TData, TError, TVariables> {
  return {
    ...options,
    retry: 0, // Don't retry mutations by default
  };
}

// ============================================================================
// Tenant Context Verification
// ============================================================================

/**
 * Verify tenant context is available
 * Throws error if tenant ID is missing
 */
export function verifyTenantContext(): string {
  const tenantId = getTenantId();

  if (!tenantId) {
    throw new GraphQLClientError(
      'Tenant context is required. Please ensure you are logged in.',
      'TENANT_CONTEXT_MISSING'
    );
  }

  return tenantId;
}

/**
 * Verify authentication is available
 * Throws error if token is missing
 */
export function verifyAuthContext(): string {
  const token = getAccessToken();

  if (!token) {
    throw new GraphQLClientError(
      'Authentication required. Please log in.',
      'UNAUTHENTICATED'
    );
  }

  return token;
}

/**
 * Check if user is authenticated
 */
export function isAuthenticated(): boolean {
  return !!getAccessToken();
}

/**
 * Check if tenant context is available
 */
export function hasTenantContext(): boolean {
  return !!getTenantId();
}

// ============================================================================
// Error Display Helpers
// ============================================================================

/**
 * Get user-friendly error message
 */
export function getErrorMessage(error: unknown): string {
  const parsed = parseGraphQLError(error);

  // Auth errors
  if (parsed.isAuthError) {
    if (parsed.code === 'UNAUTHENTICATED') {
      return 'Your session has expired. Please log in again.';
    }
    if (parsed.code === 'FORBIDDEN') {
      return 'You do not have permission to perform this action.';
    }
  }

  // Network errors
  if (parsed.isNetworkError) {
    if (parsed.code === 'TIMEOUT') {
      return 'The request timed out. Please try again.';
    }
    return 'Unable to connect to the server. Please check your connection.';
  }

  // Validation errors
  if (parsed.isValidationError && parsed.validationErrors.length > 0) {
    return parsed.validationErrors.map(e => e.message).join('. ');
  }

  return parsed.message;
}

/**
 * Format validation errors for form display
 */
export function formatValidationErrors(error: unknown): Record<string, string> {
  const parsed = parseGraphQLError(error);
  const errors: Record<string, string> = {};

  for (const ve of parsed.validationErrors) {
    errors[ve.field] = ve.message;
  }

  return errors;
}

// ============================================================================
// Exports
// ============================================================================

export type {
  GraphQLErrorResponse,
};
