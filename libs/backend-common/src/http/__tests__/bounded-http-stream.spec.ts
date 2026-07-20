import { EventEmitter } from 'node:events';
import { Readable, Writable } from 'node:stream';

import {
  BoundedHttpStreamError,
  type BoundedHttpStreamPolicy,
  type HttpResponseStreamSource,
  assertBoundedHttpStreamPolicy,
  createHttpStreamLifetime,
  streamBoundedHttpResponse,
} from '../bounded-http-stream';

class TestDestination extends Writable {
  headersSent = false;
  statusCode = 200;
  readonly responseHeaders = new Map<string, string>();
  readonly chunks: Buffer[] = [];

  constructor(highWaterMark = 16 * 1024) {
    super({ highWaterMark });
  }

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

  body(): Buffer {
    return Buffer.concat(this.chunks);
  }
}

class SlowDestination extends TestDestination {
  maxQueuedBytes = 0;

  override _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.headersSent = true;
    this.chunks.push(Buffer.from(chunk));
    this.maxQueuedBytes = Math.max(this.maxQueuedBytes, this.writableLength);
    setImmediate(callback);
  }
}

class LifetimeRequest extends EventEmitter {
  aborted = false;

  abortRequest(): void {
    this.aborted = true;
    this.emit('aborted');
  }
}

class LifetimeResponse extends EventEmitter {
  writableFinished = false;

  closeEarly(): void {
    this.emit('close');
  }
}

function makePolicy(overrides: Partial<BoundedHttpStreamPolicy> = {}): BoundedHttpStreamPolicy {
  return {
    maxBodyBytes: 1024,
    maxHeaderBytes: 1024,
    timeoutMs: 5_000,
    allowedContentTypes: ['application/octet-stream'],
    forwardedResponseHeaders: ['Content-Type', 'Content-Length', 'Cache-Control'],
    ...overrides,
  };
}

function makeSource(
  chunks: readonly Buffer[],
  headers: HeadersInit = {
    'content-type': 'application/octet-stream',
  },
): HttpResponseStreamSource {
  return {
    status: 200,
    headers: new Headers(headers),
    body: Readable.from(chunks),
  };
}

describe('bounded HTTP response streaming', () => {
  it('streams through pipeline and forwards only explicitly allowlisted safe headers', async () => {
    const source = makeSource([Buffer.from('abc'), Buffer.from('def')], {
      'content-type': 'application/octet-stream',
      'content-length': '6',
      'cache-control': 'private, max-age=60',
      'set-cookie': 'internal-session=secret',
      'x-provider-debug': 'not-public',
    });
    const destination = new TestDestination();

    const result = await streamBoundedHttpResponse(
      source,
      destination,
      makePolicy(),
      new AbortController().signal,
    );

    expect(result).toEqual({ outcome: 'complete', bytesTransferred: 6 });
    expect(destination.statusCode).toBe(200);
    expect(destination.body()).toEqual(Buffer.from('abcdef'));
    expect(Object.fromEntries(destination.responseHeaders)).toEqual({
      'cache-control': 'private, max-age=60',
      'content-length': '6',
      'content-type': 'application/octet-stream',
    });
    expect(destination.responseHeaders.has('set-cookie')).toBe(false);
    expect(destination.responseHeaders.has('x-provider-debug')).toBe(false);
  });

  it('rejects an oversized declared body before flushing headers and destroys its source', async () => {
    const source = makeSource([Buffer.alloc(8)], {
      'content-type': 'application/octet-stream',
      'content-length': '8',
    });
    const destination = new TestDestination();

    await expect(
      streamBoundedHttpResponse(
        source,
        destination,
        makePolicy({ maxBodyBytes: 7 }),
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'BODY_TOO_LARGE' });

    expect(destination.headersSent).toBe(false);
    expect((source.body as Readable).destroyed).toBe(true);
  });

  it('rejects a declared non-empty response with no body before flushing headers', async () => {
    const destination = new TestDestination();
    const source: HttpResponseStreamSource = {
      status: 200,
      headers: new Headers({
        'content-type': 'application/octet-stream',
        'content-length': '1',
      }),
      body: null,
    };

    await expect(
      streamBoundedHttpResponse(source, destination, makePolicy(), new AbortController().signal),
    ).rejects.toMatchObject({ code: 'MISSING_RESPONSE_BODY' });

    expect(destination.headersSent).toBe(false);
    expect(destination.destroyed).toBe(false);
  });

  it.each(['-1', '1.5', '1e3', '1, 1', '+1', '01'])(
    'rejects non-canonical Content-Length %s',
    async (contentLength) => {
      const destination = new TestDestination();
      await expect(
        streamBoundedHttpResponse(
          makeSource([Buffer.from('x')], {
            'content-type': 'application/octet-stream',
            'content-length': contentLength,
          }),
          destination,
          makePolicy(),
          new AbortController().signal,
        ),
      ).rejects.toMatchObject({ code: 'INVALID_CONTENT_LENGTH' });
      expect(destination.headersSent).toBe(false);
    },
  );

  it('counts every upstream header, including headers that will not be forwarded', async () => {
    const destination = new TestDestination();
    await expect(
      streamBoundedHttpResponse(
        makeSource([Buffer.from('x')], {
          'content-type': 'application/octet-stream',
          'x-unforwarded-padding': 'x'.repeat(256),
        }),
        destination,
        makePolicy({ maxHeaderBytes: 128 }),
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'HEADERS_TOO_LARGE' });
    expect(destination.headersSent).toBe(false);
  });

  it('makes forbidden response headers impossible to add to a forwarding policy', () => {
    for (const forbidden of [
      'Set-Cookie',
      'Location',
      'Authorization',
      'WWW-Authenticate',
      'Connection',
      'X-Service-Signature',
    ]) {
      expect(() =>
        assertBoundedHttpStreamPolicy(
          makePolicy({ forwardedResponseHeaders: ['Content-Type', forbidden] }),
        ),
      ).toThrow(BoundedHttpStreamError);
    }
  });

  it('requires every policy limit and media/header allowlist to be explicit and valid', () => {
    expect(() => assertBoundedHttpStreamPolicy(makePolicy({ maxBodyBytes: 0 }))).toThrow(
      /maxBodyBytes/,
    );
    expect(() => assertBoundedHttpStreamPolicy(makePolicy({ maxHeaderBytes: Infinity }))).toThrow(
      /maxHeaderBytes/,
    );
    expect(() => assertBoundedHttpStreamPolicy(makePolicy({ timeoutMs: -1 }))).toThrow(/timeoutMs/);
    expect(() => assertBoundedHttpStreamPolicy(makePolicy({ allowedContentTypes: [] }))).toThrow(
      /allowedContentTypes/,
    );
    expect(() =>
      assertBoundedHttpStreamPolicy(makePolicy({ forwardedResponseHeaders: [] })),
    ).toThrow(/forwardedResponseHeaders/);
  });

  it('rejects an unapproved media type and compressed upstream bytes', async () => {
    await expect(
      streamBoundedHttpResponse(
        makeSource([Buffer.from('x')], { 'content-type': 'text/html' }),
        new TestDestination(),
        makePolicy(),
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'CONTENT_TYPE_NOT_ALLOWED' });

    await expect(
      streamBoundedHttpResponse(
        makeSource([Buffer.from('x')], {
          'content-type': 'application/octet-stream',
          'content-encoding': 'gzip',
        }),
        new TestDestination(),
        makePolicy(),
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_CONTENT_ENCODING' });
  });

  it('destroys a partial response and upstream at the first byte beyond the route limit', async () => {
    const source = makeSource([Buffer.from('1234'), Buffer.from('5')]);
    const destination = new TestDestination();

    const result = await streamBoundedHttpResponse(
      source,
      destination,
      makePolicy({ maxBodyBytes: 4 }),
      new AbortController().signal,
    );

    expect(result).toMatchObject({
      outcome: 'terminated',
      bytesTransferred: 4,
      error: { code: 'BODY_TOO_LARGE' },
    });
    expect(destination.body()).toEqual(Buffer.from('1234'));
    expect(destination.destroyed).toBe(true);
    expect((source.body as Readable).destroyed).toBe(true);
  });

  it('checks declared-length parity before allowing the destination to finish', async () => {
    const destination = new TestDestination();
    const result = await streamBoundedHttpResponse(
      makeSource([Buffer.from('abc')], {
        'content-type': 'application/octet-stream',
        'content-length': '4',
      }),
      destination,
      makePolicy(),
      new AbortController().signal,
    );

    expect(result).toMatchObject({
      outcome: 'terminated',
      bytesTransferred: 3,
      error: { code: 'CONTENT_LENGTH_MISMATCH' },
    });
    expect(destination.destroyed).toBe(true);
    expect(destination.writableFinished).toBe(false);
  });

  it('lets pipeline apply writable backpressure instead of accumulating the full body', async () => {
    const chunk = Buffer.alloc(512, 1);
    const destination = new SlowDestination(1024);
    const result = await streamBoundedHttpResponse(
      makeSource(Array.from({ length: 128 }, () => chunk)),
      destination,
      makePolicy({ maxBodyBytes: 128 * chunk.byteLength }),
      new AbortController().signal,
    );

    expect(result).toEqual({
      outcome: 'complete',
      bytesTransferred: 128 * chunk.byteLength,
    });
    expect(destination.maxQueuedBytes).toBeLessThanOrEqual(1024);
  });

  it('cancels an upstream body without emitting headers when already aborted', async () => {
    const source = makeSource([Buffer.from('never-read')]);
    const destination = new TestDestination();
    const controller = new AbortController();
    controller.abort(new Error('client gone'));

    const result = await streamBoundedHttpResponse(
      source,
      destination,
      makePolicy(),
      controller.signal,
    );

    expect(result).toMatchObject({ outcome: 'terminated', bytesTransferred: 0 });
    expect(destination.headersSent).toBe(false);
    expect((source.body as Readable).destroyed).toBe(true);
  });

  it('cancels the opened source when disconnect races with response header commit', async () => {
    const source = makeSource([Buffer.from('never-streamed')]);
    const controller = new AbortController();
    let flushed = false;
    const destination = new (class extends TestDestination {
      override setHeader(name: string, value: string): void {
        super.setHeader(name, value);
        controller.abort(new BoundedHttpStreamError('DOWNSTREAM_CLOSED', 'client gone'));
      }

      override flushHeaders(): void {
        flushed = true;
        super.flushHeaders();
      }
    })();

    const result = await streamBoundedHttpResponse(
      source,
      destination,
      makePolicy(),
      controller.signal,
    );

    expect(result).toMatchObject({
      outcome: 'terminated',
      bytesTransferred: 0,
      error: { code: 'DOWNSTREAM_CLOSED' },
    });
    expect(flushed).toBe(false);
    expect(destination.headersSent).toBe(false);
    expect((source.body as Readable).destroyed).toBe(true);
  });

  it('cancels the opened source if a pre-header destination mutation throws', async () => {
    const source = makeSource([Buffer.from('never-streamed')]);
    const destination = new (class extends TestDestination {
      override setHeader(): void {
        throw new Error('destination rejected header');
      }
    })();

    await expect(
      streamBoundedHttpResponse(source, destination, makePolicy(), new AbortController().signal),
    ).rejects.toThrow('destination rejected header');
    expect(destination.headersSent).toBe(false);
    expect((source.body as Readable).destroyed).toBe(true);
  });
});

describe('HTTP stream lifetime', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('combines request abort and premature response close into the same signal', () => {
    const request = new LifetimeRequest();
    const response = new LifetimeResponse();
    const lifetime = createHttpStreamLifetime(request, response, 5_000);

    request.abortRequest();

    expect(lifetime.signal.aborted).toBe(true);
    expect(lifetime.reason?.code).toBe('REQUEST_ABORTED');
    lifetime.dispose();

    const secondRequest = new LifetimeRequest();
    const secondResponse = new LifetimeResponse();
    const secondLifetime = createHttpStreamLifetime(secondRequest, secondResponse, 5_000);
    secondResponse.closeEarly();

    expect(secondLifetime.signal.aborted).toBe(true);
    expect(secondLifetime.reason?.code).toBe('DOWNSTREAM_CLOSED');
    secondLifetime.dispose();
  });

  it('does not treat a close after writable completion as a disconnect', () => {
    const request = new LifetimeRequest();
    const response = new LifetimeResponse();
    response.writableFinished = true;
    const lifetime = createHttpStreamLifetime(request, response, 5_000);

    response.emit('close');

    expect(lifetime.signal.aborted).toBe(false);
    lifetime.dispose();
  });

  it('aborts on its managed deadline and removes all listeners on dispose', () => {
    jest.useFakeTimers();
    const request = new LifetimeRequest();
    const response = new LifetimeResponse();
    const lifetime = createHttpStreamLifetime(request, response, 25);

    jest.advanceTimersByTime(25);

    expect(lifetime.signal.aborted).toBe(true);
    expect(lifetime.reason?.code).toBe('STREAM_TIMEOUT');
    lifetime.dispose();
    expect(request.listenerCount('aborted')).toBe(0);
    expect(response.listenerCount('close')).toBe(0);
    expect(jest.getTimerCount()).toBe(0);
  });
});
