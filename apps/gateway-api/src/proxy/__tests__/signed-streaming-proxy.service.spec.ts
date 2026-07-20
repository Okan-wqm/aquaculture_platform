import { EventEmitter } from 'node:events';
import { Writable } from 'node:stream';

import {
  type BoundedHttpStreamPolicy,
  type SignedFetchCircuitBreakerOption,
  type SignedFetchCircuitBreakerOptionsLike,
  signedFetch,
} from '@aquaculture/backend-common/http';
import { GatewayTimeoutException } from '@nestjs/common';

import { SignedStreamingProxyService } from '../signed-streaming-proxy.service';

jest.mock('@aquaculture/backend-common/http', () => ({
  ...jest.requireActual<typeof import('@aquaculture/backend-common/http')>(
    '@aquaculture/backend-common/http',
  ),
  signedFetch: jest.fn(),
}));

const signedFetchMock = jest.mocked(signedFetch);

class TestRequest extends EventEmitter {
  aborted = false;
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

  closeEarly(): void {
    this.emit('close');
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
  allowedContentTypes: ['image/png'],
  forwardedResponseHeaders: ['Content-Type', 'Content-Length', 'Cache-Control'],
};

const CIRCUIT_BREAKER: SignedFetchCircuitBreakerOption = {
  service: {
    async execute({ fn }) {
      return fn();
    },
  },
  serviceName: 'marine-stream',
};

const CIRCUIT_BREAKER_OPTIONS: SignedFetchCircuitBreakerOptionsLike = {
  failureMode: 'fail-closed',
  failureThreshold: 5,
  successThreshold: 2,
  volumeThreshold: 10,
  failureRatePct: 50,
  slowCallMs: 1_000,
  slowCallRatePct: 50,
  halfOpenRequests: 2,
  openTimeoutMs: 30_000,
  windowSeconds: 60,
  bucketSeconds: 10,
};

const FAIL_CLOSED_BREAKER = {
  circuitBreaker: CIRCUIT_BREAKER,
  circuitBreakerOptions: CIRCUIT_BREAKER_OPTIONS,
};

function abortReason(signal: AbortSignal | null | undefined): Error {
  return signal?.reason instanceof Error ? signal.reason : new Error('aborted');
}

describe('SignedStreamingProxyService', () => {
  const service = new SignedStreamingProxyService();

  beforeEach(() => {
    signedFetchMock.mockReset();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('opens a tenant-bound signed stream with identity encoding and pipes without buffering', async () => {
    signedFetchMock.mockResolvedValue(
      new Response(Buffer.from('png'), {
        status: 200,
        headers: {
          'content-type': 'image/png',
          'content-length': '3',
          'cache-control': 'private, max-age=60',
        },
      }),
    );
    const request = new TestRequest();
    const destination = new TestDestination();

    const result = await service.proxy(request, destination, {
      url: 'http://farm-service:3000/api/internal/example',
      tenantId: '11111111-1111-4111-8111-111111111111',
      audience: 'farm',
      headers: {
        Accept: 'image/png',
        'Accept-Encoding': 'gzip',
        'x-verified-user-assertion': 'assertion',
      },
      policy: POLICY,
      ...FAIL_CLOSED_BREAKER,
    });

    expect(result).toEqual({ outcome: 'complete', bytesTransferred: 3 });
    expect(Buffer.concat(destination.chunks)).toEqual(Buffer.from('png'));
    expect(signedFetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = signedFetchMock.mock.calls[0]!;
    expect(url).toBe('http://farm-service:3000/api/internal/example');
    expect(init).toEqual(
      expect.objectContaining({
        serviceName: 'gateway-api',
        tenantId: '11111111-1111-4111-8111-111111111111',
        audience: 'farm',
        method: 'GET',
        redirect: 'error',
      }),
    );
    expect(init).not.toHaveProperty('circuitBreaker');
    expect(init).not.toHaveProperty('circuitBreakerOptions');
    expect(new Headers(init.headers).get('accept-encoding')).toBe('identity');
    expect(new Headers(init.headers).get('x-verified-user-assertion')).toBe('assertion');
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('propagates a premature downstream close into the in-flight signed fetch', async () => {
    let observedSignal: AbortSignal | undefined;
    signedFetchMock.mockImplementation(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          observedSignal = init.signal ?? undefined;
          init.signal?.addEventListener('abort', () => reject(abortReason(init.signal)), {
            once: true,
          });
        }),
    );
    const request = new TestRequest();
    const destination = new TestDestination();

    const pending = service.proxy(request, destination, {
      url: 'http://farm-service:3000/api/internal/example',
      tenantId: 'tenant-1',
      audience: 'farm',
      policy: POLICY,
      ...FAIL_CLOSED_BREAKER,
    });
    await Promise.resolve();
    destination.closeEarly();
    const result = await pending;

    expect(observedSignal?.aborted).toBe(true);
    expect(result).toMatchObject({
      outcome: 'terminated',
      bytesTransferred: 0,
      error: { code: 'DOWNSTREAM_CLOSED' },
    });
    expect(destination.headersSent).toBe(false);
  });

  it('surfaces a pre-header deadline as a gateway timeout envelope opportunity', async () => {
    jest.useFakeTimers();
    signedFetchMock.mockImplementation(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(abortReason(init.signal)), {
            once: true,
          });
        }),
    );
    const destination = new TestDestination();
    const pending = service.proxy(new TestRequest(), destination, {
      url: 'http://farm-service:3000/api/internal/example',
      tenantId: 'tenant-1',
      audience: 'farm',
      policy: { ...POLICY, timeoutMs: 25 },
      ...FAIL_CLOSED_BREAKER,
    });
    await Promise.resolve();

    jest.advanceTimersByTime(25);

    await expect(pending).rejects.toBeInstanceOf(GatewayTimeoutException);
    expect(destination.headersSent).toBe(false);
  });

  it('cancels an invalid upstream response before committing downstream headers', async () => {
    const upstream = new Response(Buffer.from('x'), {
      headers: {
        'content-type': 'image/png',
        'x-padding': 'x'.repeat(512),
      },
    });
    signedFetchMock.mockResolvedValue(upstream);
    const destination = new TestDestination();

    await expect(
      service.proxy(new TestRequest(), destination, {
        url: 'http://farm-service:3000/api/internal/example',
        tenantId: 'tenant-1',
        audience: 'farm',
        policy: { ...POLICY, maxHeaderBytes: 128 },
        ...FAIL_CLOSED_BREAKER,
      }),
    ).rejects.toMatchObject({ code: 'HEADERS_TOO_LARGE' });

    expect(destination.headersSent).toBe(false);
    expect(upstream.bodyUsed).toBe(true);
  });

  it('records response validation failures inside the dependency breaker', async () => {
    const recordedFailures: unknown[] = [];
    const breaker: SignedFetchCircuitBreakerOption = {
      service: {
        async execute({ fn }) {
          try {
            return await fn();
          } catch (error) {
            recordedFailures.push(error);
            throw error;
          }
        },
      },
      serviceName: 'marine-stream-validation',
    };
    signedFetchMock.mockResolvedValue(
      new Response(Buffer.from('not-json'), {
        headers: { 'content-type': 'application/json' },
      }),
    );

    await expect(
      service.proxy(new TestRequest(), new TestDestination(), {
        url: 'http://farm-service:3000/api/internal/example',
        tenantId: 'tenant-1',
        audience: 'farm',
        policy: POLICY,
        circuitBreaker: breaker,
        circuitBreakerOptions: CIRCUIT_BREAKER_OPTIONS,
      }),
    ).rejects.toMatchObject({ code: 'CONTENT_TYPE_NOT_ALLOWED' });

    expect(recordedFailures).toHaveLength(1);
    expect(recordedFailures[0]).toMatchObject({ code: 'CONTENT_TYPE_NOT_ALLOWED' });
  });

  it('records post-header truncation inside the dependency breaker without appending JSON', async () => {
    const recordedFailures: unknown[] = [];
    const breaker: SignedFetchCircuitBreakerOption = {
      service: {
        async execute({ fn }) {
          try {
            return await fn();
          } catch (error) {
            recordedFailures.push(error);
            throw error;
          }
        },
      },
      serviceName: 'marine-stream-body',
    };
    signedFetchMock.mockResolvedValue(
      new Response(Buffer.from('xy'), {
        headers: {
          'content-type': 'image/png',
          'content-length': '3',
        },
      }),
    );
    const destination = new TestDestination();

    const result = await service.proxy(new TestRequest(), destination, {
      url: 'http://farm-service:3000/api/internal/example',
      tenantId: 'tenant-1',
      audience: 'farm',
      policy: POLICY,
      circuitBreaker: breaker,
      circuitBreakerOptions: CIRCUIT_BREAKER_OPTIONS,
    });

    expect(result).toMatchObject({
      outcome: 'terminated',
      bytesTransferred: 2,
      error: { code: 'CONTENT_LENGTH_MISMATCH' },
    });
    expect(destination.headersSent).toBe(true);
    expect(destination.destroyed).toBe(true);
    expect(recordedFailures).toHaveLength(1);
    expect(recordedFailures[0]).toMatchObject({
      result: { error: { code: 'CONTENT_LENGTH_MISMATCH' } },
    });
  });

  it('rejects a fail-open breaker policy before opening the upstream', async () => {
    await expect(
      service.proxy(new TestRequest(), new TestDestination(), {
        url: 'http://farm-service:3000/api/internal/example',
        tenantId: 'tenant-1',
        audience: 'farm',
        policy: POLICY,
        circuitBreaker: CIRCUIT_BREAKER,
        circuitBreakerOptions: {
          ...CIRCUIT_BREAKER_OPTIONS,
          failureMode: 'fail-open-degraded',
        },
      }),
    ).rejects.toThrow('Signed streaming proxies require a fail-closed circuit breaker');

    expect(signedFetchMock).not.toHaveBeenCalled();
  });

  it('rejects browser credentials instead of forwarding them to an internal authority', async () => {
    await expect(
      service.proxy(new TestRequest(), new TestDestination(), {
        url: 'http://farm-service:3000/api/internal/example',
        tenantId: 'tenant-1',
        audience: 'farm',
        headers: { Authorization: 'Bearer browser-token' },
        policy: POLICY,
        ...FAIL_CLOSED_BREAKER,
      }),
    ).rejects.toThrow('request header is not allowlisted: authorization');

    expect(signedFetchMock).not.toHaveBeenCalled();
  });
});
