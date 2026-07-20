import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { QueryFailedError } from 'typeorm';

interface ErrorDetail {
  statusCode: number;
  message: string;
  error: string;
  timestamp: string;
  path: string;
  requestId?: string;
  details?: unknown;
}

interface ErrorEnvelope {
  success: false;
  error: ErrorDetail;
}

@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(GlobalExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    // HTTP-only filter. In the hybrid app this APP_FILTER also catches errors
    // thrown by NATS (RPC) message handlers, where there is no HTTP response to
    // write. Rethrow so Nest's microservice exception layer handles it (the
    // NATS server then applies its retry/nack policy) — mirrors the non-http
    // guard in notification-service's GlobalExceptionFilter.
    if (host.getType() !== 'http') {
      throw exception;
    }

    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    const errorDetail = this.buildErrorDetail(exception, request);

    // Log the error
    if (errorDetail.statusCode >= 500) {
      this.logger.error(
        `${request.method} ${request.url} - ${errorDetail.statusCode}: ${errorDetail.message}`,
        exception instanceof Error ? exception.stack : undefined,
      );
    } else {
      this.logger.warn(
        `${request.method} ${request.url} - ${errorDetail.statusCode}: ${errorDetail.message}`,
      );
    }

    // Return the envelope format with top-level error fields spread for backward compatibility
    // This keeps existing tests passing (they check body.statusCode, body.message, etc.)
    // while also providing the success flag.
    const envelope: ErrorDetail & { success: false } = {
      success: false,
      ...errorDetail,
    };

    response.status(errorDetail.statusCode).json(envelope);
  }

  private buildErrorDetail(
    exception: unknown,
    request: Request,
  ): ErrorDetail {
    const timestamp = new Date().toISOString();
    const path = request.url;
    const requestId = request.headers['x-request-id'] as string | undefined;

    // Handle HTTP exceptions
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const exceptionResponse = exception.getResponse();

      let message: string;
      let details: unknown;

      if (typeof exceptionResponse === 'string') {
        message = exceptionResponse;
      } else if (typeof exceptionResponse === 'object') {
        const responseObj = exceptionResponse as Record<string, unknown>;
        message = (responseObj['message'] as string) || exception.message;
        details = responseObj['details'];
      } else {
        message = exception.message;
      }

      return {
        statusCode: status,
        message,
        error: this.getErrorName(status),
        timestamp,
        path,
        requestId,
        details,
      };
    }

    // Handle TypeORM errors
    if (exception instanceof QueryFailedError) {
      const pgError = exception as QueryFailedError & {
        code?: string;
        detail?: string;
      };

      // Unique constraint violation
      // LOW-006 fix: do NOT include pgError.detail — it contains the conflicting field value
      // (e.g. "Key (email)=(admin@example.com) already exists.") which confirms to attackers
      // that a specific email/identifier exists in the system.
      if (pgError.code === '23505') {
        return {
          statusCode: HttpStatus.CONFLICT,
          message: 'Resource already exists',
          error: 'Conflict',
          timestamp,
          path,
          requestId,
        };
      }

      // Foreign key violation
      if (pgError.code === '23503') {
        return {
          statusCode: HttpStatus.BAD_REQUEST,
          message: 'Referenced resource not found',
          error: 'Bad Request',
          timestamp,
          path,
          requestId,
        };
      }

      // Not null violation
      if (pgError.code === '23502') {
        return {
          statusCode: HttpStatus.BAD_REQUEST,
          message: 'Missing required field',
          error: 'Bad Request',
          timestamp,
          path,
          requestId,
        };
      }

      this.logger.error(
        `Database query failed: ${exception.message}`,
        exception.stack,
      );

      return {
        statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
        message:
          process.env['NODE_ENV'] === 'development'
            ? `Database operation failed: ${exception.message}`
            : 'Database operation failed',
        error: 'Internal Server Error',
        timestamp,
        path,
        requestId,
      };
    }

    // Handle generic errors
    if (exception instanceof Error) {
      return {
        statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
        message:
          process.env['NODE_ENV'] === 'production'
            ? 'An unexpected error occurred'
            : exception.message,
        error: 'Internal Server Error',
        timestamp,
        path,
        requestId,
      };
    }

    // Handle unknown errors
    return {
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      message: 'An unexpected error occurred',
      error: 'Internal Server Error',
      timestamp,
      path,
      requestId,
    };
  }

  private getErrorName(status: number): string {
    const errorNames: Record<number, string> = {
      400: 'Bad Request',
      401: 'Unauthorized',
      403: 'Forbidden',
      404: 'Not Found',
      405: 'Method Not Allowed',
      409: 'Conflict',
      410: 'Gone',
      422: 'Unprocessable Entity',
      429: 'Too Many Requests',
      500: 'Internal Server Error',
      501: 'Not Implemented',
      502: 'Bad Gateway',
      503: 'Service Unavailable',
      504: 'Gateway Timeout',
    };

    return errorNames[status] || 'Unknown Error';
  }
}
