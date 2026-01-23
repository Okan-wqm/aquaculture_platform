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
    const requestId = (request.headers['x-request-id'] as string) || undefined;

    // Handle ApplicationException
    if (exception instanceof ApplicationException) {
      const errorResponse = exception.getErrorResponse();
      errorResponse.error.path = request.url;
      errorResponse.error.requestId = requestId;
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
          timestamp: new Date().toISOString(),
          path: request.url,
          requestId,
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
        timestamp: new Date().toISOString(),
        path: request.url,
        requestId,
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

    // Check for validation errors (class-validator)
    if ('message' in obj && Array.isArray(obj.message) && obj.message.length > 1) {
      return { validationErrors: obj.message };
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
    const statusCodeMap: Record<number, string> = {
      400: 'VALIDATION_FAILED',
      401: 'AUTH_INVALID_CREDENTIALS',
      403: 'AUTH_FORBIDDEN',
      404: 'NOT_FOUND',
      409: 'CONFLICT',
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
      requestId: request.headers['x-request-id'],
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
