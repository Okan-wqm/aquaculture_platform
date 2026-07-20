import type { EventEmitter } from 'node:events';
import { Readable, Transform } from 'node:stream';
import type { TransformCallback, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';

import { clearManagedTimer, createManagedTimeout } from '../utils/lifecycle-timer';

const HEADER_NAME_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const CONTENT_LENGTH_PATTERN = /^(0|[1-9][0-9]*)$/;
const MEDIA_TYPE_PATTERN = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/;

const NEVER_FORWARDED_RESPONSE_HEADERS = new Set([
  'authorization',
  'connection',
  'cookie',
  'keep-alive',
  'location',
  'proxy-authenticate',
  'proxy-authorization',
  'set-cookie',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'www-authenticate',
  'x-service-identity',
  'x-service-signature',
  'x-tenant-id',
  'x-verified-user-assertion',
]);

export type BoundedHttpStreamErrorCode =
  | 'BODY_TOO_LARGE'
  | 'CONTENT_LENGTH_MISMATCH'
  | 'CONTENT_TYPE_NOT_ALLOWED'
  | 'DOWNSTREAM_CLOSED'
  | 'HEADERS_TOO_LARGE'
  | 'INVALID_CONTENT_LENGTH'
  | 'INVALID_POLICY'
  | 'INVALID_STATUS'
  | 'MANUAL_ABORT'
  | 'MISSING_RESPONSE_BODY'
  | 'REQUEST_ABORTED'
  | 'STREAM_TIMEOUT'
  | 'UNSUPPORTED_CONTENT_ENCODING';

export class BoundedHttpStreamError extends Error {
  constructor(
    public readonly code: BoundedHttpStreamErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'BoundedHttpStreamError';
  }
}

/**
 * Every streaming call site must choose its own limits. There are deliberately
 * no platform-wide body or timeout defaults: a tile, a JSON error and a stored
 * analysis artifact have different safe bounds.
 */
export interface BoundedHttpStreamPolicy {
  readonly maxBodyBytes: number;
  readonly maxHeaderBytes: number;
  readonly timeoutMs: number;
  readonly allowedContentTypes: readonly string[];
  readonly forwardedResponseHeaders: readonly string[];
}

export type HttpStreamLifetimeRequest = Pick<EventEmitter, 'once' | 'removeListener'> & {
  readonly aborted: boolean;
};

export type HttpStreamLifetimeResponse = Pick<EventEmitter, 'once' | 'removeListener'> & {
  readonly writableFinished: boolean;
};

export type HttpStreamDestination = Writable & {
  readonly headersSent: boolean;
  readonly writableFinished: boolean;
  statusCode: number;
  setHeader(name: string, value: string): void;
  flushHeaders?(): void;
};

export type HttpStreamBody = Readable | ReadableStream<Uint8Array>;

export interface HttpResponseStreamSource {
  readonly status: number;
  readonly headers: Headers;
  readonly body: HttpStreamBody | null;
}

export type BoundedHttpStreamResult =
  | {
      readonly outcome: 'complete';
      readonly bytesTransferred: number;
    }
  | {
      readonly outcome: 'terminated';
      readonly bytesTransferred: number;
      readonly error: Error;
    };

export interface HttpStreamLifetime {
  readonly signal: AbortSignal;
  readonly reason: BoundedHttpStreamError | undefined;
  abort(reason?: BoundedHttpStreamError): void;
  dispose(): void;
}

interface PreparedHttpResponse {
  readonly statusCode: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly declaredLength: number | undefined;
}

class CountingBodyTransform extends Transform {
  private transferred = 0;

  constructor(
    private readonly maxBodyBytes: number,
    private readonly declaredLength: number | undefined,
  ) {
    super();
  }

  get bytesTransferred(): number {
    return this.transferred;
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    const nextTotal = this.transferred + chunk.byteLength;
    if (nextTotal > this.maxBodyBytes) {
      callback(
        new BoundedHttpStreamError(
          'BODY_TOO_LARGE',
          `Upstream response exceeded the ${this.maxBodyBytes}-byte limit`,
        ),
      );
      return;
    }

    this.transferred = nextTotal;
    callback(null, chunk);
  }

  override _flush(callback: TransformCallback): void {
    if (this.declaredLength !== undefined && this.transferred !== this.declaredLength) {
      callback(
        new BoundedHttpStreamError(
          'CONTENT_LENGTH_MISMATCH',
          `Upstream declared ${this.declaredLength} bytes but streamed ${this.transferred}`,
        ),
      );
      return;
    }
    callback();
  }
}

export function assertBoundedHttpStreamPolicy(policy: BoundedHttpStreamPolicy): void {
  assertPositiveSafeInteger('maxBodyBytes', policy.maxBodyBytes);
  assertPositiveSafeInteger('maxHeaderBytes', policy.maxHeaderBytes);
  assertPositiveSafeInteger('timeoutMs', policy.timeoutMs);

  if (policy.allowedContentTypes.length === 0) {
    throw invalidPolicy('allowedContentTypes must contain at least one media type');
  }
  for (const contentType of policy.allowedContentTypes) {
    const normalized = normalizeContentType(contentType);
    if (!normalized || !MEDIA_TYPE_PATTERN.test(normalized) || contentType.includes(';')) {
      throw invalidPolicy(`allowedContentTypes contains an invalid media type: ${contentType}`);
    }
  }

  if (policy.forwardedResponseHeaders.length === 0) {
    throw invalidPolicy('forwardedResponseHeaders must contain at least Content-Type');
  }

  const normalizedForwardedHeaders = policy.forwardedResponseHeaders.map(normalizeHeaderName);
  if (!normalizedForwardedHeaders.includes('content-type')) {
    throw invalidPolicy('forwardedResponseHeaders must include Content-Type');
  }
  for (const header of normalizedForwardedHeaders) {
    if (!HEADER_NAME_PATTERN.test(header)) {
      throw invalidPolicy(`forwardedResponseHeaders contains an invalid header name: ${header}`);
    }
    if (isNeverForwardedResponseHeader(header)) {
      throw invalidPolicy(`forwardedResponseHeaders contains forbidden header: ${header}`);
    }
  }
}

/**
 * Binds one downstream HTTP response to one cancellation signal. `request.close`
 * is intentionally not observed: on modern Node it can mean the request body
 * completed, not that the browser disconnected.
 */
export function createHttpStreamLifetime(
  request: HttpStreamLifetimeRequest,
  response: HttpStreamLifetimeResponse,
  timeoutMs: number,
): HttpStreamLifetime {
  assertPositiveSafeInteger('timeoutMs', timeoutMs);

  const controller = new AbortController();
  let reason: BoundedHttpStreamError | undefined;
  let disposed = false;

  const abortWith = (nextReason: BoundedHttpStreamError): void => {
    if (controller.signal.aborted) return;
    reason = nextReason;
    controller.abort(nextReason);
  };

  const onRequestAborted = (): void => {
    abortWith(new BoundedHttpStreamError('REQUEST_ABORTED', 'Downstream request was aborted'));
  };
  const onResponseClose = (): void => {
    if (!response.writableFinished) {
      abortWith(
        new BoundedHttpStreamError(
          'DOWNSTREAM_CLOSED',
          'Downstream response closed before streaming completed',
        ),
      );
    }
  };

  request.once('aborted', onRequestAborted);
  response.once('close', onResponseClose);
  const timeout = createManagedTimeout(
    () =>
      abortWith(
        new BoundedHttpStreamError(
          'STREAM_TIMEOUT',
          `HTTP stream exceeded its ${timeoutMs}ms deadline`,
        ),
      ),
    timeoutMs,
  );

  if (request.aborted) {
    onRequestAborted();
  }

  return {
    signal: controller.signal,
    get reason(): BoundedHttpStreamError | undefined {
      return reason;
    },
    abort(nextReason = new BoundedHttpStreamError('MANUAL_ABORT', 'HTTP stream was aborted')) {
      abortWith(nextReason);
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      clearManagedTimer(timeout);
      request.removeListener('aborted', onRequestAborted);
      response.removeListener('close', onResponseClose);
    },
  };
}

/**
 * Streams one already-open upstream response into a Node writable. Metadata is
 * validated before headers are flushed. Once headers are flushed, every stream
 * failure terminates the partial destination and is returned as data so a Nest
 * exception filter cannot attempt to append a second JSON response.
 */
export async function streamBoundedHttpResponse(
  source: HttpResponseStreamSource,
  destination: HttpStreamDestination,
  policy: BoundedHttpStreamPolicy,
  signal: AbortSignal,
): Promise<BoundedHttpStreamResult> {
  assertBoundedHttpStreamPolicy(policy);

  if (signal.aborted) {
    await cancelSourceBody(source.body);
    return terminatedResult(0, signal.reason);
  }

  let prepared: PreparedHttpResponse;
  try {
    prepared = inspectResponse(source, policy);
    if (!source.body && prepared.declaredLength !== undefined && prepared.declaredLength > 0) {
      throw new BoundedHttpStreamError(
        'MISSING_RESPONSE_BODY',
        'Upstream declared a non-empty response without providing a body stream',
      );
    }
  } catch (error) {
    await cancelSourceBody(source.body);
    throw error;
  }

  const counter = new CountingBodyTransform(policy.maxBodyBytes, prepared.declaredLength);
  let readable: Readable | undefined;

  try {
    // The downstream can disappear while upstream metadata is being inspected.
    // Re-check before taking stream ownership or committing any headers.
    if (signal.aborted) {
      await cancelSourceBody(source.body);
      return terminatedResult(0, signal.reason);
    }

    readable = source.body ? toNodeReadable(source.body) : Readable.from([]);
    if (signal.aborted) {
      readable.destroy();
      return terminatedResult(0, signal.reason);
    }

    destination.statusCode = prepared.statusCode;
    for (const [name, value] of Object.entries(prepared.headers)) {
      destination.setHeader(name, value);
    }

    // Closing during header mutation must cancel the upstream before a flush.
    if (signal.aborted) {
      readable.destroy();
      return terminatedResult(0, signal.reason);
    }

    destination.flushHeaders?.();
    if (signal.aborted) {
      throw signal.reason;
    }

    await pipeline(readable, counter, destination, { signal });
    return {
      outcome: 'complete',
      bytesTransferred: counter.bytesTransferred,
    };
  } catch (error) {
    // Header mutation can throw before pipeline owns the source. Always release
    // that source here; the gateway/farm adapters cannot see it themselves.
    if (readable && !readable.destroyed) {
      readable.destroy();
    } else if (!readable) {
      await cancelSourceBody(source.body);
    }

    if (destination.headersSent) {
      if (!destination.destroyed) destination.destroy();
      return terminatedResult(counter.bytesTransferred, error);
    }
    if (signal.aborted) {
      return terminatedResult(counter.bytesTransferred, signal.reason ?? error);
    }

    // No bytes or headers escaped, so the caller can still emit its canonical
    // JSON error envelope.
    throw error;
  }
}

export function normalizeHttpStreamError(error: unknown): Error {
  if (error instanceof Error) return error;
  if (typeof error === 'string') return new Error(error);
  return new Error('HTTP stream failed with a non-Error rejection');
}

function inspectResponse(
  source: HttpResponseStreamSource,
  policy: BoundedHttpStreamPolicy,
): PreparedHttpResponse {
  if (!Number.isInteger(source.status) || source.status < 100 || source.status > 599) {
    throw new BoundedHttpStreamError(
      'INVALID_STATUS',
      `Upstream returned an invalid HTTP status: ${source.status}`,
    );
  }

  assertHeaderBytes(source.headers, policy.maxHeaderBytes);
  const declaredLength = parseContentLength(source.headers.get('content-length'));
  if (declaredLength !== undefined && declaredLength > policy.maxBodyBytes) {
    throw new BoundedHttpStreamError(
      'BODY_TOO_LARGE',
      `Upstream declared ${declaredLength} bytes, above the ${policy.maxBodyBytes}-byte limit`,
    );
  }

  const contentType = normalizeContentType(source.headers.get('content-type'));
  const allowedContentTypes = new Set(policy.allowedContentTypes.map(normalizeContentType));
  if (!contentType || !allowedContentTypes.has(contentType)) {
    throw new BoundedHttpStreamError(
      'CONTENT_TYPE_NOT_ALLOWED',
      `Upstream content type is not allowed: ${contentType || '<missing>'}`,
    );
  }

  const contentEncoding = source.headers.get('content-encoding');
  if (contentEncoding && contentEncoding.trim().toLowerCase() !== 'identity') {
    throw new BoundedHttpStreamError(
      'UNSUPPORTED_CONTENT_ENCODING',
      `Upstream ignored identity encoding: ${contentEncoding}`,
    );
  }

  const forwarded = new Set(policy.forwardedResponseHeaders.map(normalizeHeaderName));
  const headers: Record<string, string> = {};
  source.headers.forEach((value, name) => {
    const normalizedName = normalizeHeaderName(name);
    if (forwarded.has(normalizedName) && !isNeverForwardedResponseHeader(normalizedName)) {
      headers[normalizedName] = value;
    }
  });

  return {
    statusCode: source.status,
    headers,
    declaredLength,
  };
}

function assertHeaderBytes(headers: Headers, maxHeaderBytes: number): void {
  let byteLength = 2;
  headers.forEach((value, name) => {
    byteLength += Buffer.byteLength(name, 'utf8') + 2;
    byteLength += Buffer.byteLength(value, 'utf8') + 2;
  });
  if (byteLength > maxHeaderBytes) {
    throw new BoundedHttpStreamError(
      'HEADERS_TOO_LARGE',
      `Upstream response headers used ${byteLength} bytes, above the ${maxHeaderBytes}-byte limit`,
    );
  }
}

function parseContentLength(value: string | null): number | undefined {
  if (value === null) return undefined;
  if (!CONTENT_LENGTH_PATTERN.test(value)) {
    throw new BoundedHttpStreamError(
      'INVALID_CONTENT_LENGTH',
      `Upstream returned an invalid Content-Length: ${value}`,
    );
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new BoundedHttpStreamError(
      'INVALID_CONTENT_LENGTH',
      'Upstream Content-Length exceeds the safe integer range',
    );
  }
  return parsed;
}

function toNodeReadable(body: HttpStreamBody): Readable {
  return body instanceof Readable ? body : Readable.fromWeb(body as NodeReadableStream<Uint8Array>);
}

async function cancelSourceBody(body: HttpStreamBody | null): Promise<void> {
  if (!body) return;
  if (body instanceof Readable) {
    if (!body.destroyed) body.destroy();
    return;
  }
  try {
    await body.cancel();
  } catch {
    // A locked/already-cancelled Web stream has already transferred ownership.
  }
}

function terminatedResult(bytesTransferred: number, error: unknown): BoundedHttpStreamResult {
  return {
    outcome: 'terminated',
    bytesTransferred,
    error: normalizeHttpStreamError(error),
  };
}

function normalizeHeaderName(name: string): string {
  return name.trim().toLowerCase();
}

function normalizeContentType(value: string | null): string {
  return value?.split(';', 1)[0]?.trim().toLowerCase() ?? '';
}

function isNeverForwardedResponseHeader(name: string): boolean {
  return NEVER_FORWARDED_RESPONSE_HEADERS.has(name) || name.startsWith('x-service-');
}

function assertPositiveSafeInteger(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw invalidPolicy(`${name} must be a positive safe integer`);
  }
}

function invalidPolicy(message: string): BoundedHttpStreamError {
  return new BoundedHttpStreamError('INVALID_POLICY', message);
}
