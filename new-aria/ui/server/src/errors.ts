// HTTP-facing errors — one class the router turns into the ApiError contract.
//
// WHY: readers and actions signal failures with a status and a stable machine
// code; the router owns the wire shape so no handler formats JSON errors itself.
// WHAT: HttpError carries status + code + detail; `toApiError` renders the body.

import type { ApiError } from '../../shared/api-contract.ts';

export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly detail: string | undefined;

  constructor(status: number, code: string, detail?: string) {
    super(detail === undefined ? code : `${code}: ${detail}`);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}

export function toApiError(error: unknown): { status: number; body: ApiError } {
  if (error instanceof HttpError) {
    return {
      status: error.status,
      body: error.detail === undefined ? { error: error.code } : { error: error.code, detail: error.detail },
    };
  }
  const detail = error instanceof Error ? error.message : String(error);
  return { status: 500, body: { error: 'internal_error', detail } };
}
