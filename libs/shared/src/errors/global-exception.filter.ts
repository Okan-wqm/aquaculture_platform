// TODO(ARCH-CRIT-001 / CONTRACT-CRIT-001): Migration plan — adopt GlobalExceptionFilter platform-wide
//
// Problem: Three incompatible error response contracts coexist:
//   1. This GlobalExceptionFilter — canonical { success, error: { code, message, ... } } shape
//   2. Service-specific HttpExceptionFilter / AllExceptionsFilter (sensor-service, auth-service, etc.)
//      — uses raw { statusCode, message, error } shape from NestJS HttpException
//   3. ApplicationException / ErrorResponse — same canonical shape as (1) but not yet used widely
//
// libs/shared GlobalExceptionFilter is the canonical error-handling implementation
// but is not yet used by most services. Each service registers its own ad-hoc filter
// (e.g. libs/backend-common HttpExceptionFilter / AllExceptionsFilter / GraphQLExceptionFilter),
// producing inconsistent response envelopes across the API surface.
//
// Target state: All NestJS apps should register GlobalExceptionFilter as APP_FILTER in their
// AppModule and remove any service-local exception filter registrations.
//
// Migration steps (per service, one at a time):
//   1. Remove local exception filter from providers[] / main.ts useGlobalFilters()
//   2. Add { provide: APP_FILTER, useClass: GlobalExceptionFilter } to AppModule providers
//   3. Verify error response shape matches { success, error: { code, message, ... } }
//   4. Update any service-specific error handling tests
//
// Services still using non-standard filters (as of 2026-02-19):
//   - apps/auth-service        (AllExceptionsFilter from backend-common)
//   - apps/config-service      (AllExceptionsFilter from backend-common)
//   - apps/gateway-api         (AllExceptionsFilter from backend-common)
//   - apps/billing-service     (AllExceptionsFilter from backend-common)
//   - apps/hr-service          (AllExceptionsFilter from backend-common)
//   - apps/admin-api-service   (AllExceptionsFilter from backend-common)
//
// Note: apps/farm-service already uses GlobalExceptionFilter (see farm-service/src/app.module.ts).
//
// TODO(ARCH-CRIT-002): ApplicationException / ErrorCode adoption
// Once a service adopts this filter, replace ad-hoc throw new HttpException() calls with
// ApplicationException or its typed subclasses (ValidationException, BusinessRuleException,
// ExternalServiceException). This ensures typed error codes from error-codes.ts flow through
// getErrorResponse() automatically and appear in the response envelope. See application-exception.ts
// and error-codes.ts for the full registry of typed codes.
import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { ApplicationException, ErrorResponse } from './application-exception';

/**
 * Global Exception Filter
 *
 * Catches all exceptions and transforms them into a standardized error response format.
 * Ensures consistent error handling across all API endpoints.
 */
@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(GlobalExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    const errorResponse = this.buildErrorResponse(exception, request);
    const status = this.getStatus(exception);

    // Log error details
    this.logError(exception, request, status);

    response.status(status).json(errorResponse);
  }

  private buildErrorResponse(exception: unknown, request: Request): ErrorResponse {
    const correlationId =
      (request.headers['x-correlation-id'] as string) ||
      (request.headers['x-request-id'] as string) ||
      undefined;

    // Handle ApplicationException
    if (exception instanceof ApplicationException) {
      const errorResponse = exception.getErrorResponse();
      errorResponse.error.path = request.url;
      errorResponse.error.correlationId = correlationId;
      return errorResponse;
    }

    // Handle standard HttpException
    if (exception instanceof HttpException) {
      const exceptionResponse = exception.getResponse();
      const message = this.extractMessage(exceptionResponse);
      const details = this.extractDetails(exceptionResponse);

      return {
        success: false,
        error: {
          code: this.getErrorCode(exception.getStatus()),
          message,
          details,
          timestamp: new Date().toISOString().toISOString(),
          path: request.url,
          correlationId,
        },
      };
    }

    // Handle unknown errors
    const isProduction = process.env.NODE_ENV === 'production';
    return {
      success: false,
      error: {
        code: 'INTERNAL_SERVER_ERROR',
        message: isProduction
          ? 'An unexpected error occurred'
          : (exception instanceof Error ? exception.message : 'Unknown error'),
        timestamp: new Date().toISOString().toISOString(),
        path: request.url,
        correlationId,
      },
    };
  }

  private getStatus(exception: unknown): number {
    if (exception instanceof HttpException) {
      return exception.getStatus();
    }
    return HttpStatus.INTERNAL_SERVER_ERROR;
  }

  private extractMessage(response: string | object): string {
    if (typeof response === 'string') {
      return response;
    }
    if (typeof response === 'object' && response !== null) {
      const obj = response as Record<string, unknown>;
      if ('message' in obj) {
        return Array.isArray(obj.message)
          ? obj.message.join(', ')
          : String(obj.message);
      }
      if ('error' in obj && typeof obj.error === 'object' && obj.error !== null) {
        const errorObj = obj.error as Record<string, unknown>;
        if ('message' in errorObj) {
          return String(errorObj.message);
        }
      }
    }
    return 'An error occurred';
  }

  private extractDetails(response: string | object): Record<string, unknown> | undefined {
    if (typeof response !== 'object' || response === null) {
      return undefined;
    }

    const obj = response as Record<string, unknown>;

    // Check for validation errors (class-validator / ValidationPipe)
    // Standardize to { fields: Record<string, string[]> } format
    // matching ValidationException's structure
    if ('message' in obj && Array.isArray(obj.message) && obj.message.length > 1) {
      const fields: Record<string, string[]> = {};
      for (const msg of obj.message) {
        const strMsg = String(msg);
        // Try to extract field name from messages like "email must be a valid email"
        const match = strMsg.match(/^(\w+)\s/);
        const fieldName = match?.[1] ?? '_general';
        if (!fields[fieldName]) {
          fields[fieldName] = [];
        }
        fields[fieldName].push(strMsg);
      }
      return { fields };
    }

    // Check for nested error details
    if ('error' in obj && typeof obj.error === 'object' && obj.error !== null) {
      const errorObj = obj.error as Record<string, unknown>;
      if ('details' in errorObj) {
        return errorObj.details as Record<string, unknown>;
      }
    }

    return undefined;
  }

  private getErrorCode(status: number): string {
    // All codes reference entries in ERROR_CODES to eliminate phantom codes
    const statusCodeMap: Record<number, string> = {
      400: 'VALIDATION_FAILED',
      401: 'AUTH_TOKEN_INVALID',
      403: 'AUTH_FORBIDDEN',
      404: 'RESOURCE_NOT_FOUND',
      409: 'RESOURCE_CONFLICT',
      422: 'VALIDATION_FAILED',
      429: 'RATE_LIMIT_EXCEEDED',
      500: 'INTERNAL_SERVER_ERROR',
      502: 'EXTERNAL_SERVICE_UNAVAILABLE',
      503: 'EXTERNAL_SERVICE_UNAVAILABLE',
      504: 'EXTERNAL_SERVICE_TIMEOUT',
    };

    return statusCodeMap[status] || 'INTERNAL_SERVER_ERROR';
  }

  private logError(exception: unknown, request: Request, status: number): void {
    const errorDetails = {
      method: request.method,
      url: request.url,
      status,
      userId: (request as Request & { user?: { id?: string } }).user?.id,
      tenantId: request.headers['x-tenant-id'],
      correlationId: request.headers['x-correlation-id'] || request.headers['x-request-id'],
    };

    if (status >= 500) {
      this.logger.error(
        `Server Error: ${exception instanceof Error ? exception.message : 'Unknown error'}`,
        exception instanceof Error ? exception.stack : undefined,
        errorDetails,
      );
    } else if (status >= 400) {
      this.logger.warn(
        `Client Error: ${exception instanceof Error ? exception.message : 'Unknown error'}`,
        errorDetails,
      );
    }
  }
}
