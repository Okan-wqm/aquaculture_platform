import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';

interface ErrorResponse {
  statusCode: number;
  message: string;
  error: string;
  timestamp: string;
  path: string;
  requestId?: string;
  details?: unknown;
}

@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(GlobalExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    const { statusCode, message, error, details } =
      this.extractErrorInfo(exception);

    const errorResponse: ErrorResponse = {
      statusCode,
      message,
      error,
      timestamp: new Date().toISOString(),
      path: request.url,
      requestId: request.headers['x-request-id'] as string | undefined,
    };

    if (details) {
      errorResponse.details = details;
    }

    // Log the error
    if (statusCode >= 500) {
      this.logger.error(
        `${request.method} ${request.url} - ${statusCode} - ${message}`,
        exception instanceof Error ? exception.stack : undefined,
      );
    } else {
      this.logger.warn(
        `${request.method} ${request.url} - ${statusCode} - ${message}`,
      );
    }

    response.status(statusCode).json(errorResponse);
  }

  private extractErrorInfo(exception: unknown): {
    statusCode: number;
    message: string;
    error: string;
    details?: unknown;
  } {
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const exceptionResponse = exception.getResponse();

      if (typeof exceptionResponse === 'object' && exceptionResponse !== null) {
        const responseObj = exceptionResponse as Record<string, unknown>;
        return {
          statusCode: status,
          message: (responseObj['message'] as string) || exception.message,
          error: (responseObj['error'] as string) || this.getErrorName(status),
          details: responseObj['details'],
        };
      }

      return {
        statusCode: status,
        message: exception.message,
        error: this.getErrorName(status),
      };
    }

    // Handle TypeORM errors
    if (exception instanceof Error) {
      if (exception.name === 'QueryFailedError') {
        return {
          statusCode: HttpStatus.BAD_REQUEST,
          message: 'Database query failed',
          error: 'Bad Request',
          details:
            process.env['NODE_ENV'] === 'development'
              ? exception.message
              : undefined,
        };
      }

      if (exception.name === 'EntityNotFoundError') {
        return {
          statusCode: HttpStatus.NOT_FOUND,
          message: 'Entity not found',
          error: 'Not Found',
        };
      }
    }

    // Generic error
    return {
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      message: 'Internal server error',
      error: 'Internal Server Error',
      details:
        process.env['NODE_ENV'] === 'development' && exception instanceof Error
          ? exception.message
          : undefined,
    };
  }

  private getErrorName(status: number): string {
    const statusNames: Record<number, string> = {
      400: 'Bad Request',
      401: 'Unauthorized',
      403: 'Forbidden',
      404: 'Not Found',
      405: 'Method Not Allowed',
      409: 'Conflict',
      422: 'Unprocessable Entity',
      429: 'Too Many Requests',
      500: 'Internal Server Error',
      502: 'Bad Gateway',
      503: 'Service Unavailable',
    };

    return statusNames[status] || 'Error';
  }
}
