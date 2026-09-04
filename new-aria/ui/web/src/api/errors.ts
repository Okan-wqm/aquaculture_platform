// Typed API failure.
//
// WHY: every caller must be able to distinguish "server said no" (HTTP status +
// contract ApiError body) from "the network died" without string-matching
// messages. The contract's ApiError shape is preserved verbatim as `payload`.
// WHAT: an Error subclass carrying status, the parsed ApiError and the URL.
import type { ApiError } from '../../../shared/api-contract.ts';

export class ApiClientError extends Error {
  readonly status: number;
  readonly payload: ApiError;
  readonly url: string;

  constructor(status: number, payload: ApiError, url: string) {
    super(payload.detail === undefined ? payload.error : `${payload.error}: ${payload.detail}`);
    this.name = 'ApiClientError';
    this.status = status;
    this.payload = payload;
    this.url = url;
  }

  /** 401 means the token is missing or rejected; the guard clears it and shows login. */
  get isUnauthorized(): boolean {
    return this.status === 401;
  }
}

export function isApiClientError(value: unknown): value is ApiClientError {
  return value instanceof ApiClientError;
}

/** Normalises any thrown value into an Error so UI error states never render `undefined`. */
export function toError(value: unknown): Error {
  if (value instanceof Error) {
    return value;
  }
  return new Error(typeof value === 'string' ? value : 'Bilinmeyen hata');
}
