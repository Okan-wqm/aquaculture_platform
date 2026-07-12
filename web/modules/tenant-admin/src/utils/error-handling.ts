/**
 * Error Handling Utilities for Tenant Admin Module
 *
 * Provides consistent error handling, categorization, and user-friendly messages.
 */

import type { ToastOptions } from '@aquaculture/shared-ui';

// ============================================================================
// Error Types
// ============================================================================

/**
 * Error codes for different error categories
 */
export enum ErrorCode {
  // Network errors
  NETWORK_ERROR = 'NETWORK_ERROR',
  TIMEOUT_ERROR = 'TIMEOUT_ERROR',
  CONNECTION_REFUSED = 'CONNECTION_REFUSED',

  // GraphQL errors
  GRAPHQL_ERROR = 'GRAPHQL_ERROR',
  VALIDATION_ERROR = 'VALIDATION_ERROR',
  UNAUTHORIZED = 'UNAUTHORIZED',
  FORBIDDEN = 'FORBIDDEN',
  NOT_FOUND = 'NOT_FOUND',
  CONFLICT = 'CONFLICT',

  // Business logic errors
  ROLE_IN_USE = 'ROLE_IN_USE',
  SYSTEM_ROLE = 'SYSTEM_ROLE',
  DUPLICATE_NAME = 'DUPLICATE_NAME',

  // Unknown errors
  UNKNOWN_ERROR = 'UNKNOWN_ERROR',
}

/**
 * Structured error with code, message, and debug info
 */
export interface AppError {
  code: ErrorCode;
  message: string;
  userMessage: string;
  originalError?: unknown;
  timestamp: Date;
  retryable: boolean;
}

// ============================================================================
// Error Messages
// ============================================================================

const USER_FRIENDLY_MESSAGES: Record<ErrorCode, string> = {
  [ErrorCode.NETWORK_ERROR]: 'Unable to connect to the server. Please check your internet connection and try again.',
  [ErrorCode.TIMEOUT_ERROR]: 'The request took too long to complete. Please try again.',
  [ErrorCode.CONNECTION_REFUSED]: 'The server is not responding. Please try again later.',
  [ErrorCode.GRAPHQL_ERROR]: 'An error occurred while processing your request.',
  [ErrorCode.VALIDATION_ERROR]: 'Please check your input and try again.',
  [ErrorCode.UNAUTHORIZED]: 'Your session has expired. Please log in again.',
  [ErrorCode.FORBIDDEN]: 'You do not have permission to perform this action.',
  [ErrorCode.NOT_FOUND]: 'The requested resource could not be found.',
  [ErrorCode.CONFLICT]: 'A conflict occurred. The resource may have been modified.',
  [ErrorCode.ROLE_IN_USE]: 'This role cannot be deleted because it is assigned to users.',
  [ErrorCode.SYSTEM_ROLE]: 'System roles cannot be modified or deleted.',
  [ErrorCode.DUPLICATE_NAME]: 'A role with this name already exists.',
  [ErrorCode.UNKNOWN_ERROR]: 'An unexpected error occurred. Please try again.',
};

// ============================================================================
// Error Classification
// ============================================================================

/**
 * Check if error is a network-related error
 */
function isNetworkError(error: unknown): boolean {
  if (error instanceof TypeError && error.message === 'Failed to fetch') {
    return true;
  }
  if (error instanceof Error) {
    const message = error.message.toLowerCase();
    return (
      message.includes('network') ||
      message.includes('fetch') ||
      message.includes('connection') ||
      message.includes('timeout') ||
      message.includes('econnrefused')
    );
  }
  return false;
}

/**
 * Check if error is a GraphQL error response
 */
function isGraphQLError(error: unknown): boolean {
  if (typeof error === 'object' && error !== null) {
    return 'graphQLErrors' in error || ('message' in error && typeof (error as Error).message === 'string');
  }
  return false;
}

/**
 * Classify error and return appropriate error code
 */
function classifyError(error: unknown): ErrorCode {
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();

  // Network errors
  if (isNetworkError(error)) {
    if (message.includes('timeout')) return ErrorCode.TIMEOUT_ERROR;
    if (message.includes('refused')) return ErrorCode.CONNECTION_REFUSED;
    return ErrorCode.NETWORK_ERROR;
  }

  // HTTP status-based errors
  if (message.includes('401') || message.includes('unauthorized')) {
    return ErrorCode.UNAUTHORIZED;
  }
  if (message.includes('403') || message.includes('forbidden') || message.includes('permission')) {
    return ErrorCode.FORBIDDEN;
  }
  if (message.includes('404') || message.includes('not found')) {
    return ErrorCode.NOT_FOUND;
  }
  if (message.includes('409') || message.includes('conflict') || message.includes('already exists')) {
    return ErrorCode.CONFLICT;
  }
  if (message.includes('validation')) {
    return ErrorCode.VALIDATION_ERROR;
  }

  // Business logic errors
  if (message.includes('assigned') || message.includes('in use') || message.includes('users are still')) {
    return ErrorCode.ROLE_IN_USE;
  }
  if (message.includes('system role')) {
    return ErrorCode.SYSTEM_ROLE;
  }
  if (message.includes('duplicate') || message.includes('already exists')) {
    return ErrorCode.DUPLICATE_NAME;
  }

  // GraphQL errors
  if (isGraphQLError(error)) {
    return ErrorCode.GRAPHQL_ERROR;
  }

  return ErrorCode.UNKNOWN_ERROR;
}

// ============================================================================
// Error Processing
// ============================================================================

/**
 * Process any error and return a structured AppError
 */
export function processError(error: unknown): AppError {
  const code = classifyError(error);
  const message = error instanceof Error ? error.message : String(error);

  // Check if retryable based on error code
  const retryable = [
    ErrorCode.NETWORK_ERROR,
    ErrorCode.TIMEOUT_ERROR,
    ErrorCode.CONNECTION_REFUSED,
    ErrorCode.GRAPHQL_ERROR,
    ErrorCode.UNKNOWN_ERROR,
  ].includes(code);

  return {
    code,
    message,
    userMessage: getUserFriendlyMessage(code, message),
    originalError: error,
    timestamp: new Date(),
    retryable,
  };
}

/**
 * Sanitize an error for safe display in the UI.
 *
 * LOW-07: Raw `error.message` may contain stack traces, SQL fragments, or
 * internal service names that should never be shown to end-users. This
 * function classifies the error and returns a safe, user-friendly string.
 *
 * Use this as a drop-in replacement for `(err as Error).message` in catch
 * blocks that surface the message to the user.
 */
export function sanitizeErrorMessage(error: unknown): string {
  const processed = processError(error);
  return processed.userMessage;
}

/**
 * Get user-friendly error message
 */
export function getUserFriendlyMessage(code: ErrorCode, originalMessage?: string): string {
  // For specific business logic errors, include context
  if (code === ErrorCode.CONFLICT && originalMessage?.includes('already exists')) {
    return `A role with this name already exists. Please choose a different name.`;
  }

  if (code === ErrorCode.ROLE_IN_USE && originalMessage) {
    // Extract user count if present
    const match = originalMessage.match(/(\d+)\s*users?/i);
    if (match) {
      return `Cannot delete this role because ${match[1]} user(s) are still assigned to it.`;
    }
  }

  if (code === ErrorCode.FORBIDDEN && originalMessage?.toLowerCase().includes('system')) {
    return 'System roles cannot be modified or deleted.';
  }

  return USER_FRIENDLY_MESSAGES[code];
}

/**
 * Get error details for debugging
 */
export function getErrorDebugInfo(error: AppError): string {
  return JSON.stringify(
    {
      code: error.code,
      message: error.message,
      timestamp: error.timestamp.toISOString(),
    },
    null,
    2
  );
}

// ============================================================================
// Logging
// ============================================================================

/**
 * Log error for debugging
 */
export function logError(
  context: string,
  error: unknown,
  additionalInfo?: Record<string, unknown>
): void {
  const processedError = processError(error);

  console.error(`[${context}] Error occurred:`, {
    code: processedError.code,
    message: processedError.message,
    userMessage: processedError.userMessage,
    timestamp: processedError.timestamp.toISOString(),
    retryable: processedError.retryable,
    ...additionalInfo,
  });

  // In development, also log the original error
  if (import.meta.env.DEV) {
    console.error('Original error:', error);
  }
}

// ============================================================================
// Toast/Notification Helpers
// ============================================================================

export interface ToastMessage {
  type: 'error' | 'warning' | 'info';
  title: string;
  message: string;
  action?: {
    label: string;
    onClick: () => void;
  };
}

/**
 * Create toast message from error
 */
export function createErrorToast(error: AppError, onRetry?: () => void): ToastMessage {
  const toast: ToastMessage = {
    type: 'error',
    title: getErrorTitle(error.code),
    message: error.userMessage,
  };

  if (error.retryable && onRetry) {
    toast.action = {
      label: 'Retry',
      onClick: onRetry,
    };
  }

  return toast;
}

/**
 * Map any error into the app-wide shared-ui toast options (ADMIN-MEDIUM-005).
 *
 * Classifies the error via `processError`, builds the module's `ToastMessage`
 * via `createErrorToast`, and adapts it to the `useToast()` options shape
 * (type→variant, message→description, action→action). The shared-ui
 * `formatErrorForToast` is intentionally NOT used here — its strings are
 * Turkish, while tenant-admin is an English-only surface.
 */
export function createErrorToastOptions(error: unknown, onRetry?: () => void): ToastOptions {
  const errorToast = createErrorToast(processError(error), onRetry);
  return {
    variant: errorToast.type,
    title: errorToast.title,
    description: errorToast.message,
    action: errorToast.action,
  };
}

/**
 * Get error title based on error code
 */
function getErrorTitle(code: ErrorCode): string {
  switch (code) {
    case ErrorCode.NETWORK_ERROR:
    case ErrorCode.TIMEOUT_ERROR:
    case ErrorCode.CONNECTION_REFUSED:
      return 'Connection Error';
    case ErrorCode.UNAUTHORIZED:
      return 'Session Expired';
    case ErrorCode.FORBIDDEN:
      return 'Access Denied';
    case ErrorCode.NOT_FOUND:
      return 'Not Found';
    case ErrorCode.VALIDATION_ERROR:
      return 'Invalid Input';
    case ErrorCode.CONFLICT:
    case ErrorCode.DUPLICATE_NAME:
      return 'Conflict';
    case ErrorCode.ROLE_IN_USE:
    case ErrorCode.SYSTEM_ROLE:
      return 'Operation Not Allowed';
    default:
      return 'Error';
  }
}

// ============================================================================
// Retry Logic
// ============================================================================

/**
 * Retry function with exponential backoff
 */
export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  options: {
    maxRetries?: number;
    initialDelay?: number;
    maxDelay?: number;
    shouldRetry?: (error: unknown) => boolean;
  } = {}
): Promise<T> {
  const { maxRetries = 3, initialDelay = 1000, maxDelay = 10000, shouldRetry } = options;

  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      // Check if we should retry
      if (shouldRetry && !shouldRetry(error)) {
        throw error;
      }

      const processedError = processError(error);
      if (!processedError.retryable) {
        throw error;
      }

      // Don't retry if we've exhausted attempts
      if (attempt === maxRetries) {
        throw error;
      }

      // Calculate delay with exponential backoff
      const delay = Math.min(initialDelay * Math.pow(2, attempt), maxDelay);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  throw lastError;
}
