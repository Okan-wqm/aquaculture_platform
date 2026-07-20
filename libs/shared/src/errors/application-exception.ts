// TODO(ARCH-CRIT-002): Gradual migration — replace HttpException throws with ApplicationException
//
// Problem: Most service code still uses raw NestJS throw new NotFoundException() /
// BadRequestException() / HttpException() instead of ApplicationException or its typed
// subclasses. This means responses from those code paths don't carry typed ErrorCode values
// and bypass the structured { success, error: { code, message, details, ... } } envelope.
//
// Migration approach (gradual, per domain):
//   1. Identify service handlers / resolvers that throw raw NestJS exceptions
//   2. Replace with ApplicationException.notFound(), .conflict(), .validation(), etc.
//      or with domain-specific subclasses (BusinessRuleException, ValidationException)
//   3. Register new error codes in error-codes.ts as needed (following numeric ranges)
//   4. Update tests to assert on { success: false, error: { code: 'RESOURCE_NOT_FOUND' } }
//      rather than raw HTTP status codes
//
// Do NOT migrate everything at once — tackle one service at a time after it has been
// switched to GlobalExceptionFilter (see ARCH-CRIT-001 in global-exception.filter.ts).
import { HttpException, Logger } from '@nestjs/common';

import { ERROR_CODES, ErrorCode } from './error-codes';
import type { ErrorResponse } from './error-envelope';

export type { ErrorResponse } from './error-envelope';

/**
 * Application Exception
 *
 * Standardized exception class for consistent error handling across the platform.
 * Uses predefined error codes for type-safe error handling.
 *
 * The `category` field allows callers and monitoring tools to distinguish between
 * different classes of errors without having to inspect the error code string.
 */
export class ApplicationException extends HttpException {
  public readonly errorCode: string;
  public readonly details?: Record<string, unknown>;
  public readonly timestamp: string;
  /**
   * Broad category for this exception. Set by subclasses.
   * - 'application' — generic application-level error (default)
   * - 'business'    — a domain/business rule was violated (set by BusinessRuleException)
   * - 'validation'  — input validation failed (set by ValidationException)
   * - 'external'    — a downstream service call failed (set by ExternalServiceException)
   */
  public readonly category: 'application' | 'business' | 'validation' | 'external' = 'application';

  constructor(errorCode: ErrorCode, details?: Record<string, unknown>, customMessage?: string) {
    const errorDef = ERROR_CODES[errorCode];
    const message = customMessage || errorDef.message;
    const timestamp = new Date().toISOString();

    super(
      {
        success: false,
        error: {
          code: errorDef.code,
          message,
          details,
          timestamp,
        },
      } as ErrorResponse,
      errorDef.status,
    );

    this.errorCode = errorDef.code;
    this.details = details;
    this.timestamp = timestamp;
  }

  /**
   * Create a validation error with field-specific details
   */
  static validation(fields: Record<string, string[]>, message?: string): ApplicationException {
    return new ApplicationException(
      'VALIDATION_FAILED',
      { fields },
      message || 'Validation failed for one or more fields',
    );
  }

  /**
   * Create a not found error for a specific resource
   */
  static notFound(resource: string, id?: string): ApplicationException {
    const details: Record<string, unknown> = { resource };
    if (id) details.id = id;

    // Try to find a specific error code for the resource
    const specificCode = `${resource.toUpperCase()}_NOT_FOUND` as ErrorCode;
    if (specificCode in ERROR_CODES) {
      return new ApplicationException(specificCode, details);
    }

    // Fallback to generic 404 instead of 500
    if (process.env.NODE_ENV !== 'production') {
      const logger = new Logger('ApplicationException');
      logger.warn(
        `No specific error code found for "${resource}_NOT_FOUND". ` +
          `Register it in ERROR_CODES for better error discrimination.`,
      );
    }

    return new ApplicationException('RESOURCE_NOT_FOUND', details, `${resource} not found`);
  }

  /**
   * Create a conflict error
   */
  static conflict(resource: string, field: string): ApplicationException {
    // Try to find a specific conflict code (e.g., USER_EMAIL_EXISTS)
    const specificCode = `${resource.toUpperCase()}_${field.toUpperCase()}_EXISTS` as ErrorCode;
    if (specificCode in ERROR_CODES) {
      return new ApplicationException(specificCode, { resource, field });
    }

    // Fallback to generic 409 instead of 500
    return new ApplicationException(
      'RESOURCE_CONFLICT',
      { resource, field },
      `A ${resource} with this ${field} already exists`,
    );
  }

  /**
   * Create an unauthorized error
   */
  static unauthorized(message?: string): ApplicationException {
    return new ApplicationException('AUTH_INVALID_CREDENTIALS', undefined, message);
  }

  /**
   * Create a forbidden error
   */
  static forbidden(message?: string): ApplicationException {
    return new ApplicationException('AUTH_FORBIDDEN', undefined, message);
  }

  /**
   * Create an internal error
   */
  static internal(message?: string, details?: Record<string, unknown>): ApplicationException {
    return new ApplicationException('INTERNAL_SERVER_ERROR', details, message);
  }

  /**
   * Get the error response object
   */
  getErrorResponse(): ErrorResponse {
    return this.getResponse() as ErrorResponse;
  }
}

/**
 * Custom exception for business rule violations
 *
 * Use when a domain invariant or business policy is violated (e.g. "cannot close a batch
 * that already has an active harvest"). The `isRetryable` flag signals whether the caller
 * may retry without changing input (e.g. transient lock contention = true, rule violation = false).
 */
export class BusinessRuleException extends ApplicationException {
  public override readonly category = 'business' as const;
  public readonly isRetryable: boolean;

  constructor(
    errorCode: ErrorCode,
    details?: Record<string, unknown>,
    customMessage?: string,
    isRetryable = false,
  ) {
    super(errorCode, details, customMessage);
    this.isRetryable = isRetryable;
  }
}

/**
 * Custom exception for external service failures
 *
 * Use when a call to a downstream service (email, payment gateway, MinIO, NATS, etc.) fails.
 * The `originalError` is retained for internal logging but its message is stripped in
 * production to prevent leaking internal hostnames, connection strings, or API key prefixes.
 */
export class ExternalServiceException extends ApplicationException {
  public override readonly category = 'external' as const;
  public readonly serviceName: string;
  public readonly originalError?: Error;

  constructor(
    serviceName: string,
    errorCode: ErrorCode = 'EXTERNAL_SERVICE_UNAVAILABLE',
    originalError?: Error,
    details?: Record<string, unknown>,
  ) {
    const isProduction = process.env.NODE_ENV === 'production';
    super(errorCode, {
      ...details,
      serviceName,
      // Strip original error message in production to prevent leaking
      // internal hostnames, connection strings, or API key prefixes
      ...(isProduction ? {} : { originalMessage: originalError?.message }),
    });
    this.serviceName = serviceName;
    this.originalError = originalError;
  }
}

/**
 * Custom exception for validation failures
 *
 * Use when request/command input fails validation. Carries per-field error arrays so the
 * client can display field-level error messages in forms.
 *
 * The `category` is set to 'validation' to allow callers to distinguish input errors from
 * business-rule violations without inspecting the error code string.
 */
export class ValidationException extends ApplicationException {
  public override readonly category = 'validation' as const;
  public readonly fieldErrors: Record<string, string[]>;

  constructor(fieldErrors: Record<string, string[]>, message?: string) {
    super('VALIDATION_FAILED', { fields: fieldErrors }, message);
    this.fieldErrors = fieldErrors;
  }

  /**
   * Create from a single field error
   */
  static fromField(field: string, error: string): ValidationException {
    return new ValidationException({ [field]: [error] });
  }

  /**
   * Create from multiple field errors
   */
  static fromFields(fields: Record<string, string | string[]>): ValidationException {
    const normalizedFields: Record<string, string[]> = {};
    for (const [key, value] of Object.entries(fields)) {
      normalizedFields[key] = Array.isArray(value) ? value : [value];
    }
    return new ValidationException(normalizedFields);
  }
}
