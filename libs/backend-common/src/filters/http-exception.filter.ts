// TODO(ARCH-MED-005): Consolidation plan — eliminate duplicate exception filter hierarchy
//
// Problem: libs/backend-common defines THREE exception filters with overlapping concerns:
//   - HttpExceptionFilter  (@Catch(HttpException))  — REST HTTP errors
//   - AllExceptionsFilter  (@Catch())               — REST + GraphQL catch-all
//   - GraphQLExceptionFilter (@Catch())             — GraphQL-only catch-all
//
// These produce a different response envelope ({ statusCode, message, path, ... }) than
// libs/shared GlobalExceptionFilter ({ success, error: { code, message, details, ... } }).
// This means REST clients interacting with services using backend-common filters receive
// inconsistent error shapes compared to services that have migrated to GlobalExceptionFilter.
//
// Target state: All services should use libs/shared GlobalExceptionFilter exclusively.
// The three classes in this file should be deprecated and eventually deleted.
//
// Migration steps (per service):
//   1. Remove useGlobalFilters(new AllExceptionsFilter()) / useGlobalFilters(new HttpExceptionFilter())
//      from the service's main.ts
//   2. Remove AllExceptionsFilter / HttpExceptionFilter from AppModule providers[]
//   3. Add { provide: APP_FILTER, useClass: GlobalExceptionFilter } to AppModule providers
//      (import GlobalExceptionFilter from '@platform/shared')
//   4. For GraphQL services: GlobalExceptionFilter handles graphql context via ApplicationException;
//      if the service uses raw HttpException for GraphQL errors, update those to ApplicationException
//      so the structured { code, message } response propagates through Apollo
//   5. Delete the import of AllExceptionsFilter / HttpExceptionFilter from the service
//   6. Once all services are migrated, delete this file and remove the export from
//      libs/backend-common/src/index.ts
//
// Services still importing from this file (as of 2026-02-19):
//   - apps/auth-service
//   - apps/config-service
//   - apps/gateway-api
//   - apps/billing-service
//   - apps/hr-service
//   - apps/admin-api-service
import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { GqlExceptionFilter } from '@nestjs/graphql';
import { Request, Response } from 'express';
import { GraphQLError } from 'graphql';

import { getRequestFromArgumentsHost } from '../context/execution-context-request';

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
function isExceptionResponseObject(response: string | object): response is ExceptionResponseObject {
  return typeof response === 'object' && response !== null;
}

/**
 * Extract message from exception response
 */
function extractMessage(response: string | object, fallback: string): string | string[] {
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

    const message = extractMessage(exceptionResponse, exception.message);
    const correlationId = request.headers['x-correlation-id'] || undefined;
    const tenantId = request.headers['x-tenant-id'] || undefined;

    // SECURITY: tenantId is logged server-side but NEVER included in client response
    this.logger.warn(`HTTP Exception: ${status} ${request.method} ${request.url}`, {
      statusCode: status,
      path: request.url,
      method: request.method,
      message,
      correlationId,
      tenantId,
      stack: exception.stack,
    });

    const errorResponse = {
      statusCode: status,
      timestamp: new Date().toISOString(),
      path: request.url,
      method: request.method,
      message,
      error: isExceptionResponseObject(exceptionResponse) ? exceptionResponse.error : undefined,
      details: isExceptionResponseObject(exceptionResponse) ? exceptionResponse.details : undefined,
      correlationId,
    };

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

  catch(exception: unknown, host: ArgumentsHost): GraphQLError | undefined {
    const contextType = host.getType<string>();

    // Route GraphQL contexts to GraphQL error handling
    if (contextType === 'graphql') {
      return this.handleGraphQLException(exception, host);
    }

    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    const status =
      exception instanceof HttpException ? exception.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;

    const message = exception instanceof Error ? exception.message : 'An unexpected error occurred';

    const correlationId = request?.headers?.['x-correlation-id'] || undefined;
    const tenantId = request?.headers?.['x-tenant-id'] || undefined;

    // SECURITY: tenantId is logged server-side but NEVER included in client response
    this.logger.error(
      `Unhandled Exception: ${status} ${request?.method} ${request?.url}`,
      exception instanceof Error ? exception.stack : exception,
      {
        statusCode: status,
        path: request?.url,
        method: request?.method,
        message,
        correlationId,
        tenantId,
      },
    );

    const errorResponse = {
      statusCode: status,
      timestamp: new Date().toISOString(),
      path: request?.url,
      method: request?.method,
      message,
      correlationId,
    };

    response?.status(status).json(errorResponse);
    return undefined;
  }

  private handleGraphQLException(exception: unknown, host: ArgumentsHost): GraphQLError {
    const request = getRequestFromArgumentsHost<Request>(host);

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

    const correlationId = request?.headers['x-correlation-id'];
    const tenantId = request?.headers['x-tenant-id'];

    // SECURITY: tenantId is logged server-side but NEVER included in client response
    this.logger.error(`GraphQL Unhandled Exception: ${code}`, {
      message,
      correlationId,
      tenantId,
      stack: exception instanceof Error ? exception.stack : undefined,
    });

    return new GraphQLError(message, {
      extensions: {
        code,
        statusCode: status,
        timestamp: new Date().toISOString(),
        correlationId,
      },
    });
  }

  private getErrorCode(status: number): string {
    const codeMap: Record<number, string> = {
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
    };
    return codeMap[status] || 'INTERNAL_SERVER_ERROR';
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
    const request = getRequestFromArgumentsHost<Request>(host);

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

    const correlationId = request?.headers['x-correlation-id'];
    const tenantId = request?.headers['x-tenant-id'];

    // SECURITY: tenantId is logged server-side but NEVER included in client response
    this.logger.error(`GraphQL Exception: ${code}`, {
      message,
      correlationId,
      tenantId,
      stack: exception instanceof Error ? exception.stack : undefined,
    });

    const details =
      exception instanceof HttpException
        ? (() => {
            const resp = exception.getResponse();
            return isExceptionResponseObject(resp) ? resp.details : undefined;
          })()
        : undefined;

    return new GraphQLError(message, {
      extensions: {
        code,
        statusCode: status,
        timestamp: new Date().toISOString(),
        correlationId,
        details,
      },
    });
  }

  private getErrorCode(status: number): string {
    const codeMap: Record<number, string> = {
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
    };
    return codeMap[status] || 'INTERNAL_SERVER_ERROR';
  }
}
