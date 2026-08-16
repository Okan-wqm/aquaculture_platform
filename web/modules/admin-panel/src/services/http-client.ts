/**
 * HTTP Client with Error Handling & Retry Logic
 * Shared infrastructure for all domain API modules
 *
 * SECURITY:
 *  - Waits for token lifecycle barrier before firing (prevents 401 race on page load)
 *  - Retries once on 401 after a silent refresh (keeps user logged in across token expiry)
 *  - Keeps admin-panel requests on the route-owned platform/bearer policy
 *  - Preserves the existing exponential backoff retry for 502/503/504 errors
 */

import {
  getAccessToken,
  tokenLifecycle,
  silentRefresh,
  clearSession,
} from '@aquaculture/shared-ui';
import {
  ADMIN_JSON_CODEC_POLICY,
  AdminHttpContractError,
  assertCanonicalAdminRequestTarget,
  createStandardPaginatedResult,
  decodeAdminAttachmentDisposition,
  decodeAdminHttpErrorEnvelopeV1,
  decodeAdminHttpEnvelopeV1,
  decodeAdminRequestId,
  parseJsonValue,
  type AdminAttachmentFilename,
  type AdminBinaryRouteDefinition,
  type AdminBinaryResponseProfile,
  type AdminHttpMethod,
  type AdminRouteRequestArguments,
  type AdminRouteRequestContract,
  type AdminResponseContract,
  type AdminRouteDefinition,
  type AdminWireResponseOf,
  type JsonValue,
} from '@platform/admin-http-contracts';
import { CSRF_SECURITY_POSTURE } from '@aquaculture/shared-contracts';

// The browser credential boundary is same-origin. Deployment routing is owned
// by the shell/nginx `/api` authority; an environment variable may not turn a
// bearer request into a cross-origin request. Admin REST never sends ambient
// cookies; the shared CSRF posture contract pins that boundary.
export const ADMIN_API_URL = '/api' as const;

// ============================================================================
// Types
// ============================================================================

export class AdminApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly code?: string,
    readonly details?: JsonValue,
    readonly requestId?: string,
  ) {
    super(message);
    this.name = 'AdminApiError';
  }
}

export function isAdminApiError(error: unknown): error is AdminApiError {
  return error instanceof AdminApiError;
}

export function adminApiErrorMessage(error: unknown, fallback: string): string {
  return isAdminApiError(error) && error.message ? error.message : fallback;
}

/**
 * Automatic transport retries are restricted to safe methods. A lost 503 or
 * network response after a mutation does not prove the mutation was rejected;
 * replaying it without an executable idempotency contract can duplicate work.
 */
const RETRYABLE_STATUS_CODES: ReadonlySet<number> = new Set([502, 503, 504]);

// ============================================================================
// Internal Helpers
// ============================================================================

const getAuthHeader = (token: string): Record<string, string> => ({
  Authorization: `Bearer ${token}`,
});

/** SEC-L03: Use cryptographically secure random UUID for request correlation IDs.
 *  Math.random() is a predictable PRNG — an attacker observing a few values can predict the next. */
const generateRequestId = (): string => {
  return crypto.randomUUID();
};

function rejectionError(reason: unknown, message: string): Error {
  return reason instanceof Error ? reason : new Error(message);
}

function abortError(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  if (reason instanceof Error) return reason;
  if (reason instanceof DOMException) return new DOMException(reason.message, reason.name);
  return new DOMException('The operation was aborted', 'AbortError');
}

function waitForRetry(delayMs: number, signal: AbortSignal, deadlineAt: number): Promise<void> {
  if (signal.aborted) return Promise.reject(abortError(signal));
  const remainingMs = deadlineAt - Date.now();
  if (remainingMs <= 0)
    return Promise.reject(new DOMException('Request deadline exceeded', 'TimeoutError'));
  const boundedDelayMs = Math.min(delayMs, remainingMs);
  return new Promise((resolve, reject) => {
    const timer = globalThis.setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, boundedDelayMs);
    const onAbort = (): void => {
      globalThis.clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      reject(abortError(signal));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function awaitAbortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortError(signal));
  return new Promise((resolve, reject) => {
    const onAbort = (): void => {
      signal.removeEventListener('abort', onAbort);
      reject(abortError(signal));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    void promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(rejectionError(error, 'Admin transport dependency rejected with a non-Error value'));
      },
    );
  });
}

const createApiError = (
  message: string,
  status?: number,
  code?: string,
  details?: JsonValue,
  requestId?: string,
): AdminApiError => new AdminApiError(message, status, code, details, requestId);

// ============================================================================
// Core API Fetch
// ============================================================================

const endpointMatchesRoute = (endpoint: string, routePath: string): boolean => {
  const [path = ''] = endpoint.split('?');
  const actualSegments = path === '/' ? [] : path.slice(1).split('/');
  const routeSegments = routePath === '/' ? [] : routePath.slice(1).split('/');
  return (
    actualSegments.length === routeSegments.length &&
    routeSegments.every(
      (segment, index) => segment.startsWith(':') || segment === actualSegments[index],
    )
  );
};

interface AdminTransportRoute {
  readonly id: string;
  readonly method: string;
  readonly path: string;
  readonly transport: 'binary-download' | 'json-envelope';
  readonly policy: AdminRouteDefinition<AdminResponseContract<unknown, unknown>>['policy'];
}

function assertJsonResponseMediaType(response: Response): void {
  const raw = response.headers.get('content-type');
  const mediaType = raw?.split(';', 1)[0]?.trim().toLowerCase();
  if (mediaType !== 'application/json') {
    throw new AdminHttpContractError(
      '$.headers.content-type',
      `expected application/json, received ${raw ?? '<missing>'}`,
    );
  }
}

function declaredResponseLength(response: Response, maxBytes: number): number | undefined {
  const header = response.headers.get('content-length');
  if (header === null) return undefined;
  if (!/^(?:0|[1-9][0-9]*)$/.test(header)) {
    throw new AdminHttpContractError(
      '$.headers.content-length',
      'content-length must be one canonical non-negative integer',
    );
  }
  const length = Number(header);
  if (!Number.isSafeInteger(length)) {
    throw new AdminHttpContractError(
      '$.headers.content-length',
      'content-length exceeds the safe integer range',
    );
  }
  if (length > maxBytes) {
    throw new AdminHttpContractError(
      '$.headers.content-length',
      `declared body exceeds route budget ${maxBytes} bytes`,
    );
  }
  return length;
}

async function cancelResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // The contract failure that triggered cancellation remains authoritative.
  }
}

function isUint8ArrayChunk(value: unknown): value is Uint8Array {
  return (
    ArrayBuffer.isView(value) && Object.prototype.toString.call(value) === '[object Uint8Array]'
  );
}

async function readBoundedResponseBody(
  response: Response,
  maxBytes: number,
  mode: 'binary' | 'utf8',
  signal: AbortSignal,
): Promise<Uint8Array | string> {
  if (signal.aborted) {
    await cancelResponseBody(response);
    throw abortError(signal);
  }
  let expectedLength: number | undefined;
  try {
    expectedLength = declaredResponseLength(response, maxBytes);
  } catch (error) {
    await cancelResponseBody(response);
    throw error;
  }

  if (response.body === null) {
    if (expectedLength !== undefined && expectedLength !== 0) {
      throw new AdminHttpContractError(
        '$.headers.content-length',
        `declared ${expectedLength} bytes but received an empty body`,
      );
    }
    return mode === 'utf8' ? '' : new Uint8Array();
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  const decoder = mode === 'utf8' ? new TextDecoder('utf-8', { fatal: true }) : undefined;
  let text = '';
  let receivedBytes = 0;
  const cancelReaderOnAbort = (): void => {
    void reader.cancel(abortError(signal)).catch(() => undefined);
  };
  signal.addEventListener('abort', cancelReaderOnAbort, { once: true });
  try {
    while (true) {
      const { done, value } = await awaitAbortable(reader.read(), signal);
      if (done) break;
      if (!isUint8ArrayChunk(value)) {
        await reader.cancel();
        throw new AdminHttpContractError('$.body', 'response stream emitted a non-byte chunk');
      }
      receivedBytes += value.byteLength;
      if (receivedBytes > maxBytes) {
        await reader.cancel();
        throw new AdminHttpContractError(
          '$.body',
          `response body exceeds route budget ${maxBytes} bytes`,
        );
      }
      if (decoder !== undefined) {
        try {
          text += decoder.decode(value, { stream: true });
        } catch {
          await reader.cancel();
          throw new AdminHttpContractError('$.body', 'response body is not valid UTF-8');
        }
      } else {
        chunks.push(value);
      }
    }

    if (expectedLength !== undefined && expectedLength !== receivedBytes) {
      throw new AdminHttpContractError(
        '$.headers.content-length',
        `declared ${expectedLength} bytes but received ${receivedBytes}`,
      );
    }
    if (decoder !== undefined) {
      try {
        return text + decoder.decode();
      } catch {
        throw new AdminHttpContractError('$.body', 'response body is not valid UTF-8');
      }
    }

    const bytes = new Uint8Array(receivedBytes);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return bytes;
  } finally {
    signal.removeEventListener('abort', cancelReaderOnAbort);
    reader.releaseLock();
  }
}

async function readBoundedJsonResponse(
  response: Response,
  signal: AbortSignal,
): Promise<JsonValue> {
  const text = await readBoundedResponseBody(
    response,
    ADMIN_JSON_CODEC_POLICY.maxWireBytes,
    'utf8',
    signal,
  );
  if (typeof text !== 'string') {
    throw new AdminHttpContractError('$.body', 'JSON reader returned binary bytes');
  }
  return parseJsonValue(text);
}

export interface AdminBlobResponse {
  readonly blob: Blob;
  readonly filename: AdminAttachmentFilename;
  readonly contentType: string;
}

function assertRouteCoordinates(
  route: AdminTransportRoute,
  endpoint: string,
  method: string,
): void {
  assertCanonicalAdminRequestTarget(endpoint);
  if (route.method !== 'ALL' && method !== route.method) {
    throw new AdminHttpContractError(
      '$.route.method',
      `request method ${method} does not match ${route.id}`,
    );
  }
  if (!endpointMatchesRoute(endpoint, route.path)) {
    throw new AdminHttpContractError(
      '$.route.path',
      `request endpoint ${endpoint} does not match ${route.id}`,
    );
  }
}

function assertResponseRequestId(
  response: Response,
  logicalRequestId: string,
  envelopeRequestId?: string,
): void {
  const responseRequestId = decodeAdminRequestId(response.headers.get('x-request-id'));
  if (responseRequestId !== logicalRequestId) {
    throw new AdminHttpContractError(
      '$.headers.x-request-id',
      'response request identifier does not match the logical request',
    );
  }
  if (envelopeRequestId !== undefined && envelopeRequestId !== logicalRequestId) {
    throw new AdminHttpContractError(
      '$.meta.requestId',
      'envelope request identifier does not match the logical request',
    );
  }
}

/**
 * The sole raw-fetch authority for the admin panel. JSON envelopes and binary
 * downloads share authentication, CSRF, request identity, retry, and error
 * semantics; only their success decoders differ.
 */
async function executeAdminTransport<TResult>(
  route: AdminTransportRoute,
  encoded: {
    readonly endpoint: string;
    readonly method: string;
    readonly headers: Readonly<Record<string, string>>;
    readonly body?: string;
    readonly signal?: AbortSignal;
  },
  accept: string,
  consumeSuccess: (
    response: Response,
    logicalRequestId: string,
    signal: AbortSignal,
  ) => Promise<TResult>,
): Promise<TResult> {
  const { endpoint, method } = encoded;
  assertRouteCoordinates(route, endpoint, method);
  const deadline = new AbortController();
  const deadlineAt = Date.now() + route.policy.deadlineMs;
  const deadlineTimer = globalThis.setTimeout(
    () => deadline.abort(new DOMException('Request deadline exceeded', 'TimeoutError')),
    route.policy.deadlineMs,
  );
  const abortFromCaller = (): void => deadline.abort(encoded.signal?.reason);
  encoded.signal?.addEventListener('abort', abortFromCaller, { once: true });
  if (encoded.signal?.aborted === true) abortFromCaller();

  let lastError: AdminApiError | TypeError | null = null;
  let has401Retried = false;
  const logicalRequestId = generateRequestId();
  const retryPolicy = route.policy.retry;
  const maxRetries = retryPolicy.mode === 'safe-exponential' ? retryPolicy.maxRetries : 0;

  try {
    if (route.policy.authentication === 'bearer-session') {
      try {
        await awaitAbortable(tokenLifecycle.waitForReady(), deadline.signal);
      } catch (error) {
        if (deadline.signal.aborted) throw error;
        if (getAccessToken() === null) {
          throw createApiError('Authentication required', 401);
        }
      }
      if (getAccessToken() === null) {
        throw createApiError('Authentication required', 401);
      }
    }

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const accessToken =
          route.policy.authentication === 'bearer-session' ? getAccessToken() : null;
        if (route.policy.authentication === 'bearer-session' && accessToken === null) {
          throw createApiError('Authentication required', 401);
        }
        const headers: Record<string, string> = {
          ...encoded.headers,
          Accept: accept,
          'X-Request-ID': logicalRequestId,
          ...(accessToken === null ? {} : getAuthHeader(accessToken)),
        };
        if (encoded.body !== undefined) {
          headers['Content-Type'] = route.policy.mediaType ?? 'application/json';
        }

        const response = await fetch(`${ADMIN_API_URL}${endpoint}`, {
          method,
          ...(encoded.body === undefined ? {} : { body: encoded.body }),
          credentials: CSRF_SECURITY_POSTURE.adminApiCredentialsMode,
          headers,
          redirect: 'error',
          signal: deadline.signal,
        });

        if (response.ok) {
          try {
            if (!route.policy.successStatusCodes.includes(response.status)) {
              throw new AdminHttpContractError(
                '$.status',
                `success status ${response.status} is outside ${route.id}`,
              );
            }
            if (route.policy.successMediaType === 'application/json') {
              assertJsonResponseMediaType(response);
            }
          } catch (error) {
            await cancelResponseBody(response);
            throw error;
          }
          try {
            return await consumeSuccess(response, logicalRequestId, deadline.signal);
          } catch (error) {
            await cancelResponseBody(response);
            throw error;
          }
        }
        try {
          assertJsonResponseMediaType(response);
        } catch (error) {
          await cancelResponseBody(response);
          throw error;
        }
        const rawErrorBody = await readBoundedJsonResponse(response, deadline.signal);
        const errorEnvelope = decodeAdminHttpErrorEnvelopeV1(rawErrorBody);
        assertResponseRequestId(response, logicalRequestId, errorEnvelope.error.requestId);
        if (errorEnvelope.error.status !== response.status) {
          throw new AdminHttpContractError(
            '$.error.status',
            `envelope status ${errorEnvelope.error.status} does not match HTTP ${response.status}`,
          );
        }

        const errorBody = errorEnvelope.error;

        if (
          response.status === 401 &&
          !has401Retried &&
          route.policy.authentication === 'bearer-session'
        ) {
          has401Retried = true;
          if (retryPolicy.mode !== 'safe-exponential') {
            let refreshed = false;
            try {
              refreshed = await awaitAbortable(silentRefresh(), deadline.signal);
            } catch (error) {
              if (deadline.signal.aborted) throw error;
              refreshed = false;
            }
            if (!refreshed) clearSession();
            throw createApiError(
              'Mutation received 401 and was not replayed automatically',
              401,
              'UNSAFE_AUTH_REPLAY_BLOCKED',
              undefined,
              errorBody.requestId,
            );
          }
          try {
            if (await awaitAbortable(silentRefresh(), deadline.signal)) {
              attempt--;
              continue;
            }
          } catch (error) {
            if (deadline.signal.aborted) throw error;
            // The common session authority handles the terminal state below.
          }
          clearSession();
          throw createApiError('Session expired', 401, undefined, undefined, errorBody.requestId);
        }

        const error = createApiError(
          errorBody.message,
          response.status,
          errorBody.code,
          errorBody.details,
          errorBody.requestId,
        );
        lastError = error;
        if (
          retryPolicy.mode !== 'safe-exponential' ||
          !RETRYABLE_STATUS_CODES.has(response.status) ||
          attempt >= maxRetries
        ) {
          throw error;
        }
        await waitForRetry(
          Math.min(retryPolicy.baseDelayMs * Math.pow(2, attempt), retryPolicy.maxDelayMs),
          deadline.signal,
          deadlineAt,
        );
      } catch (error) {
        if (!(error instanceof TypeError)) throw error;
        lastError = error;
        if (retryPolicy.mode !== 'safe-exponential' || attempt >= maxRetries) {
          throw error;
        }
        await waitForRetry(
          Math.min(retryPolicy.baseDelayMs * Math.pow(2, attempt), retryPolicy.maxDelayMs),
          deadline.signal,
          deadlineAt,
        );
      }
    }
  } finally {
    globalThis.clearTimeout(deadlineTimer);
    encoded.signal?.removeEventListener('abort', abortFromCaller);
  }

  throw lastError ?? createApiError('Request failed after retries');
}

export async function apiFetch<
  TContract extends AdminResponseContract<unknown, unknown>,
  TMethod extends AdminHttpMethod,
  TPath extends `/${string}` | '/',
  TRequest extends AdminRouteRequestContract,
>(
  route: AdminRouteDefinition<TContract, TMethod, TPath, TRequest>,
  ...requestArguments: AdminRouteRequestArguments<TRequest>
): Promise<AdminWireResponseOf<TContract>> {
  const encoded = route.encode(requestArguments[0]);
  return executeAdminTransport(
    route,
    encoded,
    'application/json',
    async (response, logicalRequestId, signal) => {
      if (route.policy.successMediaType === null) {
        assertResponseRequestId(response, logicalRequestId);
        if (response.headers.has('content-type')) {
          throw new AdminHttpContractError(
            '$.headers.content-type',
            'no-content response must not declare a representation media type',
          );
        }
        await readBoundedResponseBody(response, 0, 'binary', signal);
        return route.decode(null);
      }
      const envelope = decodeAdminHttpEnvelopeV1(await readBoundedJsonResponse(response, signal));
      assertResponseRequestId(response, logicalRequestId, envelope.requestId);
      if (route.contract.kind === 'page') {
        if (envelope.pagination === undefined) {
          throw new AdminHttpContractError(
            '$.meta.pagination',
            'root page contract requires pagination metadata',
          );
        }
        if (!Array.isArray(envelope.data)) {
          throw new AdminHttpContractError('$.data', 'paginated response data must be an array');
        }
        return route.decode(
          createStandardPaginatedResult(
            envelope.data,
            envelope.pagination.total,
            envelope.pagination.page,
            envelope.pagination.limit,
          ),
        );
      }
      if (envelope.pagination !== undefined) {
        throw new AdminHttpContractError(
          '$.meta.pagination',
          'non-page route cannot carry pagination metadata',
        );
      }
      return route.decode(envelope.data);
    },
  );
}

export async function apiFetchBlob<
  TProfile extends AdminBinaryResponseProfile,
  TMethod extends AdminHttpMethod,
  TPath extends `/${string}` | '/',
  TRequest extends AdminRouteRequestContract,
>(
  route: AdminBinaryRouteDefinition<TProfile, TMethod, TPath, TRequest>,
  ...requestArguments: AdminRouteRequestArguments<TRequest>
): Promise<AdminBlobResponse> {
  const encoded = route.encode(requestArguments[0]);
  return executeAdminTransport(
    route,
    encoded,
    'application/octet-stream',
    async (response, logicalRequestId, signal) => {
      assertResponseRequestId(response, logicalRequestId);
      if (!route.profile.statusCodes.includes(response.status)) {
        throw new AdminHttpContractError(
          '$.status',
          `binary response status ${response.status} is outside ${route.id}`,
        );
      }
      const contentType = response.headers.get('content-type')?.toLowerCase();
      if (
        contentType === undefined ||
        !route.profile.mediaTypes.some((allowed) => allowed === contentType)
      ) {
        throw new AdminHttpContractError(
          '$.headers.content-type',
          `binary response media type ${contentType ?? '<missing>'} is outside ${route.id}`,
        );
      }
      const disposition = response.headers.get('content-disposition') ?? '';
      const filename = decodeAdminAttachmentDisposition(disposition);
      const bytes = await readBoundedResponseBody(
        response,
        route.profile.maxBytes,
        'binary',
        signal,
      );
      if (!(bytes instanceof Uint8Array)) {
        throw new AdminHttpContractError('$.body', 'binary reader returned text');
      }
      return {
        blob: new Blob([bytes.slice().buffer], { type: contentType }),
        filename,
        contentType,
      };
    },
  );
}
