/**
 * Error Types
 * Standardized error codes and utilities for consistent error handling
 */

import { GraphQLClientError } from './api-client';

// ============================================================================
// Error Codes
// ============================================================================

/**
 * Standardized error codes matching backend GraphQL error codes
 */
export enum ErrorCode {
  // Network/Connection errors
  NETWORK_ERROR = 'NETWORK_ERROR',
  TIMEOUT = 'TIMEOUT',
  SERVICE_UNAVAILABLE = 'SERVICE_UNAVAILABLE',

  // Authentication errors
  UNAUTHENTICATED = 'UNAUTHENTICATED',
  TOKEN_EXPIRED = 'TOKEN_EXPIRED',
  INVALID_TOKEN = 'INVALID_TOKEN',

  // Authorization errors
  FORBIDDEN = 'FORBIDDEN',
  INSUFFICIENT_PERMISSION = 'INSUFFICIENT_PERMISSION',

  // Validation errors
  BAD_REQUEST = 'BAD_REQUEST',
  VALIDATION_ERROR = 'VALIDATION_ERROR',

  // Resource errors
  NOT_FOUND = 'NOT_FOUND',
  CONFLICT = 'CONFLICT',

  // Context errors
  TENANT_REQUIRED = 'TENANT_REQUIRED',
  INVALID_TENANT = 'INVALID_TENANT',

  // Server errors
  INTERNAL_SERVER_ERROR = 'INTERNAL_SERVER_ERROR',
  GRAPHQL_ERROR = 'GRAPHQL_ERROR',

  // Unknown
  UNKNOWN = 'UNKNOWN',
}

// ============================================================================
// Error Types
// ============================================================================

/**
 * Recovery actions that can be presented to the user
 */
export type RecoveryAction = 'retry' | 'login' | 'contact_admin' | 'select_tenant' | 'refresh' | 'none';

/**
 * Application error interface
 */
export interface AppError {
  code: ErrorCode;
  message: string;
  userMessage: string;
  recoveryAction: RecoveryAction;
  details?: Record<string, unknown>;
}

// ============================================================================
// Error Messages (Turkish)
// ============================================================================

const ERROR_MESSAGES: Record<ErrorCode, { userMessage: string; recoveryAction: RecoveryAction }> = {
  [ErrorCode.NETWORK_ERROR]: {
    userMessage: 'Sunucuya bağlanılamadı. Lütfen internet bağlantınızı kontrol edin.',
    recoveryAction: 'retry',
  },
  [ErrorCode.TIMEOUT]: {
    userMessage: 'İstek zaman aşımına uğradı. Lütfen tekrar deneyin.',
    recoveryAction: 'retry',
  },
  [ErrorCode.SERVICE_UNAVAILABLE]: {
    userMessage: 'Servis şu anda kullanılamıyor. Lütfen daha sonra tekrar deneyin.',
    recoveryAction: 'retry',
  },
  [ErrorCode.UNAUTHENTICATED]: {
    userMessage: 'Oturum süresi doldu. Lütfen tekrar giriş yapın.',
    recoveryAction: 'login',
  },
  [ErrorCode.TOKEN_EXPIRED]: {
    userMessage: 'Oturum süresi doldu. Lütfen tekrar giriş yapın.',
    recoveryAction: 'login',
  },
  [ErrorCode.INVALID_TOKEN]: {
    userMessage: 'Geçersiz oturum. Lütfen tekrar giriş yapın.',
    recoveryAction: 'login',
  },
  [ErrorCode.FORBIDDEN]: {
    userMessage: 'Bu işlem için yetkiniz bulunmuyor.',
    recoveryAction: 'contact_admin',
  },
  [ErrorCode.INSUFFICIENT_PERMISSION]: {
    userMessage: 'Bu işlem için yeterli yetkiniz yok.',
    recoveryAction: 'contact_admin',
  },
  [ErrorCode.BAD_REQUEST]: {
    userMessage: 'Geçersiz istek. Lütfen girdiğiniz bilgileri kontrol edin.',
    recoveryAction: 'none',
  },
  [ErrorCode.VALIDATION_ERROR]: {
    userMessage: 'Girilen bilgilerde hata var. Lütfen kontrol edin.',
    recoveryAction: 'none',
  },
  [ErrorCode.NOT_FOUND]: {
    userMessage: 'İstenen kayıt bulunamadı.',
    recoveryAction: 'none',
  },
  [ErrorCode.CONFLICT]: {
    userMessage: 'Bu kayıt zaten mevcut veya çakışma var.',
    recoveryAction: 'refresh',
  },
  [ErrorCode.TENANT_REQUIRED]: {
    userMessage: 'Organizasyon seçimi gerekli. Lütfen bir organizasyon seçin.',
    recoveryAction: 'select_tenant',
  },
  [ErrorCode.INVALID_TENANT]: {
    userMessage: 'Geçersiz organizasyon. Lütfen tekrar giriş yapın.',
    recoveryAction: 'login',
  },
  [ErrorCode.INTERNAL_SERVER_ERROR]: {
    userMessage: 'Sunucu hatası oluştu. Lütfen daha sonra tekrar deneyin.',
    recoveryAction: 'retry',
  },
  [ErrorCode.GRAPHQL_ERROR]: {
    userMessage: 'Bir hata oluştu. Lütfen tekrar deneyin.',
    recoveryAction: 'retry',
  },
  [ErrorCode.UNKNOWN]: {
    userMessage: 'Beklenmeyen bir hata oluştu. Lütfen tekrar deneyin.',
    recoveryAction: 'retry',
  },
};

// ============================================================================
// Error Parsing
// ============================================================================

/**
 * Parse GraphQL error code from response
 */
function parseErrorCode(error: unknown): ErrorCode {
  if (error instanceof GraphQLClientError) {
    // Map GraphQL client error codes
    const code = error.code?.toUpperCase();

    if (code === 'NETWORK_ERROR') return ErrorCode.NETWORK_ERROR;
    if (code === 'TIMEOUT') return ErrorCode.TIMEOUT;
    if (code === 'UNAUTHENTICATED') return ErrorCode.UNAUTHENTICATED;
    if (code === 'FORBIDDEN') return ErrorCode.FORBIDDEN;
    if (code === 'BAD_USER_INPUT' || code === 'BAD_REQUEST') return ErrorCode.BAD_REQUEST;
    if (code === 'NOT_FOUND') return ErrorCode.NOT_FOUND;
    if (code === 'TENANT_REQUIRED') return ErrorCode.TENANT_REQUIRED;
    if (code === 'INTERNAL_SERVER_ERROR') return ErrorCode.INTERNAL_SERVER_ERROR;
    if (code === 'SERVICE_UNAVAILABLE') return ErrorCode.SERVICE_UNAVAILABLE;

    // Check for specific messages
    const message = error.message?.toLowerCase() || '';
    if (message.includes('network') || message.includes('fetch')) return ErrorCode.NETWORK_ERROR;
    if (message.includes('timeout') || message.includes('zaman aşımı')) return ErrorCode.TIMEOUT;
    if (message.includes('oturum') || message.includes('session')) return ErrorCode.UNAUTHENTICATED;
    if (message.includes('tenant')) return ErrorCode.TENANT_REQUIRED;

    return ErrorCode.GRAPHQL_ERROR;
  }

  if (error instanceof Error) {
    const message = error.message?.toLowerCase() || '';

    if (message.includes('network') || message.includes('fetch')) return ErrorCode.NETWORK_ERROR;
    if (message.includes('timeout')) return ErrorCode.TIMEOUT;
    if (message.includes('unauthorized') || message.includes('401')) return ErrorCode.UNAUTHENTICATED;
    if (message.includes('forbidden') || message.includes('403')) return ErrorCode.FORBIDDEN;
    if (message.includes('not found') || message.includes('404')) return ErrorCode.NOT_FOUND;
  }

  return ErrorCode.UNKNOWN;
}

/**
 * Parse any error into a standardized AppError
 */
export function parseError(error: unknown): AppError {
  const code = parseErrorCode(error);
  const errorConfig = ERROR_MESSAGES[code];

  // Get original error message
  let originalMessage = 'Unknown error';
  if (error instanceof Error) {
    originalMessage = error.message;
  } else if (typeof error === 'string') {
    originalMessage = error;
  }

  return {
    code,
    message: originalMessage,
    userMessage: errorConfig.userMessage,
    recoveryAction: errorConfig.recoveryAction,
    details: error instanceof GraphQLClientError ? { graphqlErrors: error.graphqlErrors } : undefined,
  };
}

/**
 * Check if error is retryable
 */
export function isRetryableError(error: AppError): boolean {
  return error.recoveryAction === 'retry';
}

/**
 * Check if error requires re-authentication
 */
export function requiresReauth(error: AppError): boolean {
  return error.recoveryAction === 'login';
}

/**
 * Create a simple AppError from code
 */
export function createError(code: ErrorCode, details?: Record<string, unknown>): AppError {
  const errorConfig = ERROR_MESSAGES[code];
  return {
    code,
    message: errorConfig.userMessage,
    userMessage: errorConfig.userMessage,
    recoveryAction: errorConfig.recoveryAction,
    details,
  };
}
