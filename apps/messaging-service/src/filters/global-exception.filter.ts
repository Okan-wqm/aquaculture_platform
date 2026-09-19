import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { GqlArgumentsHost, GqlContextType } from '@nestjs/graphql';
import { Request, Response } from 'express';
import { GraphQLError } from 'graphql';

/**
 * Global Exception Filter for messaging-service.
 *
 * MSGFIX-FAZ0 (2026-09-16) — GraphQL error-code contract.
 *
 * Before this filter the service registered NO exception filter at all, so a
 * NestJS `NotFoundException` thrown by a resolver reached Apollo Server as a
 * plain Error. Apollo formats unknown errors with
 * `extensions.code = INTERNAL_SERVER_ERROR`, and when that federated error
 * surfaces at gateway-api (apps/gateway-api/src/filters/global-exception.filter.ts
 * parseException, the `GraphQLError` branch) the missing `extensions.code`/
 * `statusCode` defaulted to 500/INTERNAL_SERVER_ERROR. Clients saw "not found"
 * failures reported as internal server errors.
 *
 * This filter is ADDITIVE and mirrors the already-shipped farm-service /
 * gateway-api pattern:
 *   - NestJS HttpException status → GraphQL-convention extension code
 *     (404 → NOT_FOUND, 401 → UNAUTHENTICATED, 403 → FORBIDDEN, ...)
 *   - BOTH `extensions.code` and `extensions.statusCode` are set — the
 *     gateway re-derives its client-facing code from `statusCode`.
 *   - Errors that already carry a GraphQL code (GraphQLError with
 *     extensions.code, e.g. query-complexity rejections from the app module
 *     plugin) are passed through UNTOUCHED — never re-mapped, never dropped.
 *   - REST contexts (health/metrics probes) keep the platform-standard
 *     { statusCode, message, timestamp, path } envelope.
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

  // ── REST ───────────────────────────────────────────────────────────

  private handleHttpException(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    const { statusCode, message } = this.parseException(exception);

    const errorResponse = {
      statusCode,
      // Same production hygiene as the GraphQL branch and farm-service/gateway
      // filters: an unexpected 5xx on /health or /metrics must not leak stack
      // internals (SQL fragments, hostnames) through the REST envelope.
      message: this.isProduction ? this.sanitizeMessage(message) : message,
      timestamp: new Date().toISOString(),
      path: request.url,
      correlationId: request.headers?.['x-correlation-id'],
    };

    this.logException(exception, statusCode, message, request.url);

    response.status(statusCode).json(errorResponse);
  }

  // ── GraphQL ────────────────────────────────────────────────────────

  private handleGraphQLException(exception: unknown, host: ArgumentsHost): GraphQLError {
    const gqlHost = GqlArgumentsHost.create(host);
    const context = gqlHost.getContext<{ req?: Request }>();
    const request = context?.req;

    // Pass-through contract: an error that already has a GraphQL code keeps
    // its identity (originalError chain preserved by rethrowing as-is).
    if (exception instanceof GraphQLError && exception.extensions?.['code']) {
      return exception;
    }

    const { statusCode, message } = this.parseException(exception);

    this.logException(exception, statusCode, message, request?.url ?? 'graphql');

    return new GraphQLError(this.sanitizeMessage(message), {
      extensions: {
        code: this.getGraphQLErrorCode(statusCode),
        statusCode,
        timestamp: new Date().toISOString(),
        correlationId: request?.headers?.['x-correlation-id'],
      },
    });
  }

  // ── Shared helpers ─────────────────────────────────────────────────

  private parseException(exception: unknown): {
    statusCode: number;
    message: string;
  } {
    if (exception instanceof HttpException) {
      const response = exception.getResponse();
      const raw =
        typeof response === 'string'
          ? response
          : ((response as Record<string, unknown>)['message'] ?? exception.message);
      const message = Array.isArray(raw) ? raw.map(String).join(', ') : String(raw);
      return { statusCode: exception.getStatus(), message };
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

  /** NestJS HTTP status → GraphQL-convention extension code (MSGFIX-FAZ0). */
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

  /** Hide error internals for 5xx in production (matches platform filters). */
  private sanitizeMessage(message: string): string {
    if (!this.isProduction) return message;
    const sensitivePatterns = [/password/i, /secret/i, /token/i, /sql/i, /database/i];
    for (const pattern of sensitivePatterns) {
      if (pattern.test(message)) {
        return 'An error occurred while processing your request';
      }
    }
    return message;
  }

  private logException(
    exception: unknown,
    statusCode: number,
    message: string,
    path: string,
  ): void {
    if (statusCode >= 500) {
      this.logger.error(
        `${path}: ${message}`,
        exception instanceof Error ? exception.stack : undefined,
      );
    } else if (statusCode >= 400) {
      this.logger.warn(`${path}: ${statusCode} ${message}`);
    }
  }
}
