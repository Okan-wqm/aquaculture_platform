import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { GqlArgumentsHost, GqlExceptionFilter } from '@nestjs/graphql';
import { Request, Response } from 'express';
import { GraphQLError } from 'graphql';

/**
 * Interface for structured exception response objects
 */
interface ExceptionResponseObject {
  message?: string | string[];
  error?: string;
  statusCode?: number;
  details?: unknown;
}

/**
 * Type guard to check if exception response is an object
 */
function isExceptionResponseObject(
  response: string | object,
): response is ExceptionResponseObject {
  return typeof response === 'object' && response !== null;
}

/**
 * Extract message from exception response
 */
function extractMessage(
  response: string | object,
  fallback: string,
): string | string[] {
  if (typeof response === 'string') {
    return response;
  }
  if (isExceptionResponseObject(response) && response.message !== undefined) {
    return response.message;
  }
  return fallback;
}

/**
 * HTTP Exception Filter
 * Provides consistent error responses for REST endpoints
 */
@Catch(HttpException)
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpExceptionFilter.name);

  catch(exception: HttpException, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();
    const status = exception.getStatus();
    const exceptionResponse = exception.getResponse();

    const errorResponse = {
      statusCode: status,
      timestamp: new Date().toISOString(),
      path: request.url,
      method: request.method,
      message: extractMessage(exceptionResponse, exception.message),
      error: isExceptionResponseObject(exceptionResponse)
        ? exceptionResponse.error
        : undefined,
      details: isExceptionResponseObject(exceptionResponse)
        ? exceptionResponse.details
        : undefined,
      correlationId: request.headers['x-correlation-id'] || undefined,
      tenantId: request.headers['x-tenant-id'] || undefined,
    };

    this.logger.warn(
      `HTTP Exception: ${status} ${request.method} ${request.url}`,
      {
        ...errorResponse,
        stack: exception.stack,
      },
    );

    response.status(status).json(errorResponse);
  }
}

/**
 * All Exceptions Filter
 * Catches unhandled exceptions and provides consistent error responses
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    const status =
      exception instanceof HttpException
        ? exception.getStatus()
        : HttpStatus.INTERNAL_SERVER_ERROR;

    const message =
      exception instanceof Error
        ? exception.message
        : 'An unexpected error occurred';

    const errorResponse = {
      statusCode: status,
      timestamp: new Date().toISOString(),
      path: request?.url,
      method: request?.method,
      message,
      correlationId: request?.headers?.['x-correlation-id'] || undefined,
      tenantId: request?.headers?.['x-tenant-id'] || undefined,
    };

    this.logger.error(
      `Unhandled Exception: ${status} ${request?.method} ${request?.url}`,
      exception instanceof Error ? exception.stack : exception,
      {
        ...errorResponse,
      },
    );

    response?.status(status).json(errorResponse);
  }
}

/**
 * GraphQL Exception Filter
 * Provides consistent error responses for GraphQL operations
 */
@Catch()
export class GraphQLExceptionFilter implements GqlExceptionFilter {
  private readonly logger = new Logger(GraphQLExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): GraphQLError {
    const gqlHost = GqlArgumentsHost.create(host);
    const context = gqlHost.getContext();

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let message = 'An unexpected error occurred';
    let code = 'INTERNAL_SERVER_ERROR';

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const response = exception.getResponse();
      const extracted = extractMessage(response, exception.message);
      message = Array.isArray(extracted) ? extracted.join(', ') : extracted;
      code = this.getErrorCode(status);
    } else if (exception instanceof Error) {
      message = exception.message;
    }

    this.logger.error(`GraphQL Exception: ${code}`, {
      message,
      correlationId: context?.req?.headers?.['x-correlation-id'],
      tenantId: context?.req?.headers?.['x-tenant-id'],
      stack: exception instanceof Error ? exception.stack : undefined,
    });

    return new GraphQLError(message, {
      extensions: {
        code,
        timestamp: new Date().toISOString(),
        correlationId: context?.req?.headers?.['x-correlation-id'],
      },
    });
  }

  private getErrorCode(status: number): string {
    const codeMap: Record<number, string> = {
      400: 'BAD_REQUEST',
      401: 'UNAUTHENTICATED',
      403: 'FORBIDDEN',
      404: 'NOT_FOUND',
      409: 'CONFLICT',
      422: 'UNPROCESSABLE_ENTITY',
      429: 'TOO_MANY_REQUESTS',
      500: 'INTERNAL_SERVER_ERROR',
      502: 'BAD_GATEWAY',
      503: 'SERVICE_UNAVAILABLE',
    };
    return codeMap[status] || 'INTERNAL_SERVER_ERROR';
  }
}
