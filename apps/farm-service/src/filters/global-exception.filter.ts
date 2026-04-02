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
    const response = ctx.getResponse();
    const request = ctx.getRequest();

    const { statusCode, message } = this.parseException(exception);

    const errorResponse = {
      statusCode,
      message: this.isProduction ? this.sanitizeMessage(message) : message,
      timestamp: new Date().toISOString(),
      path: request.url,
      correlationId: request.headers?.['x-correlation-id'],
    };

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

    const { statusCode, message, validationErrors } = this.parseException(exception);

    const sanitizedMessage = this.isProduction ? this.sanitizeMessage(message) : message;

    const errorResponse = {
      statusCode,
      message: sanitizedMessage,
      timestamp: new Date().toISOString(),
      correlationId: request?.headers?.['x-correlation-id'],
    };

    this.logError(exception, errorResponse);

    // Build extensions with optional validation error details
    const extensions: Record<string, unknown> = {
      code: this.getGraphQLErrorCode(statusCode),
      statusCode,
    };
    if (validationErrors && validationErrors.length > 0 && !this.isProduction) {
      extensions['validationErrors'] = validationErrors;
    }

    return new GraphQLError(
      this.isProduction ? this.sanitizeMessage(message) : message,
      { extensions },
    );
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

  private sanitizeMessage(message: string): string {
    const sensitivePatterns = [
      /password/i,
      /secret/i,
      /token/i,
      /database/i,
      /sql/i,
    ];

    for (const pattern of sensitivePatterns) {
      if (pattern.test(message)) {
        return 'An error occurred while processing your request';
      }
    }

    return message;
  }

  /**
   * Log error details including field-level validation messages
   * from BadRequestException responses (class-validator output).
   */
  private logError(
    exception: unknown,
    errorResponse: Record<string, unknown>,
  ): void {
    const statusCode = errorResponse['statusCode'] as number;
    const correlationId = errorResponse['correlationId'] || 'N/A';

    if (statusCode >= 500) {
      this.logger.error(
        `[${correlationId}] ${errorResponse['message']}`,
        exception instanceof Error ? exception.stack : undefined,
      );
    } else if (statusCode >= 400) {
      // For 400 errors, include the full validation details so we can
      // see WHICH fields failed and WHY (class-validator messages).
      let detail = '';
      if (exception instanceof HttpException) {
        const response = exception.getResponse();
        if (typeof response === 'object' && response !== null) {
          try {
            detail = ` | details: ${JSON.stringify(response)}`;
          } catch {
            detail = ` | details: [unserializable response]`;
          }
        }
      }
      this.logger.warn(
        `[${correlationId}] ${errorResponse['message']}${detail}`,
      );
    }
  }
}
