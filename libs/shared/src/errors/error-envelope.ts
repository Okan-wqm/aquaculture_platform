import { HttpException, HttpStatus } from '@nestjs/common';

import { ERROR_CODES, ErrorCode } from './error-codes';

/** The only media type used for platform HTTP error responses. */
export const JSON_ERROR_CONTENT_TYPE = 'application/json';

/**
 * Canonical platform HTTP error contract.
 *
 * Keep transport metadata (HTTP status, headers) outside this object. In
 * particular, tenant identity is server-side context and must never be added
 * to the client response.
 */
export interface ErrorResponse {
  success: false;
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
    timestamp: string;
    path?: string;
    correlationId?: string;
  };
}

export interface CanonicalHttpError {
  statusCode: number;
  body: ErrorResponse;
}

export interface BuildErrorEnvelopeOptions {
  path?: string;
  correlationId?: string;
  isProduction?: boolean;
  /** Test seam; production callers should omit it. */
  timestamp?: string;
}

/**
 * Stable mapping for untyped NestJS HttpExceptions. Typed
 * ApplicationExceptions retain their registered ERROR_CODES entry.
 */
export const HTTP_STATUS_ERROR_CODES: Readonly<Record<number, ErrorCode>> = Object.freeze({
  400: 'VALIDATION_FAILED',
  401: 'AUTH_TOKEN_INVALID',
  402: 'HTTP_PAYMENT_REQUIRED',
  403: 'AUTH_FORBIDDEN',
  404: 'RESOURCE_NOT_FOUND',
  405: 'HTTP_METHOD_NOT_ALLOWED',
  406: 'HTTP_NOT_ACCEPTABLE',
  408: 'HTTP_REQUEST_TIMEOUT',
  409: 'RESOURCE_CONFLICT',
  410: 'HTTP_RESOURCE_GONE',
  413: 'HTTP_PAYLOAD_TOO_LARGE',
  415: 'HTTP_UNSUPPORTED_MEDIA_TYPE',
  422: 'HTTP_UNPROCESSABLE_ENTITY',
  429: 'RATE_LIMIT_EXCEEDED',
  500: 'INTERNAL_SERVER_ERROR',
  501: 'HTTP_NOT_IMPLEMENTED',
  502: 'HTTP_BAD_GATEWAY',
  503: 'EXTERNAL_SERVICE_UNAVAILABLE',
  504: 'EXTERNAL_SERVICE_TIMEOUT',
});

interface ParsedException {
  statusCode: number;
  code: ErrorCode;
  message: string;
  details?: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isKnownErrorCode(value: unknown): value is ErrorCode {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(ERROR_CODES, value);
}

export function errorCodeForHttpStatus(statusCode: number): ErrorCode {
  return HTTP_STATUS_ERROR_CODES[statusCode] ?? 'INTERNAL_SERVER_ERROR';
}

function extractValidationDetails(messages: unknown[]): Record<string, unknown> | undefined {
  if (messages.length === 0) {
    return undefined;
  }

  const fields: Record<string, string[]> = {};
  for (const message of messages) {
    const normalized = String(message);
    const field = normalized.match(/^(\w+)\s/)?.[1] ?? '_general';
    (fields[field] ??= []).push(normalized);
  }

  return { fields };
}

function extractCanonicalError(
  response: Record<string, unknown>,
  statusCode: number,
): Pick<ParsedException, 'code' | 'message' | 'details'> | undefined {
  if (response['success'] !== false || !isRecord(response['error'])) {
    return undefined;
  }

  const error = response['error'];
  const code = error['code'];
  if (
    !isKnownErrorCode(code) ||
    ERROR_CODES[code].status !== statusCode ||
    typeof error['message'] !== 'string'
  ) {
    return undefined;
  }

  return {
    code,
    message: error['message'],
    details: isRecord(error['details']) ? error['details'] : undefined,
  };
}

function parseHttpException(exception: HttpException): ParsedException {
  const exceptionStatus = exception.getStatus();
  const response = exception.getResponse();
  const fallbackCode = HTTP_STATUS_ERROR_CODES[exceptionStatus];

  // A code whose registry status disagrees with the HTTP status is worse than
  // a generic failure: clients cannot make a deterministic decision. Unknown
  // HttpException statuses therefore normalize to the registered 500 pair.
  const statusCode = fallbackCode ? exceptionStatus : HttpStatus.INTERNAL_SERVER_ERROR;
  const code = fallbackCode ?? 'INTERNAL_SERVER_ERROR';

  if (typeof response === 'string') {
    return {
      statusCode,
      code,
      message: response,
    };
  }

  if (!isRecord(response)) {
    return {
      statusCode,
      code,
      message: exception.message,
    };
  }

  const canonical = extractCanonicalError(response, statusCode);
  if (canonical) {
    return { statusCode, ...canonical };
  }

  const rawMessage = response['message'];
  const message = Array.isArray(rawMessage)
    ? rawMessage.map(String).join(', ')
    : typeof rawMessage === 'string'
      ? rawMessage
      : exception.message;
  const explicitDetails = isRecord(response['details']) ? response['details'] : undefined;

  return {
    statusCode,
    code,
    message,
    details:
      explicitDetails ??
      (Array.isArray(rawMessage) ? extractValidationDetails(rawMessage) : undefined),
  };
}

function parseException(exception: unknown): ParsedException {
  if (exception instanceof HttpException) {
    return parseHttpException(exception);
  }

  if (exception instanceof Error) {
    return {
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      code: 'INTERNAL_SERVER_ERROR',
      message: exception.message,
      details: exception.stack ? { stack: exception.stack } : undefined,
    };
  }

  return {
    statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
    code: 'INTERNAL_SERVER_ERROR',
    message: 'An unexpected error occurred',
  };
}

function safeProductionMessage(parsed: ParsedException): string {
  // Production text is allowlisted through the registry. Exception messages
  // are attacker-controlled at many boundaries and can contain PII, signed
  // URLs, credentials, SQL, or provider response fragments.
  return ERROR_CODES[parsed.code].message;
}

function normalizePath(path: string | undefined): string | undefined {
  if (!path) {
    return undefined;
  }

  // Query strings frequently carry opaque tokens. They are not part of the
  // route identity and must not be reflected into an error response.
  const normalized = path.split(/[?#]/u, 1)[0]?.trim();
  return normalized || undefined;
}

/** Build the canonical body and its HTTP status from any thrown value. */
export function buildErrorEnvelope(
  exception: unknown,
  options: BuildErrorEnvelopeOptions = {},
): CanonicalHttpError {
  const parsed = parseException(exception);
  const isProduction = options.isProduction ?? process.env['NODE_ENV'] === 'production';
  const error: ErrorResponse['error'] = {
    code: parsed.code,
    message: isProduction ? safeProductionMessage(parsed) : parsed.message,
    timestamp: options.timestamp ?? new Date().toISOString(),
  };

  if (!isProduction && parsed.details) {
    error.details = parsed.details;
  }

  // Express gives us a concrete URL, not a safe route template. It can contain
  // emails, object keys, and signed path components, so production responses do
  // not reflect it. Development keeps the query-free path for diagnostics.
  const path = isProduction ? undefined : normalizePath(options.path);
  if (path) {
    error.path = path;
  }

  const correlationId = options.correlationId?.trim();
  if (correlationId && /^[A-Za-z0-9._:-]{1,128}$/u.test(correlationId)) {
    error.correlationId = correlationId;
  }

  return {
    statusCode: parsed.statusCode,
    body: {
      success: false,
      error,
    },
  };
}
