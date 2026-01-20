import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { GqlArgumentsHost, GqlContextType } from '@nestjs/graphql';
import { GraphQLError } from 'graphql';

/**
 * Error response format
 */
interface ErrorResponse {
  statusCode: number;
  message: string;
  error: string;
  timestamp: string;
  path: string;
  correlationId?: string;
  tenantId?: string;
  details?: unknown;
}

/**
 * GraphQL error extensions
 */
interface GraphQLErrorExtensions {
  code: string;
  statusCode: number;
  timestamp: string;
  correlationId?: string;
  tenantId?: string;
  path?: string;
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

  catch(exception: unknown, host: ArgumentsHost): void | GraphQLError {
    const contextType = host.getType<GqlContextType>();

    if (contextType === 'graphql') {
      return this.handleGraphQLException(exception, host);
    }

    this.handleHttpException(exception, host);
  }

  private handleHttpException(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse();
    const request = ctx.getRequest();

    const { statusCode, message, errorType, details } =
      this.parseException(exception);

    const errorResponse: ErrorResponse = {
      statusCode,
      message: this.sanitizeMessage(message),
      error: errorType,
      timestamp: new Date().toISOString(),
      path: request.url,
      correlationId: request.headers?.['x-correlation-id'],
      tenantId: request.tenantId || request.headers?.['x-tenant-id'],
    };

    // Include details only in non-production
    if (!this.isProduction && details) {
      errorResponse.details = details;
    }

    this.logError(exception, errorResponse);

    response.status(statusCode).json(errorResponse);
  }

  private handleGraphQLException(
    exception: unknown,
    host: ArgumentsHost,
  ): GraphQLError {
    const gqlHost = GqlArgumentsHost.create(host);
    const context = gqlHost.getContext();
    const request = context?.req;

    const { statusCode, message, errorType, details } =
      this.parseException(exception);

    const extensions: GraphQLErrorExtensions = {
      code: this.getGraphQLErrorCode(statusCode),
      statusCode,
      timestamp: new Date().toISOString(),
      correlationId: request?.headers?.['x-correlation-id'],
      tenantId: request?.tenantId || request?.headers?.['x-tenant-id'],
    };

    // Include path in non-production
    if (!this.isProduction) {
      extensions.path = request?.url;
    }

    const errorResponse: ErrorResponse = {
      statusCode,
      message,
      error: errorType,
      timestamp: extensions.timestamp,
      path: request?.url || 'graphql',
      correlationId: extensions.correlationId,
      tenantId: extensions.tenantId,
    };

    this.logError(exception, errorResponse);

    return new GraphQLError(this.sanitizeMessage(message), {
      extensions: {
        ...extensions,
        ...(this.isProduction ? {} : { details }),
      },
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
          errorType: HttpStatus[status] || 'Error',
        };
      }

      const responseObj = response as Record<string, unknown>;
      return {
        statusCode: status,
        message: (responseObj['message'] as string) || exception.message,
        errorType:
          (responseObj['error'] as string) || HttpStatus[status] || 'Error',
        details: responseObj['details'],
      };
    }

    if (exception instanceof GraphQLError) {
      const extensions = exception.extensions || {};
      return {
        statusCode: (extensions['statusCode'] as number) || 500,
        message: exception.message,
        errorType: (extensions['code'] as string) || 'INTERNAL_SERVER_ERROR',
        details: extensions['details'],
      };
    }

    if (exception instanceof Error) {
      return {
        statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
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

  private sanitizeMessage(message: string): string {
    if (!this.isProduction) {
      return message;
    }

    // In production, sanitize potentially sensitive error messages
    const sensitivePatterns = [
      /password/i,
      /secret/i,
      /token/i,
      /key/i,
      /credential/i,
      /sql/i,
      /query/i,
      /database/i,
    ];

    for (const pattern of sensitivePatterns) {
      if (pattern.test(message)) {
        return 'An error occurred while processing your request';
      }
    }

    return message;
  }

  private logError(exception: unknown, errorResponse: ErrorResponse): void {
    const logContext = {
      statusCode: errorResponse.statusCode,
      path: errorResponse.path,
      correlationId: errorResponse.correlationId,
      tenantId: errorResponse.tenantId,
      timestamp: errorResponse.timestamp,
    };

    if (errorResponse.statusCode >= 500) {
      this.logger.error(
        `[${errorResponse.correlationId || 'N/A'}] ${errorResponse.message}`,
        exception instanceof Error ? exception.stack : undefined,
        logContext,
      );
    } else if (errorResponse.statusCode >= 400) {
      this.logger.warn(
        `[${errorResponse.correlationId || 'N/A'}] ${errorResponse.message}`,
        logContext,
      );
    }
  }
}
