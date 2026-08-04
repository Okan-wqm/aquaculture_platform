import { createAbortSignalTimeout } from '@aquaculture/backend-common/utils';

import { parseProviderRetryAfterMs } from './provider-http-headers';

export const MET_NORWAY_PROVIDER_CONFIG = Symbol('MET_NORWAY_PROVIDER_CONFIG');
export const MET_NORWAY_FETCH = Symbol('MET_NORWAY_FETCH');
export const MET_NORWAY_CLOCK = Symbol('MET_NORWAY_CLOCK');

export const MET_NORWAY_REQUEST_TIMEOUT_MS = 30_000;
export const MET_NORWAY_MAX_JSON_BYTES = 2 * 1024 * 1024;
const MET_NORWAY_MAX_RETRY_AFTER_MS = 6 * 60 * 60 * 1_000;
export const MET_NORWAY_ENV_KEYS = {
  applicationName: 'MET_NORWAY_APPLICATION_NAME',
  contact: 'MET_NORWAY_CONTACT',
  frostClientId: 'MET_NORWAY_FROST_CLIENT_ID',
} as const;

export interface MetNorwayProviderConfig {
  /**
   * Product identifier sent to MET Norway, for example
   * `AquaSaaS/1.0`. It must not be a generic HTTP-library name.
   */
  applicationName: string;
  /**
   * Operational contact sent in the User-Agent. MET Norway accepts an
   * email address or an HTTPS URL.
   */
  contact: string;
  /**
   * Frost public-data client ID. The composition root resolves this from
   * environment/config-service and never exposes it to a browser.
   */
  frostClientId?: string;
}

export interface MetNorwayFetch {
  (input: string | URL, init?: RequestInit): Promise<Response>;
}

export interface MetNorwayClock {
  now(): Date;
}

export enum MetNorwayProvider {
  LOCATIONFORECAST = 'LOCATIONFORECAST',
  FROST = 'FROST',
}

export enum MetNorwayProviderErrorCode {
  CONFIGURATION = 'CONFIGURATION',
  CLIENT_REQUEST = 'CLIENT_REQUEST',
  RATE_LIMITED = 'RATE_LIMITED',
  UPSTREAM = 'UPSTREAM',
  TIMEOUT = 'TIMEOUT',
  TRANSPORT = 'TRANSPORT',
  SCHEMA = 'SCHEMA',
  RESPONSE_TOO_LARGE = 'RESPONSE_TOO_LARGE',
  REDIRECT_BLOCKED = 'REDIRECT_BLOCKED',
}

export interface MetNorwayProviderErrorOptions {
  provider: MetNorwayProvider;
  code: MetNorwayProviderErrorCode;
  message: string;
  retryable: boolean;
  httpStatus?: number;
  retryAfterSeconds?: number;
  cause?: unknown;
}

export class MetNorwayProviderError extends Error {
  readonly provider: MetNorwayProvider;
  readonly code: MetNorwayProviderErrorCode;
  readonly retryable: boolean;
  readonly httpStatus?: number;
  readonly retryAfterSeconds?: number;
  readonly providerCause?: unknown;

  constructor(options: MetNorwayProviderErrorOptions) {
    super(options.message);
    this.name = 'MetNorwayProviderError';
    this.provider = options.provider;
    this.code = options.code;
    this.retryable = options.retryable;
    this.httpStatus = options.httpStatus;
    this.retryAfterSeconds = options.retryAfterSeconds;
    this.providerCause = options.cause;
  }
}

export interface MetNorwayJsonAvailable {
  status: 'AVAILABLE';
  payload: unknown;
}

export interface MetNorwayJsonNoCoverage {
  status: 'NO_COVERAGE';
}

export type MetNorwayJsonResult = MetNorwayJsonAvailable | MetNorwayJsonNoCoverage;

const CONTACT_EMAIL_PATTERN = /^(?:mailto:)?[^@\s]+@[^@\s]+\.[^@\s]+$/u;
const APPLICATION_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{2,79}$/u;
const PROHIBITED_APPLICATION_NAMES = new Set([
  'curl',
  'dalvik',
  'fhttp',
  'java',
  'node',
  'okhttp',
  'undici',
]);
const ALLOWED_JSON_CONTENT_TYPES = new Set([
  'application/json',
  'application/geo+json',
  'application/ld+json',
]);

const SYSTEM_CLOCK: MetNorwayClock = {
  now: (): Date => new Date(),
};

function validateContact(contact: string, provider: MetNorwayProvider): string {
  if (typeof contact !== 'string') {
    throw new MetNorwayProviderError({
      provider,
      code: MetNorwayProviderErrorCode.CONFIGURATION,
      message: 'MET Norway contact must be an email address or HTTPS URL',
      retryable: false,
    });
  }
  const normalized = contact.trim();
  if (CONTACT_EMAIL_PATTERN.test(normalized)) return normalized;

  let url: URL;
  try {
    url = new URL(normalized);
  } catch {
    throw new MetNorwayProviderError({
      provider,
      code: MetNorwayProviderErrorCode.CONFIGURATION,
      message: 'MET Norway contact must be an email address or HTTPS URL',
      retryable: false,
    });
  }

  if (url.protocol !== 'https:' || !url.hostname) {
    throw new MetNorwayProviderError({
      provider,
      code: MetNorwayProviderErrorCode.CONFIGURATION,
      message: 'MET Norway contact must be an email address or HTTPS URL',
      retryable: false,
    });
  }
  return normalized;
}

export function buildMetNorwayUserAgent(
  config: MetNorwayProviderConfig,
  provider: MetNorwayProvider,
): string {
  const applicationName =
    typeof config.applicationName === 'string' ? config.applicationName.trim() : '';
  if (
    !APPLICATION_NAME_PATTERN.test(applicationName) ||
    PROHIBITED_APPLICATION_NAMES.has(applicationName.toLowerCase())
  ) {
    throw new MetNorwayProviderError({
      provider,
      code: MetNorwayProviderErrorCode.CONFIGURATION,
      message: 'MET Norway applicationName is missing or invalid',
      retryable: false,
    });
  }
  return `${applicationName} ${validateContact(config.contact, provider)}`;
}

function parseRetryAfterSeconds(value: string | null, now: Date): number | undefined {
  const milliseconds = parseProviderRetryAfterMs(value, now, MET_NORWAY_MAX_RETRY_AFTER_MS);
  return milliseconds === undefined ? undefined : Math.ceil(milliseconds / 1_000);
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

export class MetNorwayHttpClient {
  private readonly fetchFn: MetNorwayFetch;
  private readonly clock: MetNorwayClock;

  constructor(fetchFn?: MetNorwayFetch, clock?: MetNorwayClock) {
    this.fetchFn = fetchFn ?? globalThis.fetch;
    this.clock = clock ?? SYSTEM_CLOCK;
  }

  async getJson(input: {
    provider: MetNorwayProvider;
    url: URL;
    allowedOrigin: string;
    allowedPath: string;
    headers: Readonly<Record<string, string>>;
  }): Promise<MetNorwayJsonResult> {
    this.assertFixedEndpoint(input);
    const timeout = createAbortSignalTimeout(MET_NORWAY_REQUEST_TIMEOUT_MS);

    try {
      const response = await this.fetchFn(input.url, {
        method: 'GET',
        headers: input.headers,
        redirect: 'manual',
        signal: timeout.signal,
      });
      if (response.status >= 300 && response.status < 400) {
        await cancelResponseBody(response);
        throw new MetNorwayProviderError({
          provider: input.provider,
          code: MetNorwayProviderErrorCode.REDIRECT_BLOCKED,
          message: `${input.provider} returned an unexpected redirect`,
          retryable: false,
          httpStatus: response.status,
        });
      }
      if (response.status === 404) {
        await cancelResponseBody(response);
        return { status: 'NO_COVERAGE' };
      }
      if (response.status === 401 || response.status === 403) {
        await cancelResponseBody(response);
        throw new MetNorwayProviderError({
          provider: input.provider,
          code: MetNorwayProviderErrorCode.CONFIGURATION,
          message: `${input.provider} rejected provider configuration`,
          retryable: false,
          httpStatus: response.status,
        });
      }
      if (response.status === 429) {
        await cancelResponseBody(response);
        throw new MetNorwayProviderError({
          provider: input.provider,
          code: MetNorwayProviderErrorCode.RATE_LIMITED,
          message: `${input.provider} rate limit exceeded`,
          retryable: true,
          httpStatus: response.status,
          retryAfterSeconds: parseRetryAfterSeconds(
            response.headers.get('retry-after'),
            this.clock.now(),
          ),
        });
      }
      if (response.status >= 500) {
        await cancelResponseBody(response);
        throw new MetNorwayProviderError({
          provider: input.provider,
          code: MetNorwayProviderErrorCode.UPSTREAM,
          message: `${input.provider} upstream service failed`,
          retryable: true,
          httpStatus: response.status,
        });
      }
      if (!response.ok) {
        await cancelResponseBody(response);
        throw new MetNorwayProviderError({
          provider: input.provider,
          code: MetNorwayProviderErrorCode.CLIENT_REQUEST,
          message: `${input.provider} rejected the request`,
          retryable: false,
          httpStatus: response.status,
        });
      }

      const body = await this.readBoundedJsonBody(response, input.provider, timeout.signal);
      let payload: unknown;
      try {
        payload = JSON.parse(body);
      } catch (error) {
        throw new MetNorwayProviderError({
          provider: input.provider,
          code: MetNorwayProviderErrorCode.SCHEMA,
          message: `${input.provider} returned malformed JSON`,
          retryable: false,
          cause: error,
        });
      }
      return { status: 'AVAILABLE', payload };
    } catch (error) {
      if (error instanceof MetNorwayProviderError) {
        throw error;
      }
      const didTimeout = timeout.signal.aborted || isAbortError(error);
      throw new MetNorwayProviderError({
        provider: input.provider,
        code: didTimeout
          ? MetNorwayProviderErrorCode.TIMEOUT
          : MetNorwayProviderErrorCode.TRANSPORT,
        message: didTimeout
          ? `${input.provider} request timed out`
          : `${input.provider} transport request failed`,
        retryable: true,
        cause: error,
      });
    } finally {
      timeout.clear();
    }
  }

  private assertFixedEndpoint(input: {
    provider: MetNorwayProvider;
    url: URL;
    allowedOrigin: string;
    allowedPath: string;
  }): void {
    if (
      input.url.protocol !== 'https:' ||
      input.url.origin !== input.allowedOrigin ||
      input.url.pathname !== input.allowedPath ||
      input.url.username ||
      input.url.password ||
      input.url.hash
    ) {
      throw new MetNorwayProviderError({
        provider: input.provider,
        code: MetNorwayProviderErrorCode.CONFIGURATION,
        message: `${input.provider} endpoint is not allowed`,
        retryable: false,
      });
    }
  }

  private async readBoundedJsonBody(
    response: Response,
    provider: MetNorwayProvider,
    signal: AbortSignal,
  ): Promise<string> {
    const contentType = response.headers.get('content-type')?.split(';', 1)[0]?.trim();
    if (!contentType || !ALLOWED_JSON_CONTENT_TYPES.has(contentType.toLowerCase())) {
      await cancelResponseBody(response);
      throw new MetNorwayProviderError({
        provider,
        code: MetNorwayProviderErrorCode.SCHEMA,
        message: `${provider} returned an unsupported content type`,
        retryable: false,
      });
    }

    const contentLength = response.headers.get('content-length');
    if (contentLength) {
      if (!/^\d+$/u.test(contentLength)) {
        await cancelResponseBody(response);
        throw new MetNorwayProviderError({
          provider,
          code: MetNorwayProviderErrorCode.SCHEMA,
          message: `${provider} returned an invalid Content-Length`,
          retryable: false,
        });
      }
      const parsedLength = Number(contentLength);
      if (
        !Number.isSafeInteger(parsedLength) ||
        parsedLength < 0 ||
        parsedLength > MET_NORWAY_MAX_JSON_BYTES
      ) {
        await cancelResponseBody(response);
        throw new MetNorwayProviderError({
          provider,
          code: MetNorwayProviderErrorCode.RESPONSE_TOO_LARGE,
          message: `${provider} response exceeded the JSON size limit`,
          retryable: false,
        });
      }
    }

    if (!response.body) {
      throw new MetNorwayProviderError({
        provider,
        code: MetNorwayProviderErrorCode.SCHEMA,
        message: `${provider} returned an empty response body`,
        retryable: false,
      });
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let byteLength = 0;
    let body = '';

    try {
      while (true) {
        const chunk = await readStreamChunk(reader, signal);
        if (chunk.done) break;
        byteLength += chunk.value.byteLength;
        if (byteLength > MET_NORWAY_MAX_JSON_BYTES) {
          await reader.cancel();
          throw new MetNorwayProviderError({
            provider,
            code: MetNorwayProviderErrorCode.RESPONSE_TOO_LARGE,
            message: `${provider} response exceeded the JSON size limit`,
            retryable: false,
          });
        }
        body += decoder.decode(chunk.value, { stream: true });
      }
      body += decoder.decode();
    } catch (error) {
      if (error instanceof MetNorwayProviderError) throw error;
      if (signal.aborted || isAbortError(error)) {
        await reader.cancel().catch(() => undefined);
        throw new MetNorwayProviderError({
          provider,
          code: MetNorwayProviderErrorCode.TIMEOUT,
          message: `${provider} response body timed out`,
          retryable: true,
          cause: error,
        });
      }
      throw new MetNorwayProviderError({
        provider,
        code: MetNorwayProviderErrorCode.SCHEMA,
        message: `${provider} returned invalid UTF-8 JSON`,
        retryable: false,
        cause: error,
      });
    } finally {
      reader.releaseLock();
    }

    return body;
  }
}

async function cancelResponseBody(response: Response): Promise<void> {
  if (response.body) {
    await response.body.cancel();
  }
}

async function readStreamChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  if (signal.aborted) {
    throw new DOMException('aborted', 'AbortError');
  }
  return new Promise<ReadableStreamReadResult<Uint8Array>>((resolve, reject) => {
    const onAbort = (): void => {
      reject(new DOMException('aborted', 'AbortError'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    reader.read().then(
      (result) => {
        signal.removeEventListener('abort', onAbort);
        resolve(result);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error instanceof Error ? error : new Error('MET Norway response stream failed'));
      },
    );
  });
}

export function metSchemaError(provider: MetNorwayProvider, path: string): MetNorwayProviderError {
  return new MetNorwayProviderError({
    provider,
    code: MetNorwayProviderErrorCode.SCHEMA,
    message: `${provider} response failed schema validation at ${path}`,
    retryable: false,
  });
}

export function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function normalizeUtcTimestamp(
  provider: MetNorwayProvider,
  value: unknown,
  path: string,
): string {
  if (typeof value !== 'string' || !/(?:Z|[+-]\d{2}:\d{2})$/u.test(value)) {
    throw metSchemaError(provider, path);
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw metSchemaError(provider, path);
  return date.toISOString();
}

export function requireFiniteNumber(
  provider: MetNorwayProvider,
  value: unknown,
  path: string,
): number {
  const parsed =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim().length > 0
        ? Number(value)
        : Number.NaN;
  if (!Number.isFinite(parsed)) throw metSchemaError(provider, path);
  return parsed;
}
