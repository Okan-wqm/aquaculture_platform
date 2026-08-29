/** ES2021-compatible error-cause authority with the native non-enumerable descriptor shape. */
export interface ErrorCauseOptionsV1 {
  readonly cause?: unknown;
}

export function defineErrorCause<TError extends Error>(error: TError, cause: unknown): TError {
  Object.defineProperty(error, 'cause', {
    configurable: true,
    enumerable: false,
    value: cause,
    writable: true,
  });
  return error;
}

export function applyErrorCauseOptions<TError extends Error>(
  error: TError,
  options?: ErrorCauseOptionsV1 | null,
): TError {
  return options !== undefined && options !== null && 'cause' in options
    ? defineErrorCause(error, options.cause)
    : error;
}

export function errorWithCause(message: string, cause: unknown): Error {
  return defineErrorCause(new Error(message), cause);
}

/** Preserve real Error identity while making non-Error throws safe at typed boundaries. */
export function errorFromUnknown(message: string, cause: unknown): Error {
  return cause instanceof Error ? cause : errorWithCause(message, cause);
}
