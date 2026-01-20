import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { GqlContextType } from '@nestjs/graphql';
import { Request, Response } from 'express';

interface ErrorResponse {
  statusCode: number;
  message: string;
  error: string;
  timestamp: string;
  path?: string;
  correlationId?: string;
}

@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(GlobalExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const contextType = host.getType<GqlContextType>();

    if (contextType === 'graphql') {
      // GraphQL context - let Apollo handle it
      throw exception;
    }

    // HTTP context
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    const { status, errorResponse } = this.buildErrorResponse(exception, request);

    // Log error
    if (status >= 500) {
      this.logger.error(
        `${request.method} ${request.url} - ${status}: ${errorResponse.message}`,
        exception instanceof Error ? exception.stack : undefined,
      );
    } else {
      this.logger.warn(
        `${request.method} ${request.url} - ${status}: ${errorResponse.message}`,
      );
    }

    response.status(status).json(errorResponse);
  }

  private buildErrorResponse(
    exception: unknown,
    request: Request,
  ): { status: number; errorResponse: ErrorResponse } {
    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let message = 'Internal server error';
    let error = 'Internal Server Error';

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const exceptionResponse = exception.getResponse();

      if (typeof exceptionResponse === 'string') {
        message = exceptionResponse;
      } else if (typeof exceptionResponse === 'object') {
        const responseObj = exceptionResponse as Record<string, unknown>;
        message = (responseObj['message'] as string) || message;
        error = (responseObj['error'] as string) || error;

        // Handle validation errors
        if (Array.isArray(responseObj['message'])) {
          message = (responseObj['message'] as string[]).join(', ');
        }
      }

      error = this.getErrorName(status);
    } else if (exception instanceof Error) {
      message = exception.message;

      // Handle TypeORM errors
      if (exception.name === 'QueryFailedError') {
        status = HttpStatus.BAD_REQUEST;
        error = 'Database Error';
        // Don't expose internal DB error details
        message = 'Database operation failed';
      }
    }

    const errorResponse: ErrorResponse = {
      statusCode: status,
      message,
      error,
      timestamp: new Date().toISOString(),
      path: request.url,
      correlationId: request.headers['x-correlation-id'] as string,
    };

    return { status, errorResponse };
  }

  private getErrorName(status: number): string {
    const statusNames: Record<number, string> = {
      400: 'Bad Request',
      401: 'Unauthorized',
      403: 'Forbidden',
      404: 'Not Found',
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
