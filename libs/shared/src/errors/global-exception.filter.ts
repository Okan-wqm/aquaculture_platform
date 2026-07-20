// TODO(ARCH-CRIT-001 / CONTRACT-CRIT-001): Migration plan — adopt GlobalExceptionFilter platform-wide
//
// Problem: Three incompatible error response contracts coexist:
//   1. This GlobalExceptionFilter — canonical { success, error: { code, message, ... } } shape
//   2. Service-specific HttpExceptionFilter / AllExceptionsFilter (sensor-service, auth-service, etc.)
//      — uses raw { statusCode, message, error } shape from NestJS HttpException
//   3. ApplicationException / ErrorResponse — same canonical shape as (1) but not yet used widely
//
// libs/shared GlobalExceptionFilter is the canonical error-handling implementation
// but is not yet used by most services. Each service registers its own ad-hoc filter
// (e.g. libs/backend-common HttpExceptionFilter / AllExceptionsFilter / GraphQLExceptionFilter),
// producing inconsistent response envelopes across the API surface.
//
// Target state: All NestJS apps should register GlobalExceptionFilter as APP_FILTER in their
// AppModule and remove any service-local exception filter registrations.
//
// Migration steps (per service, one at a time):
//   1. Remove local exception filter from providers[] / main.ts useGlobalFilters()
//   2. Add { provide: APP_FILTER, useClass: GlobalExceptionFilter } to AppModule providers
//   3. Verify error response shape matches { success, error: { code, message, ... } }
//   4. Update any service-specific error handling tests
//
// Services still using non-standard filters (as of 2026-02-19):
//   - apps/auth-service        (AllExceptionsFilter from backend-common)
//   - apps/config-service      (AllExceptionsFilter from backend-common)
//   - apps/gateway-api         (AllExceptionsFilter from backend-common)
//   - apps/billing-service     (AllExceptionsFilter from backend-common)
//   - apps/hr-service          (AllExceptionsFilter from backend-common)
//   - apps/admin-api-service   (AllExceptionsFilter from backend-common)
//
// Note: apps/farm-service already uses GlobalExceptionFilter (see farm-service/src/app.module.ts).
//
// TODO(ARCH-CRIT-002): ApplicationException / ErrorCode adoption
// Once a service adopts this filter, replace ad-hoc throw new HttpException() calls with
// ApplicationException or its typed subclasses (ValidationException, BusinessRuleException,
// ExternalServiceException). This ensures typed error codes from error-codes.ts flow through
// getErrorResponse() automatically and appear in the response envelope. See application-exception.ts
// and error-codes.ts for the full registry of typed codes.
import { ExceptionFilter, Catch, ArgumentsHost, Logger } from '@nestjs/common';
import { Request, Response } from 'express';

import { buildErrorEnvelope, JSON_ERROR_CONTENT_TYPE } from './error-envelope';

/**
 * Global Exception Filter
 *
 * Catches all exceptions and transforms them into a standardized error response format.
 * Ensures consistent error handling across all API endpoints.
 */
@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(GlobalExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    const correlationIdHeader =
      request.headers['x-correlation-id'] ?? request.headers['x-request-id'];
    const correlationId = typeof correlationIdHeader === 'string' ? correlationIdHeader : undefined;
    const canonical = buildErrorEnvelope(exception, {
      path: request.originalUrl ?? request.url,
      correlationId,
    });

    this.logError(
      exception,
      request,
      canonical.statusCode,
      canonical.body.error.code,
      canonical.body.error.correlationId,
    );

    response.status(canonical.statusCode).type(JSON_ERROR_CONTENT_TYPE).json(canonical.body);
  }

  private logError(
    exception: unknown,
    request: Request,
    status: number,
    code: string,
    correlationId: string | undefined,
  ): void {
    const isProduction = process.env['NODE_ENV'] === 'production';
    const errorDetails = {
      method: request.method,
      status,
      code,
      correlationId,
    };

    if (status >= 500) {
      this.logger.error(
        'HTTP request failed with a server error',
        !isProduction && exception instanceof Error ? exception.stack : undefined,
        errorDetails,
      );
    } else if (status >= 400) {
      this.logger.warn('HTTP request was rejected', errorDetails);
    }
  }
}
