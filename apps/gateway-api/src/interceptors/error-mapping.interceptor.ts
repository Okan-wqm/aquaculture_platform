/**
 * Error Mapping Interceptor
 *
 * Maps internal errors to appropriate HTTP responses.
 * Provides user-friendly error messages and error tracking.
 * Supports different error detail levels for development vs production.
 */

import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
  Logger,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { Observable, throwError } from 'rxjs';
import { catchError } from 'rxjs/operators';
import { Request, Response } from 'express';
import { GqlExecutionContext } from '@nestjs/graphql';
import { randomUUID } from 'crypto';

/**
 * Error mapping configuration
 */
export interface ErrorMappingConfig {
  includeStack: boolean;
  includeDetails: boolean;
  logLevel: 'error' | 'warn' | 'debug';
}

/**
 * Mapped error response
 */
export interface MappedErrorResponse {
  success: false;
  error: {
    code: string;
    message: string;
    details?: unknown;
    stack?: string;
    trackingId: string;
  };
  meta: {
    timestamp: string;
    path: string;
    method: string;
    statusCode: number;
    correlationId?: string;
  };
}

/**
 * Business error codes and their HTTP status mappings
 */
const ERROR_CODE_MAP: Record<string, { status: number; message: string }> = {
  // Authentication errors
  AUTH_INVALID_CREDENTIALS: { status: 401, message: 'Invalid credentials' },
  AUTH_TOKEN_EXPIRED: { status: 401, message: 'Token has expired' },
  AUTH_TOKEN_INVALID: { status: 401, message: 'Invalid token' },
  AUTH_INSUFFICIENT_PERMISSIONS: { status: 403, message: 'Insufficient permissions' },
  AUTH_ACCOUNT_LOCKED: { status: 403, message: 'Account is locked' },
  AUTH_ACCOUNT_DISABLED: { status: 403, message: 'Account is disabled' },

  // Resource errors
  RESOURCE_NOT_FOUND: { status: 404, message: 'Resource not found' },
  RESOURCE_ALREADY_EXISTS: { status: 409, message: 'Resource already exists' },
  RESOURCE_CONFLICT: { status: 409, message: 'Resource conflict' },
  RESOURCE_GONE: { status: 410, message: 'Resource no longer available' },

  // Validation errors
  VALIDATION_FAILED: { status: 422, message: 'Validation failed' },
  INVALID_INPUT: { status: 400, message: 'Invalid input' },
  MISSING_REQUIRED_FIELD: { status: 400, message: 'Missing required field' },

  // Rate limiting
  RATE_LIMIT_EXCEEDED: { status: 429, message: 'Too many requests' },
  QUOTA_EXCEEDED: { status: 429, message: 'Quota exceeded' },

  // Business logic errors
  BUSINESS_RULE_VIOLATION: { status: 400, message: 'Business rule violation' },
  OPERATION_NOT_ALLOWED: { status: 400, message: 'Operation not allowed' },
  PRECONDITION_FAILED: { status: 412, message: 'Precondition failed' },

  // Tenant errors
  TENANT_NOT_FOUND: { status: 404, message: 'Tenant not found' },
  TENANT_SUSPENDED: { status: 403, message: 'Tenant is suspended' },
  TENANT_LIMIT_EXCEEDED: { status: 429, message: 'Tenant limit exceeded' },

  // External service errors
  EXTERNAL_SERVICE_ERROR: { status: 502, message: 'External service error' },
  EXTERNAL_SERVICE_TIMEOUT: { status: 504, message: 'External service timeout' },
  EXTERNAL_SERVICE_UNAVAILABLE: { status: 503, message: 'External service unavailable' },

  // Database errors
  DATABASE_ERROR: { status: 500, message: 'Database error' },
  DATABASE_CONNECTION_ERROR: { status: 503, message: 'Database connection error' },
  DATABASE_CONSTRAINT_VIOLATION: { status: 409, message: 'Database constraint violation' },

  // Generic errors
  INTERNAL_ERROR: { status: 500, message: 'Internal server error' },
  NOT_IMPLEMENTED: { status: 501, message: 'Not implemented' },
  SERVICE_UNAVAILABLE: { status: 503, message: 'Service unavailable' },
};

/**
 * User-friendly messages for common error patterns
 */
const USER_FRIENDLY_MESSAGES: Record<string, string> = {
  'duplicate key': 'A record with this identifier already exists',
  'foreign key constraint': 'Cannot perform operation due to related records',
  'unique constraint': 'A record with this value already exists',
  'not null violation': 'A required field is missing',
  'connection refused': 'Service is temporarily unavailable',
  'timeout': 'Request took too long to process',
  'econnrefused': 'Service is temporarily unavailable',
  'enotfound': 'Service is temporarily unavailable',
};

/**
 * Error Mapping Interceptor
 * Maps errors to appropriate HTTP responses
 */
@Injectable()
export class ErrorMappingInterceptor implements NestInterceptor {
  private readonly logger = new Logger(ErrorMappingInterceptor.name);
  private readonly isProduction = process.env['NODE_ENV'] === 'production';
  private readonly config: ErrorMappingConfig;

  constructor() {
    this.config = {
      includeStack: !this.isProduction,
      includeDetails: !this.isProduction,
      logLevel: this.isProduction ? 'error' : 'warn',
    };
  }

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const contextType = context.getType<string>();
    const isGraphQL = contextType === 'graphql';

    let request: Request;
    let response: Response | undefined;

    if (isGraphQL) {
      const gqlContext = GqlExecutionContext.create(context);
      const ctx = gqlContext.getContext();
      request = ctx.req;
      response = ctx.res;
    } else {
      request = context.switchToHttp().getRequest<Request>();
      response = context.switchToHttp().getResponse<Response>();
    }

    return next.handle().pipe(
      catchError((error) => {
        const mappedError = this.mapError(error, request, response);
        return throwError(() => mappedError);
      }),
    );
  }

  /**
   * Map error to HTTP exception
   */
  private mapError(
    error: Error,
    request: Request,
    response?: Response,
  ): HttpException {
    const trackingId = randomUUID();
    const correlationId = request.headers['x-correlation-id'] as string;

    // Log the error
    this.logError(error, trackingId, correlationId, request);

    // If already an HttpException, enhance it
    if (error instanceof HttpException) {
      return this.enhanceHttpException(error, trackingId);
    }

    // Map by error code if present
    const errorCode = (error as Error & { code?: string }).code;
    if (errorCode && ERROR_CODE_MAP[errorCode]) {
      return this.createMappedException(
        errorCode,
        error,
        trackingId,
        request,
        response,
      );
    }

    // Map by error type/name
    const mappedByType = this.mapByErrorType(error, trackingId, request);
    if (mappedByType) {
      return mappedByType;
    }

    // Map by error message patterns
    const mappedByMessage = this.mapByErrorMessage(error, trackingId, request);
    if (mappedByMessage) {
      return mappedByMessage;
    }

    // Default to internal server error
    return this.createInternalServerError(error, trackingId, request);
  }

  /**
   * Enhance existing HTTP exception with tracking ID
   */
  private enhanceHttpException(
    exception: HttpException,
    trackingId: string,
  ): HttpException {
    const response = exception.getResponse();
    const status = exception.getStatus();

    if (typeof response === 'object' && response !== null) {
      const enhanced = {
        ...response,
        trackingId,
      };
      return new HttpException(enhanced, status);
    }

    return new HttpException(
      {
        message: response,
        trackingId,
      },
      status,
    );
  }

  /**
   * Create mapped exception from error code
   */
  private createMappedException(
    errorCode: string,
    error: Error,
    trackingId: string,
    request: Request,
    response?: Response,
  ): HttpException {
    const mapping = ERROR_CODE_MAP[errorCode] || { status: 500, message: 'Unknown error' };

    const errorResponse: MappedErrorResponse = {
      success: false,
      error: {
        code: errorCode,
        message: mapping.message,
        trackingId,
      },
      meta: {
        timestamp: new Date().toISOString(),
        path: request.originalUrl || request.url,
        method: request.method,
        statusCode: mapping.status,
        correlationId: request.headers['x-correlation-id'] as string,
      },
    };

    if (this.config.includeDetails) {
      errorResponse.error.details = error.message;
    }

    if (this.config.includeStack) {
      errorResponse.error.stack = error.stack;
    }

    // Add Retry-After header for rate limit errors
    if (mapping.status === 429 && response) {
      response.setHeader('Retry-After', '60');
    }

    return new HttpException(errorResponse, mapping.status);
  }

  /**
   * Map error by its type/name
   */
  private mapByErrorType(
    error: Error,
    trackingId: string,
    request: Request,
  ): HttpException | null {
    const typeMapping: Record<string, string> = {
      TypeError: 'INTERNAL_ERROR',
      ReferenceError: 'INTERNAL_ERROR',
      SyntaxError: 'INTERNAL_ERROR',
      ValidationError: 'VALIDATION_FAILED',
      AuthenticationError: 'AUTH_INVALID_CREDENTIALS',
      AuthorizationError: 'AUTH_INSUFFICIENT_PERMISSIONS',
      NotFoundError: 'RESOURCE_NOT_FOUND',
      ConflictError: 'RESOURCE_CONFLICT',
      TimeoutError: 'EXTERNAL_SERVICE_TIMEOUT',
    };

    const errorCode = typeMapping[error.name];
    if (errorCode) {
      return this.createMappedException(errorCode, error, trackingId, request);
    }

    return null;
  }

  /**
   * Map error by message patterns
   */
  private mapByErrorMessage(
    error: Error,
    trackingId: string,
    request: Request,
  ): HttpException | null {
    const message = error.message.toLowerCase();

    // Check for known patterns
    for (const [pattern, userMessage] of Object.entries(USER_FRIENDLY_MESSAGES)) {
      if (message.includes(pattern)) {
        const status = this.inferStatusFromPattern(pattern);
        return this.createPatternMappedException(
          userMessage,
          status,
          error,
          trackingId,
          request,
        );
      }
    }

    return null;
  }

  /**
   * Infer HTTP status from error pattern
   */
  private inferStatusFromPattern(pattern: string): number {
    if (pattern.includes('duplicate') || pattern.includes('unique') || pattern.includes('constraint')) {
      return HttpStatus.CONFLICT;
    }
    if (pattern.includes('connection') || pattern.includes('econnrefused') || pattern.includes('enotfound')) {
      return HttpStatus.SERVICE_UNAVAILABLE;
    }
    if (pattern.includes('timeout')) {
      return HttpStatus.GATEWAY_TIMEOUT;
    }
    return HttpStatus.INTERNAL_SERVER_ERROR;
  }

  /**
   * Create exception from pattern match
   */
  private createPatternMappedException(
    userMessage: string,
    status: number,
    error: Error,
    trackingId: string,
    request: Request,
  ): HttpException {
    const errorResponse: MappedErrorResponse = {
      success: false,
      error: {
        code: this.statusToCode(status),
        message: userMessage,
        trackingId,
      },
      meta: {
        timestamp: new Date().toISOString(),
        path: request.originalUrl || request.url,
        method: request.method,
        statusCode: status,
        correlationId: request.headers['x-correlation-id'] as string,
      },
    };

    if (this.config.includeDetails) {
      errorResponse.error.details = error.message;
    }

    return new HttpException(errorResponse, status);
  }

  /**
   * Create internal server error
   */
  private createInternalServerError(
    error: Error,
    trackingId: string,
    request: Request,
  ): HttpException {
    const errorResponse: MappedErrorResponse = {
      success: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: this.isProduction
          ? 'An unexpected error occurred. Please try again later.'
          : error.message,
        trackingId,
      },
      meta: {
        timestamp: new Date().toISOString(),
        path: request.originalUrl || request.url,
        method: request.method,
        statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
        correlationId: request.headers['x-correlation-id'] as string,
      },
    };

    if (this.config.includeStack) {
      errorResponse.error.stack = error.stack;
    }

    return new HttpException(errorResponse, HttpStatus.INTERNAL_SERVER_ERROR);
  }

  /**
   * Convert HTTP status to error code
   */
  private statusToCode(status: number): string {
    const statusMap: Record<number, string> = {
      [HttpStatus.BAD_REQUEST]: 'BAD_REQUEST',
      [HttpStatus.UNAUTHORIZED]: 'UNAUTHORIZED',
      [HttpStatus.FORBIDDEN]: 'FORBIDDEN',
      [HttpStatus.NOT_FOUND]: 'NOT_FOUND',
      [HttpStatus.CONFLICT]: 'CONFLICT',
      [HttpStatus.UNPROCESSABLE_ENTITY]: 'VALIDATION_FAILED',
      [HttpStatus.TOO_MANY_REQUESTS]: 'RATE_LIMIT_EXCEEDED',
      [HttpStatus.INTERNAL_SERVER_ERROR]: 'INTERNAL_ERROR',
      [HttpStatus.BAD_GATEWAY]: 'BAD_GATEWAY',
      [HttpStatus.SERVICE_UNAVAILABLE]: 'SERVICE_UNAVAILABLE',
      [HttpStatus.GATEWAY_TIMEOUT]: 'GATEWAY_TIMEOUT',
    };

    return statusMap[status] || 'ERROR';
  }

  /**
   * Log error
   */
  private logError(
    error: Error,
    trackingId: string,
    correlationId: string | undefined,
    request: Request,
  ): void {
    const logContext = {
      trackingId,
      correlationId,
      path: request.path,
      method: request.method,
      ip: request.ip,
      userAgent: request.headers['user-agent'],
      errorName: error.name,
      errorMessage: error.message,
    };

    switch (this.config.logLevel) {
      case 'error':
        this.logger.error(error.message, error.stack, JSON.stringify(logContext));
        break;
      case 'warn':
        this.logger.warn(error.message, JSON.stringify(logContext));
        break;
      case 'debug':
        this.logger.debug(error.message, JSON.stringify(logContext));
        break;
    }
  }
}

/**
 * Business error class
 */
export class BusinessError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'BusinessError';
  }
}

/**
 * Create a business error
 */
export function createBusinessError(
  code: string,
  message: string,
  details?: unknown,
): BusinessError {
  return new BusinessError(code, message, details);
}

/**
 * Throw a business error
 */
export function throwBusinessError(
  code: string,
  message: string,
  details?: unknown,
): never {
  throw new BusinessError(code, message, details);
}
