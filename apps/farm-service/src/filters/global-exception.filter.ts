import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { GqlArgumentsHost, GqlContextType } from '@nestjs/graphql';
import type { Request, Response } from 'express';
import { GraphQLError } from 'graphql';
import { buildErrorEnvelope, JSON_ERROR_CONTENT_TYPE } from '@platform/shared';

/**
 * Global Exception Filter for Farm Service
 * Handles all exceptions across HTTP and GraphQL endpoints
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
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();
    const correlationIdHeader =
      request.headers['x-correlation-id'] ?? request.headers['x-request-id'];
    const canonical = buildErrorEnvelope(exception, {
      path: request.originalUrl ?? request.url,
      correlationId: typeof correlationIdHeader === 'string' ? correlationIdHeader : undefined,
      isProduction: this.isProduction,
    });

    this.logError(
      exception,
      canonical.statusCode,
      canonical.body.error.code,
      canonical.body.error.correlationId,
    );

    response.status(canonical.statusCode).type(JSON_ERROR_CONTENT_TYPE).json(canonical.body);
  }

  private handleGraphQLException(exception: unknown, host: ArgumentsHost): GraphQLError {
    const gqlHost = GqlArgumentsHost.create(host);
    const context = gqlHost.getContext();
    const request = context?.req;

    const { statusCode, message, validationErrors } = this.parseException(exception);

    const correlationIdHeader =
      request?.headers?.['x-correlation-id'] ?? request?.headers?.['x-request-id'];
    const presentation = buildErrorEnvelope(new HttpException(message, statusCode), {
      correlationId: typeof correlationIdHeader === 'string' ? correlationIdHeader : undefined,
      isProduction: this.isProduction,
    });
    const sanitizedMessage = this.isProduction ? presentation.body.error.message : message;

    const errorResponse = {
      statusCode,
      message: sanitizedMessage,
      timestamp: new Date().toISOString(),
      correlationId: presentation.body.error.correlationId,
    };

    this.logError(
      exception,
      statusCode,
      this.getGraphQLErrorCode(statusCode),
      typeof errorResponse.correlationId === 'string' ? errorResponse.correlationId : undefined,
    );

    // Build extensions with optional validation error details
    const extensions: Record<string, unknown> = {
      code: this.getGraphQLErrorCode(statusCode),
      statusCode,
    };
    if (validationErrors && validationErrors.length > 0 && !this.isProduction) {
      extensions['validationErrors'] = validationErrors;
    }

    return new GraphQLError(sanitizedMessage, { extensions });
  }

  private parseException(exception: unknown): {
    statusCode: number;
    message: string;
    validationErrors?: string[];
  } {
    if (exception instanceof HttpException) {
      const response = exception.getResponse();
      const message =
        typeof response === 'string'
          ? response
          : (response as Record<string, unknown>)['message'] || exception.message;

      // Preserve individual validation error strings so they can be
      // forwarded to the client inside GraphQL error extensions.
      const validationErrors = Array.isArray(message) ? message.map(String) : undefined;

      return {
        statusCode: exception.getStatus(),
        message: Array.isArray(message) ? message.join(', ') : String(message),
        validationErrors,
      };
    }

    if (exception instanceof Error) {
      return {
        statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
        message: exception.message,
      };
    }

    return {
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      message: 'An unexpected error occurred',
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
      default:
        return 'INTERNAL_SERVER_ERROR';
    }
  }

  /**
   * Log error details including field-level validation messages
   * from BadRequestException responses (class-validator output).
   */
  private logError(
    exception: unknown,
    statusCode: number,
    code: string,
    correlationId: string | undefined,
  ): void {
    const context = { statusCode, code, correlationId };

    if (statusCode >= 500) {
      this.logger.error(
        'Farm request failed with a server error',
        !this.isProduction && exception instanceof Error ? exception.stack : undefined,
        context,
      );
    } else if (statusCode >= 400) {
      this.logger.warn('Farm request was rejected', context);
    }
  }
}
