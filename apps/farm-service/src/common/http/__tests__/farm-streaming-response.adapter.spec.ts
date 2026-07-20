import { EventEmitter } from 'node:events';
import { Readable, Writable } from 'node:stream';

import type {
  BoundedHttpStreamPolicy,
  HttpResponseStreamSource,
} from '@aquaculture/backend-common/http';
import { GatewayTimeoutException } from '@nestjs/common';

import { FarmStreamingResponseAdapter } from '../farm-streaming-response.adapter';

class TestRequest extends EventEmitter {
  aborted = false;

  abortRequest(): void {
    this.aborted = true;
    this.emit('aborted');
  }
}

class TestDestination extends Writable {
  headersSent = false;
  statusCode = 200;
  readonly responseHeaders = new Map<string, string>();
  readonly chunks: Buffer[] = [];

  setHeader(name: string, value: string): void {
    this.responseHeaders.set(name.toLowerCase(), value);
  }

  flushHeaders(): void {
    this.headersSent = true;
  }

  override _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.headersSent = true;
    this.chunks.push(Buffer.from(chunk));
    callback();
  }
}

const POLICY: BoundedHttpStreamPolicy = {
  maxBodyBytes: 1024,
  maxHeaderBytes: 1024,
  timeoutMs: 5_000,
  allowedContentTypes: ['application/octet-stream'],
  forwardedResponseHeaders: ['Content-Type', 'Content-Length', 'ETag'],
};

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error('aborted');
}

function source(body: Readable, headers?: HeadersInit): HttpResponseStreamSource {
  return {
    status: 200,
    headers: new Headers(
      headers ?? {
        'content-type': 'application/octet-stream',
      },
    ),
    body,
  };
}

describe('FarmStreamingResponseAdapter', () => {
  const adapter = new FarmStreamingResponseAdapter();

  afterEach(() => {
    jest.useRealTimers();
  });

  it('passes an explicit browser-linked signal and identity encoding to the source factory', async () => {
    const openSource = jest.fn(async ({ signal, requestHeaders }) => {
      expect(signal).toBeInstanceOf(AbortSignal);
      expect(requestHeaders).toEqual({ 'Accept-Encoding': 'identity' });
      expect(Object.isFrozen(requestHeaders)).toBe(true);
      return source(Readable.from([Buffer.from('artifact')]), {
        'content-type': 'application/octet-stream',
        'content-length': '8',
        etag: 'sha256:test',
      });
    });
    const destination = new TestDestination();

    const result = await adapter.stream(new TestRequest(), destination, {
      policy: POLICY,
      openSource,
    });

    expect(openSource).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ outcome: 'complete', bytesTransferred: 8 });
    expect(Buffer.concat(destination.chunks)).toEqual(Buffer.from('artifact'));
    expect(destination.responseHeaders.get('etag')).toBe('sha256:test');
  });

  it('propagates an aborted gateway request into a source that is still opening', async () => {
    let providerSignal: AbortSignal | undefined;
    const request = new TestRequest();
    const destination = new TestDestination();
    const pending = adapter.stream(request, destination, {
      policy: POLICY,
      openSource: ({ signal }) =>
        new Promise<HttpResponseStreamSource>((_resolve, reject) => {
          providerSignal = signal;
          signal.addEventListener('abort', () => reject(abortReason(signal)), { once: true });
        }),
    });
    await Promise.resolve();

    request.abortRequest();
    const result = await pending;

    expect(providerSignal?.aborted).toBe(true);
    expect(result).toMatchObject({
      outcome: 'terminated',
      bytesTransferred: 0,
      error: { code: 'REQUEST_ABORTED' },
    });
    expect(destination.headersSent).toBe(false);
  });

  it('destroys both provider stream and partial destination on the N+1 byte', async () => {
    const providerBody = Readable.from([Buffer.from('1234'), Buffer.from('5')]);
    const destination = new TestDestination();

    const result = await adapter.stream(new TestRequest(), destination, {
      policy: { ...POLICY, maxBodyBytes: 4 },
      openSource: async () => source(providerBody),
    });

    expect(result).toMatchObject({
      outcome: 'terminated',
      bytesTransferred: 4,
      error: { code: 'BODY_TOO_LARGE' },
    });
    expect(providerBody.destroyed).toBe(true);
    expect(destination.destroyed).toBe(true);
    expect(Buffer.concat(destination.chunks)).toEqual(Buffer.from('1234'));
  });

  it('keeps a provider-open timeout available for the shared JSON error filter', async () => {
    jest.useFakeTimers();
    const destination = new TestDestination();
    const pending = adapter.stream(new TestRequest(), destination, {
      policy: { ...POLICY, timeoutMs: 25 },
      openSource: ({ signal }) =>
        new Promise<HttpResponseStreamSource>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(abortReason(signal)), { once: true });
        }),
    });
    await Promise.resolve();

    jest.advanceTimersByTime(25);

    await expect(pending).rejects.toBeInstanceOf(GatewayTimeoutException);
    expect(destination.headersSent).toBe(false);
  });

  it('rejects provider metadata before flushing and destroys the unopened body stream', async () => {
    const providerBody = Readable.from([Buffer.from('x')]);
    const destination = new TestDestination();

    await expect(
      adapter.stream(new TestRequest(), destination, {
        policy: POLICY,
        openSource: async () =>
          source(providerBody, {
            'content-type': 'text/html',
          }),
      }),
    ).rejects.toMatchObject({ code: 'CONTENT_TYPE_NOT_ALLOWED' });

    expect(destination.headersSent).toBe(false);
    expect(providerBody.destroyed).toBe(true);
  });
});
