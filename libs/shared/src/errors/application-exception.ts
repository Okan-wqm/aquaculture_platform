import { HttpException, HttpStatus } from '@nestjs/common';
import { ERROR_CODES, ErrorCode, ErrorDefinition } from './error-codes';

/**
 * Standardized error response format
 */
export interface ErrorResponse {
  success: false;
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
    timestamp: string;
    path?: string;
    requestId?: string;
  };
}

/**
 * Application Exception
 *
 * Standardized exception class for consistent error handling across the platform.
 * Uses predefined error codes for type-safe error handling.
 */
export class ApplicationException extends HttpException {
  public readonly errorCode: string;
  public readonly details?: Record<string, unknown>;
  public readonly timestamp: string;

  constructor(
    errorCode: ErrorCode,
    details?: Record<string, unknown>,
    customMessage?: string,
  ) {
    const errorDef = ERROR_CODES[errorCode];
    const message = customMessage || errorDef.message;

    super(
      {
        success: false,
        error: {
          code: errorDef.code,
          message,
          details,
          timestamp: new Date().toISOString(),
        },
      } as ErrorResponse,
      errorDef.status,
    );

    this.errorCode = errorDef.code;
    this.details = details;
    this.timestamp = new Date().toISOString();
  }

  /**
   * Create a validation error with field-specific details
   */
  static validation(
    fields: Record<string, string[]>,
    message?: string,
  ): ApplicationException {
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

    return new ApplicationException(
      'INTERNAL_SERVER_ERROR',
      details,
      `${resource} not found`,
    );
  }

  /**
   * Create a conflict error
   */
  static conflict(resource: string, field: string): ApplicationException {
    return new ApplicationException(
      'INTERNAL_SERVER_ERROR',
      { resource, field },
      `A ${resource} with this ${field} already exists`,
    );
  }

  /**
   * Create an unauthorized error
   */
  static unauthorized(message?: string): ApplicationException {
    return new ApplicationException(
      'AUTH_INVALID_CREDENTIALS',
      undefined,
      message,
    );
  }

  /**
   * Create a forbidden error
   */
  static forbidden(message?: string): ApplicationException {
    return new ApplicationException(
      'AUTH_FORBIDDEN',
      undefined,
      message,
    );
  }

  /**
   * Create an internal error
   */
  static internal(message?: string, details?: Record<string, unknown>): ApplicationException {
    return new ApplicationException(
      'INTERNAL_SERVER_ERROR',
      details,
      message,
    );
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
 */
export class BusinessRuleException extends ApplicationException {
  constructor(
    errorCode: ErrorCode,
    details?: Record<string, unknown>,
    customMessage?: string,
  ) {
    super(errorCode, details, customMessage);
  }
}

/**
 * Custom exception for external service failures
 */
export class ExternalServiceException extends ApplicationException {
  public readonly serviceName: string;
  public readonly originalError?: Error;

  constructor(
    serviceName: string,
    errorCode: ErrorCode = 'EXTERNAL_SERVICE_UNAVAILABLE',
    originalError?: Error,
    details?: Record<string, unknown>,
  ) {
    super(errorCode, {
      ...details,
      serviceName,
      originalMessage: originalError?.message,
    });
    this.serviceName = serviceName;
    this.originalError = originalError;
  }
}

/**
 * Custom exception for validation failures
 */
export class ValidationException extends ApplicationException {
  public readonly fieldErrors: Record<string, string[]>;

  constructor(
    fieldErrors: Record<string, string[]>,
    message?: string,
  ) {
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
