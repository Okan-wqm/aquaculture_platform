// HTTP core shared by every endpoint function.
//
// WHY: auth header construction, JSON parsing and error normalisation must exist
// exactly once — a page that forgot the bearer header or mis-read an ApiError
// body would be a silent security/UX bug. The transport is injectable so tests
// exercise the real header/error logic against a fake fetch.
// WHAT: buildHeaders (Authorization only for non-public paths), requestJson<T>
// which resolves to the contract type or throws ApiClientError.
import { AUTH_HEADER, AUTH_SCHEME, PUBLIC_PATHS, type ApiError } from '../../../shared/api-contract.ts';
import { ApiClientError } from './errors.ts';
import { getToken } from './token-store.ts';

export interface Transport {
  readonly fetchImpl: typeof fetch;
  readonly tokenProvider: () => string | null;
}

export interface RequestOptions {
  readonly method?: 'GET' | 'POST' | undefined;
  readonly body?: unknown;
  readonly signal?: AbortSignal | undefined;
}

/** Resolved at call time so tests can stub `globalThis.fetch` after import. */
export const defaultTransport: Transport = {
  fetchImpl: (input, init) => fetch(input, init),
  tokenProvider: getToken,
};

export function isPublicPath(path: string): boolean {
  const pathname = path.split('?')[0] ?? path;
  return PUBLIC_PATHS.some((publicPath) => publicPath === pathname);
}

export function buildHeaders(token: string | null, options: { readonly hasBody: boolean; readonly accept?: string | undefined }): Headers {
  const headers = new Headers();
  headers.set('accept', options.accept ?? 'application/json');
  if (options.hasBody) {
    headers.set('content-type', 'application/json');
  }
  if (token !== null) {
    headers.set(AUTH_HEADER, `${AUTH_SCHEME} ${token}`);
  }
  return headers;
}

function isApiErrorBody(value: unknown): value is ApiError {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as { readonly error?: unknown; readonly detail?: unknown };
  return typeof candidate.error === 'string' && (candidate.detail === undefined || typeof candidate.detail === 'string');
}

export async function parseErrorBody(response: Response): Promise<ApiError> {
  const text = await response.text();
  if (text.trim() !== '') {
    try {
      const parsed: unknown = JSON.parse(text);
      if (isApiErrorBody(parsed)) {
        return parsed;
      }
    } catch {
      // Non-JSON error body: fall through and surface the raw text as detail.
    }
    return { error: `HTTP ${response.status}`, detail: text.slice(0, 500) };
  }
  return { error: `HTTP ${response.status}` };
}

export async function requestJson<T>(path: string, options: RequestOptions = {}, transport: Transport = defaultTransport): Promise<T> {
  const token = isPublicPath(path) ? null : transport.tokenProvider();
  if (!isPublicPath(path) && token === null) {
    // Fail before the network: without a token every protected route is a 401,
    // and the guard needs the same error class to route the operator to login.
    throw new ApiClientError(401, { error: 'missing_token', detail: 'Operator token is missing. Sign in to continue.' }, path);
  }
  const hasBody = options.body !== undefined;
  const init: RequestInit = {
    method: options.method ?? 'GET',
    headers: buildHeaders(token, { hasBody }),
    credentials: 'omit',
    cache: 'no-store',
  };
  if (hasBody) {
    init.body = JSON.stringify(options.body);
  }
  if (options.signal !== undefined) {
    init.signal = options.signal;
  }
  const response = await transport.fetchImpl(path, init);
  if (!response.ok) {
    throw new ApiClientError(response.status, await parseErrorBody(response), path);
  }
  const data: unknown = await response.json();
  return data as T;
}

/**
 * POSTs raw bytes (a document upload) and parses the JSON answer.
 *
 * Separate from requestJson because the body is not JSON: the browser streams
 * the File itself, so the bytes the server hashes are the bytes the operator
 * chose, with no encoding step in between that could alter them.
 */
export async function requestBytes<T>(
  path: string,
  body: Blob,
  options: { readonly headers?: Headers | undefined; readonly signal?: AbortSignal | undefined } = {},
  transport: Transport = defaultTransport,
): Promise<T> {
  const token = transport.tokenProvider();
  if (token === null) {
    throw new ApiClientError(401, { error: 'missing_token', detail: 'Operator token is missing. Sign in to continue.' }, path);
  }
  const headers = new Headers(options.headers);
  headers.set('accept', 'application/json');
  headers.set('content-type', 'application/octet-stream');
  headers.set(AUTH_HEADER, `${AUTH_SCHEME} ${token}`);
  const init: RequestInit = { method: 'POST', headers, body, credentials: 'omit', cache: 'no-store' };
  if (options.signal !== undefined) {
    init.signal = options.signal;
  }
  const response = await transport.fetchImpl(path, init);
  if (!response.ok) {
    throw new ApiClientError(response.status, await parseErrorBody(response), path);
  }
  const data: unknown = await response.json();
  return data as T;
}
