import { signedFetch, type SignedFetchOptions } from './signed-http-client';

/**
 * Transient-vs-permanent classification of an internal HTTP call — the
 * retry-decision SSoT shared by NATS handlers (PLAT-HIGH-902) and the
 * regulatory submission pipeline (RegulatorySubmissionService.classifyFailure).
 *
 * - transient: the moment failed, not the request — network error, timeout,
 *   5xx, and the recoverable 4xx (401 token, 403 rotation, 408, 429). Retry.
 * - permanent: the request itself is rejected — every other 4xx (400, 404,
 *   409, 422 …). Retrying re-sends the same rejected request; stop.
 */
export type HttpFailureClass = 'transient' | 'permanent';

const RECOVERABLE_4XX: ReadonlySet<number> = new Set([401, 403, 408, 429]);

export function classifyHttpStatus(status: number | undefined): HttpFailureClass {
  if (status === undefined) return 'transient';
  if (status >= 500) return 'transient';
  if (RECOVERABLE_4XX.has(status)) return 'transient';
  if (status >= 400) return 'permanent';
  // A non-error status handed to the classifier is a caller bug, not a
  // reason to retry forever.
  return 'permanent';
}

/** Outcome of a signed internal JSON call, with the failure already classified. */
export type InternalCallResult<T> =
  | { readonly ok: true; readonly status: number; readonly body: T }
  | {
      readonly ok: false;
      readonly status?: number;
      readonly failureClass: HttpFailureClass;
      readonly error: string;
    };

/**
 * signedFetch + JSON decode + classification in one step, so a caller never
 * has to reconstruct "was that a 404 or a 503" from a null.
 */
export async function signedFetchJson<T>(
  input: string | URL,
  options: SignedFetchOptions,
): Promise<InternalCallResult<T>> {
  let response: Response;
  try {
    response = await signedFetch(input, options);
  } catch (error) {
    return {
      ok: false,
      failureClass: 'transient',
      error: error instanceof Error ? error.message : String(error),
    };
  }
  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      failureClass: classifyHttpStatus(response.status),
      error: `HTTP ${response.status}`,
    };
  }
  try {
    return { ok: true, status: response.status, body: (await response.json()) as T };
  } catch (error) {
    // A 2xx whose body is not JSON is the server's contract violation; the
    // same body comes back on every retry.
    return {
      ok: false,
      status: response.status,
      failureClass: 'permanent',
      error: `invalid JSON body: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
