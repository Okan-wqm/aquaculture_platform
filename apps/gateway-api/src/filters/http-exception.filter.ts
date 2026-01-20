/**
 * HTTP Exception Filter
 *
 * Handles HTTP exceptions and provides standardized error responses.
 * Maps HTTP status codes to appropriate error messages and formats.
 * Supports detailed error information in development mode.
 */

import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { GqlArgumentsHost, GqlContextType } from '@nestjs/graphql';
import { Request, Response } from 'express';

/**
 * Standard error response format
 */
export interface HttpErrorResponse {
  success: false;
  error: {
    code: string;
    message: string;
    details?: unknown;
    field?: string;
    validationErrors?: ValidationError[];
  };
  meta: {
    timestamp: string;
    path: string;
    method: string;
    statusCode: number;
    correlationId?: string;
    requestId?: string;
  };
}

/**
 * Validation error details
 */
export interface ValidationError {
  field: string;
  message: string;
  code: string;
  value?: unknown;
}

/**
 * HTTP status code to error code mapping
 */
const STATUS_CODE_MAP: Record<number, string> = {
  [HttpStatus.BAD_REQUEST]: 'BAD_REQUEST',
  [HttpStatus.UNAUTHORIZED]: 'UNAUTHORIZED',
  [HttpStatus.FORBIDDEN]: 'FORBIDDEN',
  [HttpStatus.NOT_FOUND]: 'NOT_FOUND',
  [HttpStatus.METHOD_NOT_ALLOWED]: 'METHOD_NOT_ALLOWED',
  [HttpStatus.NOT_ACCEPTABLE]: 'NOT_ACCEPTABLE',
  [HttpStatus.REQUEST_TIMEOUT]: 'REQUEST_TIMEOUT',
  [HttpStatus.CONFLICT]: 'CONFLICT',
  [HttpStatus.GONE]: 'GONE',
  [HttpStatus.PAYLOAD_TOO_LARGE]: 'PAYLOAD_TOO_LARGE',
  [HttpStatus.UNSUPPORTED_MEDIA_TYPE]: 'UNSUPPORTED_MEDIA_TYPE',
  [HttpStatus.UNPROCESSABLE_ENTITY]: 'UNPROCESSABLE_ENTITY',
  [HttpStatus.TOO_MANY_REQUESTS]: 'TOO_MANY_REQUESTS',
  [HttpStatus.INTERNAL_SERVER_ERROR]: 'INTERNAL_SERVER_ERROR',
  [HttpStatus.NOT_IMPLEMENTED]: 'NOT_IMPLEMENTED',
  [HttpStatus.BAD_GATEWAY]: 'BAD_GATEWAY',
  [HttpStatus.SERVICE_UNAVAILABLE]: 'SERVICE_UNAVAILABLE',
  [HttpStatus.GATEWAY_TIMEOUT]: 'GATEWAY_TIMEOUT',
};

/**
 * User-friendly messages for each status code
 */
const USER_FRIENDLY_MESSAGES: Record<number, string> = {
  [HttpStatus.BAD_REQUEST]: 'The request was invalid or cannot be processed.',
  [HttpStatus.UNAUTHORIZED]: 'Authentication is required to access this resource.',
  [HttpStatus.FORBIDDEN]: 'You do not have permission to access this resource.',
  [HttpStatus.NOT_FOUND]: 'The requested resource was not found.',
  [HttpStatus.METHOD_NOT_ALLOWED]: 'The HTTP method is not allowed for this resource.',
  [HttpStatus.NOT_ACCEPTABLE]: 'The requested format is not supported.',
  [HttpStatus.REQUEST_TIMEOUT]: 'The request took too long to process.',
  [HttpStatus.CONFLICT]: 'The request conflicts with the current state of the resource.',
  [HttpStatus.GONE]: 'The requested resource is no longer available.',
  [HttpStatus.PAYLOAD_TOO_LARGE]: 'The request payload is too large.',
  [HttpStatus.UNSUPPORTED_MEDIA_TYPE]: 'The media type is not supported.',
  [HttpStatus.UNPROCESSABLE_ENTITY]: 'The request data could not be processed.',
  [HttpStatus.TOO_MANY_REQUESTS]: 'Too many requests. Please try again later.',
  [HttpStatus.INTERNAL_SERVER_ERROR]: 'An unexpected error occurred. Please try again later.',
  [HttpStatus.NOT_IMPLEMENTED]: 'This feature is not yet implemented.',
  [HttpStatus.BAD_GATEWAY]: 'The upstream service is temporarily unavailable.',
  [HttpStatus.SERVICE_UNAVAILABLE]: 'The service is temporarily unavailable.',
  [HttpStatus.GATEWAY_TIMEOUT]: 'The upstream service did not respond in time.',
};

/**
 * GraphQL context interface
 */
interface GqlContext {
  req?: Request;
}

/**
 * HTTP Exception Filter
 * Catches and handles all HTTP exceptions
 */
@Catch(HttpException)
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpExceptionFilter.name);
  private readonly isProduction = process.env['NODE_ENV'] === 'production';

  catch(exception: HttpException, host: ArgumentsHost): void {
    const contextType = host.getType<GqlContextType>();

    if (contextType === 'graphql') {
      this.handleGraphQLException(exception, host);
    } else {
      this.handleHttpException(exception, host);
    }
  }

  /**
   * Handle HTTP context exception
   */
  private handleHttpException(exception: HttpException, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const request = ctx.getRequest<Request>();
    const response = ctx.getResponse<Response>();

    const statusCode = exception.getStatus();
    const exceptionResponse = exception.getResponse();

    const errorResponse = this.buildErrorResponse(
      exception,
      statusCode,
      exceptionResponse,
      request,
    );

    // Add special headers for specific status codes
    this.addSpecialHeaders(response, statusCode, exceptionResponse);

    // Log the error
    this.logError(exception, errorResponse, request);

    response.status(statusCode).json(errorResponse);
  }

  /**
   * Handle GraphQL context exception
   */
  private handleGraphQLException(exception: HttpException, host: ArgumentsHost): void {
    const gqlHost = GqlArgumentsHost.create(host);
    const ctx = gqlHost.getContext<GqlContext>();
    const request = ctx.req;

    const statusCode = exception.getStatus();
    const exceptionResponse = exception.getResponse();

    const errorResponse = this.buildErrorResponse(
      exception,
      statusCode,
      exceptionResponse,
      request,
    );

    this.logError(exception, errorResponse, request);

    // For GraphQL, we throw the exception to be handled by Apollo
    throw exception;
  }

  /**
   * Build standardized error response
   */
  private buildErrorResponse(
    exception: HttpException,
    statusCode: number,
    exceptionResponse: unknown,
    request?: Request,
  ): HttpErrorResponse {
    const code = STATUS_CODE_MAP[statusCode] ?? 'ERROR';
    const timestamp = new Date().toISOString();
    const path = request?.originalUrl ?? request?.url ?? '/';
    const method = request?.method ?? 'UNKNOWN';

    // Extract correlation ID
    const correlationIdHeader = request?.headers?.['x-correlation-id'];
    const requestIdHeader = request?.headers?.['x-request-id'];
    const correlationId =
      (typeof correlationIdHeader === 'string' ? correlationIdHeader : undefined) ??
      (typeof requestIdHeader === 'string' ? requestIdHeader : undefined);

    // Extract message and details
    let message: string;
    let details: unknown;
    let validationErrors: ValidationError[] | undefined;

    if (typeof exceptionResponse === 'string') {
      message = exceptionResponse;
    } else if (typeof exceptionResponse === 'object' && exceptionResponse !== null) {
      const responseObj = exceptionResponse as Record<string, unknown>;

      message =
        (responseObj['message'] as string) ||
        USER_FRIENDLY_MESSAGES[statusCode] ||
        'An error occurred';

      // Handle validation errors (class-validator format)
      if (Array.isArray(responseObj['message'])) {
        validationErrors = this.parseValidationErrors(responseObj['message'] as string[]);
        message = 'Validation failed';
      }

      // Extract additional details
      if (!this.isProduction) {
        details = responseObj['details'] || responseObj['error'];
      }
    } else {
      message = USER_FRIENDLY_MESSAGES[statusCode] || 'An error occurred';
    }

    // In production, use generic messages for server errors
    if (this.isProduction && statusCode >= 500) {
      message = USER_FRIENDLY_MESSAGES[statusCode] || 'An unexpected error occurred';
      details = undefined;
    }

    const errorResponse: HttpErrorResponse = {
      success: false,
      error: {
        code,
        message,
      },
      meta: {
        timestamp,
        path,
        method,
        statusCode,
        correlationId,
      },
    };

    if (details) {
      errorResponse.error.details = details;
    }

    if (validationErrors && validationErrors.length > 0) {
      errorResponse.error.validationErrors = validationErrors;
    }

    return errorResponse;
  }

  /**
   * Parse validation errors from class-validator format
   */
  private parseValidationErrors(messages: string[]): ValidationError[] {
    return messages.map((msg) => {
      // Try to extract field name from message
      const match = msg.match(/^(\w+)\s+(.+)$/);
      if (match && match[1] && match[2]) {
        return {
          field: match[1],
          message: match[2],
          code: 'VALIDATION_ERROR',
        };
      }

      return {
        field: 'unknown',
        message: msg,
        code: 'VALIDATION_ERROR',
      };
    });
  }

  /**
   * Add special headers for specific status codes
   */
  private addSpecialHeaders(
    response: Response,
    statusCode: number,
    exceptionResponse: unknown,
  ): void {
    // Add Retry-After header for rate limiting
    if (statusCode === 429) {
      const responseObj = exceptionResponse as Record<string, unknown>;
      const retryAfter = responseObj?.['retryAfter'] ?? 60;
      response.setHeader('Retry-After', String(retryAfter));
    }

    // Add WWW-Authenticate header for unauthorized
    if (statusCode === 401) {
      response.setHeader('WWW-Authenticate', 'Bearer');
    }

    // Add Allow header for method not allowed
    if (statusCode === 405) {
      const responseObj = exceptionResponse as Record<string, unknown>;
      const allowedMethods = responseObj?.['allowedMethods'];
      if (Array.isArray(allowedMethods)) {
        response.setHeader('Allow', allowedMethods.join(', '));
      }
    }
  }

  /**
   * Log the error
   */
  private logError(
    exception: HttpException,
    errorResponse: HttpErrorResponse,
    request?: Request,
  ): void {
    const statusCode = exception.getStatus();
    const userAgentHeader = request?.headers?.['user-agent'];
    const logContext = {
      statusCode,
      path: errorResponse.meta.path,
      method: errorResponse.meta.method,
      correlationId: errorResponse.meta.correlationId,
      errorCode: errorResponse.error.code,
      ip: request?.ip,
      userAgent: typeof userAgentHeader === 'string' ? userAgentHeader : undefined,
    };

    // Log based on severity
    if (statusCode >= 500) {
      this.logger.error(
        `${exception.message}`,
        exception.stack,
        JSON.stringify(logContext),
      );
    } else if (statusCode >= 400) {
      this.logger.warn(`${exception.message}`, JSON.stringify(logContext));
    } else {
      this.logger.debug(`${exception.message}`, JSON.stringify(logContext));
    }
  }
}

/**
 * Create a formatted HTTP exception
 */
export function createHttpException(
  statusCode: HttpStatus,
  message: string,
  details?: unknown,
): HttpException {
  return new HttpException(
    {
      message,
      details,
      statusCode,
    },
    statusCode,
  );
}

/**
 * Create a validation exception
 */
export function createValidationException(errors: ValidationError[]): HttpException {
  return new HttpException(
    {
      message: 'Validation failed',
      validationErrors: errors,
      statusCode: HttpStatus.UNPROCESSABLE_ENTITY,
    },
    HttpStatus.UNPROCESSABLE_ENTITY,
  );
}
