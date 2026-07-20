/**
 * HTTP Exception Filter
 *
 * Gateway HTTP failures use the shared platform envelope. GraphQL keeps its
 * Apollo exception path because changing that transport contract would break
 * federated subgraphs.
 */

import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { GqlContextType } from '@nestjs/graphql';
import type { Request, Response } from 'express';
import { buildErrorEnvelope, type ErrorResponse, JSON_ERROR_CONTENT_TYPE } from '@platform/shared';

export type HttpErrorResponse = ErrorResponse;

export interface ValidationError {
  field: string;
  message: string;
  code: string;
  value?: unknown;
}

@Catch(HttpException)
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpExceptionFilter.name);
  private readonly isProduction = process.env['NODE_ENV'] === 'production';

  catch(exception: HttpException, host: ArgumentsHost): void {
    if (host.getType<GqlContextType>() === 'graphql') {
      throw exception;
    }

    const ctx = host.switchToHttp();
    const request = ctx.getRequest<Request>();
    const response = ctx.getResponse<Response>();
    const exceptionResponse = exception.getResponse();

    this.addSpecialHeaders(response, exception.getStatus(), exceptionResponse);

    const correlationIdHeader =
      request.headers['x-correlation-id'] ?? request.headers['x-request-id'];
    const canonical = buildErrorEnvelope(exception, {
      path: request.originalUrl ?? request.url,
      correlationId: typeof correlationIdHeader === 'string' ? correlationIdHeader : undefined,
      isProduction: this.isProduction,
    });

    this.logError(exception, request, canonical.statusCode, canonical.body.error);

    response.status(canonical.statusCode).type(JSON_ERROR_CONTENT_TYPE).json(canonical.body);
  }

  private addSpecialHeaders(
    response: Response,
    statusCode: number,
    exceptionResponse: string | object,
  ): void {
    const responseObject =
      typeof exceptionResponse === 'object' && exceptionResponse !== null
        ? (exceptionResponse as Record<string, unknown>)
        : undefined;

    if (statusCode === HttpStatus.TOO_MANY_REQUESTS) {
      const retryAfter = responseObject?.['retryAfter'];
      response.setHeader(
        'Retry-After',
        typeof retryAfter === 'number' && Number.isFinite(retryAfter) ? String(retryAfter) : '60',
      );
    }

    if (statusCode === HttpStatus.UNAUTHORIZED) {
      response.setHeader('WWW-Authenticate', 'Bearer');
    }

    if (statusCode === HttpStatus.METHOD_NOT_ALLOWED) {
      const allowedMethods = responseObject?.['allowedMethods'];
      if (
        Array.isArray(allowedMethods) &&
        allowedMethods.every((method): method is string => typeof method === 'string')
      ) {
        response.setHeader('Allow', allowedMethods.join(', '));
      }
    }
  }

  private logError(
    exception: HttpException,
    request: Request,
    statusCode: number,
    error: ErrorResponse['error'],
  ): void {
    const context = {
      method: request.method,
      path: this.isProduction ? undefined : error.path,
      statusCode,
      code: error.code,
      correlationId: error.correlationId,
    };

    if (statusCode >= 500) {
      this.logger.error(
        'Gateway HTTP exception reached the server-error boundary',
        this.isProduction ? undefined : exception.stack,
        context,
      );
      return;
    }

    this.logger.warn('Gateway HTTP request was rejected', context);
  }
}

export function createHttpException(
  statusCode: HttpStatus,
  message: string,
  details?: unknown,
): HttpException {
  return new HttpException(
    {
      message,
      details,
      statusCode,
    },
    statusCode,
  );
}

export function createValidationException(errors: ValidationError[]): HttpException {
  return new HttpException(
    {
      message: 'Validation failed',
      validationErrors: errors,
      statusCode: HttpStatus.UNPROCESSABLE_ENTITY,
    },
    HttpStatus.UNPROCESSABLE_ENTITY,
  );
}
