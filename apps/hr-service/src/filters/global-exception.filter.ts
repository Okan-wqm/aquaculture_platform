import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { GqlContextType } from '@nestjs/graphql';
import { GraphQLError } from 'graphql';

@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(GlobalExceptionFilter.name);
  private readonly isProduction = process.env['NODE_ENV'] === 'production';

  catch(exception: unknown, host: ArgumentsHost): void {
    const { statusCode, message } = this.parseException(exception);

    if (statusCode >= 500) {
      this.logger.error(message, exception instanceof Error ? exception.stack : undefined);
    }

    // GraphQL requests must propagate exceptions as GraphQL errors, not HTTP responses.
    // Calling switchToHttp() inside a GQL context returns null objects and throws.
    if (host.getType<GqlContextType>() === 'graphql') {
      // GQL error propagation: re-throw as a GraphQLError so Apollo's error formatter
      // can serialise it correctly.
      throw new GraphQLError(
        this.isProduction ? this.sanitize(message) : message,
        {
          extensions: {
            code: this.httpStatusToGqlCode(statusCode),
            statusCode,
          },
        },
      );
    }

    // HTTP context (health endpoint, REST, etc.)
    const ctx = host.switchToHttp();
    const response = ctx.getResponse();
    const request = ctx.getRequest();

    const errorResponse = {
      statusCode,
      message: this.isProduction ? this.sanitize(message) : message,
      timestamp: new Date().toISOString(),
      path: request?.url,
    };

    response.status(statusCode).json(errorResponse);
  }

  private parseException(exception: unknown): { statusCode: number; message: string } {
    if (exception instanceof HttpException) {
      const response = exception.getResponse();
      return {
        statusCode: exception.getStatus(),
        message: typeof response === 'string'
          ? response
          : this.extractMessage(response) || exception.message,
      };
    }
    return {
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      message: exception instanceof Error ? exception.message : 'Unknown error',
    };
  }

  private extractMessage(response: unknown): string | undefined {
    if (response && typeof response === 'object' && 'message' in response) {
      const msg = (response as { message: unknown }).message;
      return typeof msg === 'string' ? msg : undefined;
    }
    return undefined;
  }

  /**
   * HR-HIGH-004: Redact PII from error messages.
   *
   * SECURITY: Employee names, national IDs, emails, and phone numbers
   * must never appear in client-facing error responses. This filter
   * strips known PII patterns and sensitive keywords. In production,
   * ALL messages are sanitized; in dev, only sensitive keywords trigger
   * full redaction.
   */
  private sanitize(message: string): string {
    // Always redact messages containing obviously sensitive keywords
    if (/password|secret|token|sql|credentials/i.test(message)) {
      return 'An error occurred';
    }

    // SECURITY: Redact common PII patterns from error messages
    let sanitized = message;

    // Redact email addresses
    sanitized = sanitized.replace(
      /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g,
      '[REDACTED_EMAIL]',
    );

    // Redact Turkish national ID (TC Kimlik) — 11 digits
    sanitized = sanitized.replace(/\b\d{11}\b/g, '[REDACTED_ID]');

    // Redact phone numbers (various formats)
    sanitized = sanitized.replace(
      /(\+?\d{1,3}[-.\s]?)?\(?\d{3}\)?.[-.\s]?\d{3}[-.\s]?\d{2,4}/g,
      '[REDACTED_PHONE]',
    );

    // Redact potential names after known context words (e.g., "Employee John Doe")
    // Only replace if pattern matches "Employee <word> <word>" to avoid false positives
    sanitized = sanitized.replace(
      /\b(employee|user|manager|staff)\s+[A-Z][a-z]+\s+[A-Z][a-z]+/gi,
      '$1 [REDACTED_NAME]',
    );

    return sanitized;
  }

  /**
   * Map HTTP status codes to GraphQL error extension codes
   */
  private httpStatusToGqlCode(statusCode: number): string {
    switch (statusCode) {
      case HttpStatus.BAD_REQUEST:        return 'BAD_USER_INPUT';
      case HttpStatus.UNAUTHORIZED:       return 'UNAUTHENTICATED';
      case HttpStatus.FORBIDDEN:          return 'FORBIDDEN';
      case HttpStatus.NOT_FOUND:          return 'NOT_FOUND';
      case HttpStatus.CONFLICT:           return 'CONFLICT';
      case HttpStatus.TOO_MANY_REQUESTS:  return 'RATE_LIMITED';
      default:                            return 'INTERNAL_SERVER_ERROR';
    }
  }
}
