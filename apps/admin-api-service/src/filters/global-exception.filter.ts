import { createHash } from 'node:crypto';

import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus } from '@nestjs/common';
import { StructuredLoggerService } from '@aquaculture/backend-common/logging';
import {
  ADMIN_HTTP_DEFAULT_CODE_BY_STATUS,
  ADMIN_HTTP_STATUS_BY_ERROR_CODE,
  decodeBoundedAdminErrorDetails,
  encodeAdminHttpErrorEnvelopeV1,
  type AdminHttpErrorCode,
  type AdminHttpErrorDetailV1,
  type JsonValue,
} from '@platform/admin-http-contracts';
import type { Request, Response } from 'express';
import { QueryFailedError } from 'typeorm';

import { adminRequestContext } from '../shared/admin-request-context';
import { ADMIN_HTTP_LOG_EVENTS } from '../shared/admin-http-log-events';
import { replaceAdminControlCharacters } from '../shared/admin-text-boundary';

const SAFE_ERROR_MESSAGES: Readonly<Record<AdminHttpErrorCode, string>> = Object.freeze({
  BAD_REQUEST: 'Request was rejected',
  UNAUTHENTICATED: 'Authentication is required',
  FORBIDDEN: 'Access is forbidden',
  NOT_FOUND: 'Resource was not found',
  METHOD_NOT_ALLOWED: 'Method is not allowed',
  CONFLICT: 'Request conflicts with current state',
  GONE: 'Resource is no longer available',
  VALIDATION_FAILED: 'Request validation failed',
  UNPROCESSABLE_ENTITY: 'Request could not be processed',
  RATE_LIMITED: 'Request rate limit exceeded',
  DATABASE_CONFLICT: 'Resource already exists',
  DATABASE_REFERENCE_MISSING: 'Referenced resource not found',
  DATABASE_REQUIRED_VALUE_MISSING: 'Missing required field',
  DATABASE_ERROR: 'Database operation failed',
  INTERNAL_ERROR: 'An unexpected error occurred',
  NOT_IMPLEMENTED: 'Operation is not implemented',
  BAD_GATEWAY: 'Upstream service failed',
  SERVICE_UNAVAILABLE: 'Service is unavailable',
  GATEWAY_TIMEOUT: 'Upstream service timed out',
});

function boundedMessage(value: unknown, fallback: string): string {
  const messages = Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : typeof value === 'string'
      ? [value]
      : [];
  const joined = messages.join('; ');
  const sanitized = replaceAdminControlCharacters(joined).trim();
  return (sanitized || fallback).slice(0, 512);
}

function validationDetails(value: unknown): JsonValue | undefined {
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === 'string')) {
    return undefined;
  }
  const validationMessages = value
    .slice(0, 50)
    .map((message) => boundedMessage(message, 'Invalid value'));
  return decodeBoundedAdminErrorDetails({ validationMessages });
}

function safeExceptionClass(exception: unknown): string {
  if (exception instanceof QueryFailedError) return 'QueryFailedError';
  if (exception instanceof HttpException) return 'HttpException';
  if (exception instanceof Error) return 'Error';
  return 'NonErrorThrow';
}

function failureFingerprint(
  exceptionClass: string,
  status: number,
  code: AdminHttpErrorCode,
): string {
  return createHash('sha256')
    .update(`admin-http-failure.v1\0${exceptionClass}\0${status}\0${code}`)
    .digest('hex')
    .slice(0, 24);
}

@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  private readonly logger = new StructuredLoggerService('admin-api-service');

  catch(exception: unknown, host: ArgumentsHost): void {
    if (host.getType() !== 'http') {
      // APP_FILTER is application-scoped. A future hybrid bootstrap must not
      // reinterpret RPC/WS failures as Express responses or swallow them after
      // switching to a transport that has no HTTP response object.
      throw exception;
    }
    const context = host.switchToHttp();
    const response = context.getResponse<Response>();
    const request = context.getRequest<Request>();
    const requestContext = adminRequestContext(request, response);
    const detail = this.buildErrorDetail(exception, requestContext);
    const exceptionClass = safeExceptionClass(exception);
    const logRecord = Object.freeze({
      eventCode: ADMIN_HTTP_LOG_EVENTS.requestFailure,
      requestId: requestContext.requestId,
      routeId: requestContext.routeId,
      status: detail.status,
      code: detail.code,
      exceptionClass,
      fingerprint: failureFingerprint(exceptionClass, detail.status, detail.code),
    });
    if (detail.status >= 500) {
      this.logger.error(
        ADMIN_HTTP_LOG_EVENTS.requestFailure,
        logRecord,
        GlobalExceptionFilter.name,
      );
    } else {
      this.logger.warn(ADMIN_HTTP_LOG_EVENTS.requestFailure, logRecord, GlobalExceptionFilter.name);
    }
    response.status(detail.status).json(encodeAdminHttpErrorEnvelopeV1(detail));
  }

  private buildErrorDetail(
    exception: unknown,
    requestContext: ReturnType<typeof adminRequestContext>,
  ): AdminHttpErrorDetailV1 {
    const common = {
      timestamp: new Date().toISOString(),
      path: requestContext.routePath,
      requestId: requestContext.requestId,
    };

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const response = exception.getResponse();
      const record =
        typeof response === 'object' && response !== null && !Array.isArray(response)
          ? (response as Readonly<Record<string, unknown>>)
          : undefined;
      const rawMessage = record?.['message'] ?? response;
      const validation = validationDetails(rawMessage);
      if (validation !== undefined) {
        return {
          status: ADMIN_HTTP_STATUS_BY_ERROR_CODE.VALIDATION_FAILED,
          code: 'VALIDATION_FAILED',
          message: SAFE_ERROR_MESSAGES.VALIDATION_FAILED,
          ...common,
          details: validation,
        };
      }
      const code = ADMIN_HTTP_DEFAULT_CODE_BY_STATUS[status];
      if (code === undefined) {
        return {
          status: ADMIN_HTTP_STATUS_BY_ERROR_CODE.INTERNAL_ERROR,
          code: 'INTERNAL_ERROR',
          message: SAFE_ERROR_MESSAGES.INTERNAL_ERROR,
          ...common,
        };
      }
      return {
        status: ADMIN_HTTP_STATUS_BY_ERROR_CODE[code],
        code,
        message: SAFE_ERROR_MESSAGES[code],
        ...common,
      };
    }

    if (exception instanceof QueryFailedError) {
      const driverError: unknown = exception.driverError;
      const code =
        typeof driverError === 'object' && driverError !== null && 'code' in driverError
          ? Reflect.get(driverError, 'code')
          : undefined;
      if (code === '23505') {
        return {
          status: HttpStatus.CONFLICT,
          code: 'DATABASE_CONFLICT',
          message: SAFE_ERROR_MESSAGES.DATABASE_CONFLICT,
          ...common,
        };
      }
      if (code === '23503') {
        return {
          status: HttpStatus.BAD_REQUEST,
          code: 'DATABASE_REFERENCE_MISSING',
          message: SAFE_ERROR_MESSAGES.DATABASE_REFERENCE_MISSING,
          ...common,
        };
      }
      if (code === '23502') {
        return {
          status: HttpStatus.BAD_REQUEST,
          code: 'DATABASE_REQUIRED_VALUE_MISSING',
          message: SAFE_ERROR_MESSAGES.DATABASE_REQUIRED_VALUE_MISSING,
          ...common,
        };
      }
      return {
        status: HttpStatus.INTERNAL_SERVER_ERROR,
        code: 'DATABASE_ERROR',
        message: SAFE_ERROR_MESSAGES.DATABASE_ERROR,
        ...common,
      };
    }

    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      code: 'INTERNAL_ERROR',
      message: SAFE_ERROR_MESSAGES.INTERNAL_ERROR,
      ...common,
    };
  }
}
