import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { GqlArgumentsHost, GqlContextType } from '@nestjs/graphql';
import { Response, Request } from 'express';
import { GraphQLError } from 'graphql';
import { buildErrorEnvelope, JSON_ERROR_CONTENT_TYPE } from '@platform/shared';

import { GqlContext } from '../types/index';

/**
 * Extended request interface with custom properties
 */
interface ExtendedRequest extends Request {
  tenantId?: string;
  correlationId?: string;
}

/**
 * Error response format
 * SECURITY: tenantId is intentionally excluded from client responses
 * to prevent information disclosure. It is logged server-side only.
 */
interface ErrorResponse {
  statusCode: number;
  message: string;
  error: string;
  timestamp: string;
  path: string;
  correlationId?: string;
  details?: unknown;
}

/**
 * GraphQL error extensions
 * SECURITY: tenantId is intentionally excluded from client responses.
 */
interface GraphQLErrorExtensions {
  code: string;
  statusCode: number;
  timestamp: string;
  correlationId?: string;
  path?: string;
  details?: unknown;
  [key: string]: unknown;
}

/**
 * Global Exception Filter
 * Handles all exceptions across HTTP and GraphQL endpoints
 * Provides consistent error responses with proper logging
 * Sanitizes error details in production to prevent information leakage
 */
@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(GlobalExceptionFilter.name);
  private readonly isProduction = process.env['NODE_ENV'] === 'production';

  catch(exception: unknown, host: ArgumentsHost): GraphQLError | undefined {
    const contextType = host.getType<GqlContextType>();

    if (contextType === 'graphql') {
      return this.handleGraphQLException(exception, host);
    }

    this.handleHttpException(exception, host);
    return undefined;
  }

  private handleHttpException(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<ExtendedRequest>();

    const correlationIdHeader =
      request.headers['x-correlation-id'] ?? request.headers['x-request-id'];
    const canonical = buildErrorEnvelope(exception, {
      path: request.originalUrl ?? request.url,
      correlationId: typeof correlationIdHeader === 'string' ? correlationIdHeader : undefined,
      isProduction: this.isProduction,
    });

    this.logError(exception, {
      statusCode: canonical.statusCode,
      message: canonical.body.error.message,
      error: canonical.body.error.code,
      timestamp: canonical.body.error.timestamp,
      path: canonical.body.error.path ?? '',
      correlationId: canonical.body.error.correlationId,
    });

    response.status(canonical.statusCode).type(JSON_ERROR_CONTENT_TYPE).json(canonical.body);
  }

  private handleGraphQLException(exception: unknown, host: ArgumentsHost): GraphQLError {
    const gqlHost = GqlArgumentsHost.create(host);
    const context = gqlHost.getContext<GqlContext>();
    const request = context?.req;

    const { statusCode, message, errorType, details } = this.parseException(exception);

    const correlationIdHeader =
      request?.headers?.['x-correlation-id'] ?? request?.headers?.['x-request-id'];
    const tenantIdHeader = request?.headers?.['x-tenant-id'];
    const presentation = buildErrorEnvelope(new HttpException(message, statusCode), {
      correlationId: typeof correlationIdHeader === 'string' ? correlationIdHeader : undefined,
      isProduction: this.isProduction,
    });
    const correlationId = presentation.body.error.correlationId;

    // SECURITY: tenantId is resolved for server-side logging only — never sent to client
    const tenantId =
      request?.tenantId ?? (typeof tenantIdHeader === 'string' ? tenantIdHeader : undefined);

    const extensions: GraphQLErrorExtensions = {
      code: this.getGraphQLErrorCode(statusCode),
      statusCode,
      timestamp: new Date().toISOString(),
      correlationId,
    };

    // Include path in non-production
    if (!this.isProduction && request?.url) {
      extensions.path = request.url;
    }

    // Include details in non-production
    if (!this.isProduction && details) {
      extensions.details = details;
    }

    const errorResponse: ErrorResponse = {
      statusCode,
      message,
      error: errorType,
      timestamp: extensions.timestamp,
      path: request?.url ?? 'graphql',
      correlationId: extensions.correlationId,
    };

    this.logError(exception, errorResponse, tenantId);

    return new GraphQLError(this.isProduction ? presentation.body.error.message : message, {
      extensions,
    });
  }

  private parseException(exception: unknown): {
    statusCode: number;
    message: string;
    errorType: string;
    details?: unknown;
  } {
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const response = exception.getResponse();

      if (typeof response === 'string') {
        return {
          statusCode: status,
          message: response,
          errorType: HttpStatus[status] ?? 'Error',
        };
      }

      const responseObj = response as Record<string, unknown>;
      return {
        statusCode: status,
        message: (responseObj['message'] as string) ?? exception.message,
        errorType: (responseObj['error'] as string) ?? HttpStatus[status] ?? 'Error',
        details: responseObj['details'],
      };
    }

    if (exception instanceof GraphQLError) {
      const extensions = exception.extensions ?? {};
      return {
        statusCode: (extensions['statusCode'] as number) ?? 500,
        message: exception.message,
        errorType: (extensions['code'] as string) ?? 'INTERNAL_SERVER_ERROR',
        details: extensions['details'],
      };
    }

    if (exception instanceof Error) {
      return {
        statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
        // SECURITY: In production, always return generic message for plain Error
        // instances to prevent leaking implementation details (column names,
        // property paths, internal class names, etc.)
        message: exception.message,
        errorType: 'Internal Server Error',
        details: this.isProduction ? undefined : exception.stack,
      };
    }

    return {
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      message: 'An unexpected error occurred',
      errorType: 'Internal Server Error',
    };
  }

  private getGraphQLErrorCode(statusCode: number): string {
    switch (statusCode) {
      case 400:
        return 'BAD_REQUEST';
      case 401:
        return 'UNAUTHENTICATED';
      case 403:
        return 'FORBIDDEN';
      case 404:
        return 'NOT_FOUND';
      case 409:
        return 'CONFLICT';
      case 422:
        return 'UNPROCESSABLE_ENTITY';
      case 429:
        return 'TOO_MANY_REQUESTS';
      default:
        return 'INTERNAL_SERVER_ERROR';
    }
  }

  private logError(exception: unknown, errorResponse: ErrorResponse, tenantId?: string): void {
    const logContext = {
      statusCode: errorResponse.statusCode,
      path: this.isProduction ? undefined : errorResponse.path,
      correlationId: errorResponse.correlationId,
      tenantId: this.isProduction ? undefined : tenantId,
      timestamp: errorResponse.timestamp,
    };

    if (errorResponse.statusCode >= 500) {
      this.logger.error(
        'Gateway request failed with a server error',
        !this.isProduction && exception instanceof Error ? exception.stack : undefined,
        logContext,
      );
    } else if (errorResponse.statusCode >= 400) {
      this.logger.warn('Gateway request was rejected', logContext);
    }
  }
}
