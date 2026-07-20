import {
  type BoundedHttpStreamPolicy,
  type BoundedHttpStreamResult,
  type HttpStreamDestination,
  type HttpStreamLifetime,
  type HttpStreamLifetimeRequest,
  type SignedFetchCircuitBreakerOption,
  type SignedFetchCircuitBreakerOptionsLike,
  assertBoundedHttpStreamPolicy,
  createHttpStreamLifetime,
  normalizeHttpStreamError,
  signedFetch,
  streamBoundedHttpResponse,
} from '@aquaculture/backend-common/http';
import { GatewayTimeoutException, Injectable } from '@nestjs/common';

export type SignedStreamingRequestBody = string | Buffer | URLSearchParams;

const SAFE_STREAM_REQUEST_HEADERS = new Set([
  'accept',
  'accept-encoding',
  'accept-language',
  'cache-control',
  'content-type',
  'if-modified-since',
  'if-none-match',
  'range',
  'x-correlation-id',
  'x-request-id',
  'x-verified-user-assertion',
]);

export interface SignedStreamingProxyOptions {
  readonly url: string | URL;
  readonly tenantId: string;
  readonly audience: string;
  readonly method?: string;
  readonly headers?: HeadersInit;
  readonly body?: SignedStreamingRequestBody;
  readonly effectiveTenantId?: string;
  readonly policy: BoundedHttpStreamPolicy;
  readonly circuitBreaker: SignedFetchCircuitBreakerOption;
  readonly circuitBreakerOptions: SignedFetchCircuitBreakerOptionsLike;
}

class BreakerRecordedStreamTermination extends Error {
  constructor(readonly result: BoundedHttpStreamResult) {
    super('Bounded upstream stream terminated');
    this.name = BreakerRecordedStreamTermination.name;
  }
}

/**
 * Inert gateway transport adapter for bounded, signed response streams. Route
 * controllers retain authentication/path ownership; this service owns only the
 * gateway-to-service HTTP lifecycle and never buffers the upstream body.
 */
@Injectable()
export class SignedStreamingProxyService {
  async proxy(
    request: HttpStreamLifetimeRequest,
    destination: HttpStreamDestination,
    options: SignedStreamingProxyOptions,
  ): Promise<BoundedHttpStreamResult> {
    assertBoundedHttpStreamPolicy(options.policy);
    if (options.circuitBreakerOptions.failureMode !== 'fail-closed') {
      throw new Error('Signed streaming proxies require a fail-closed circuit breaker');
    }
    const lifetime = createHttpStreamLifetime(request, destination, options.policy.timeoutMs);

    try {
      const headers = this.buildSafeRequestHeaders(options.headers);
      // Node fetch transparently decompresses provider responses. Requiring
      // identity keeps Content-Length and the byte counter about the same bytes.
      headers.set('Accept-Encoding', 'identity');
      const body = Buffer.isBuffer(options.body) ? new Uint8Array(options.body) : options.body;

      return await options.circuitBreaker.service.execute({
        serviceName: options.circuitBreaker.serviceName,
        tenantId: options.tenantId,
        options: options.circuitBreakerOptions,
        shouldRecordFailure: () => !this.isDownstreamCancellation(lifetime),
        fn: async () => {
          const upstream = await signedFetch(options.url, {
            serviceName: 'gateway-api',
            tenantId: options.tenantId,
            audience: options.audience,
            method: options.method ?? 'GET',
            headers,
            body,
            effectiveTenantId: options.effectiveTenantId,
            signal: lifetime.signal,
            // Internal authorities must stream bytes themselves. Accepting a 3xx
            // would either expose an opaque provider/storage redirect or turn the
            // gateway into a redirect relay outside the signed audience boundary.
            redirect: 'error',
          });

          const result = await streamBoundedHttpResponse(
            upstream,
            destination,
            options.policy,
            lifetime.signal,
          );
          this.throwPreHeaderTimeout(result, lifetime, destination);
          if (result.outcome === 'terminated') {
            // The response may already be committed, but dependency health must
            // still observe truncation, limit failures, disconnects, and timeouts.
            throw new BreakerRecordedStreamTermination(result);
          }
          return result;
        },
      });
    } catch (error) {
      if (error instanceof BreakerRecordedStreamTermination) {
        return error.result;
      }
      return this.handleOpeningFailure(error, lifetime, destination);
    } finally {
      lifetime.dispose();
    }
  }

  private buildSafeRequestHeaders(input: HeadersInit | undefined): Headers {
    const headers = new Headers(input);
    headers.forEach((_value, name) => {
      if (!SAFE_STREAM_REQUEST_HEADERS.has(name.toLowerCase())) {
        throw new Error(`Streaming proxy request header is not allowlisted: ${name}`);
      }
    });
    return headers;
  }

  private isDownstreamCancellation(lifetime: HttpStreamLifetime): boolean {
    return (
      lifetime.reason?.code === 'REQUEST_ABORTED' ||
      lifetime.reason?.code === 'DOWNSTREAM_CLOSED' ||
      lifetime.reason?.code === 'MANUAL_ABORT'
    );
  }

  private throwPreHeaderTimeout(
    result: BoundedHttpStreamResult,
    lifetime: HttpStreamLifetime,
    destination: HttpStreamDestination,
  ): void {
    if (
      result.outcome === 'terminated' &&
      lifetime.reason?.code === 'STREAM_TIMEOUT' &&
      !destination.headersSent &&
      !destination.destroyed
    ) {
      throw new GatewayTimeoutException('Upstream response timed out before headers');
    }
  }

  private handleOpeningFailure(
    error: unknown,
    lifetime: HttpStreamLifetime,
    destination: HttpStreamDestination,
  ): BoundedHttpStreamResult {
    const normalized = normalizeHttpStreamError(error);
    if (lifetime.reason?.code === 'STREAM_TIMEOUT') {
      if (!destination.headersSent && !destination.destroyed) {
        throw new GatewayTimeoutException('Upstream response timed out before headers');
      }
      if (!destination.destroyed) destination.destroy();
      return { outcome: 'terminated', bytesTransferred: 0, error: normalized };
    }

    if (lifetime.signal.aborted || destination.headersSent || destination.destroyed) {
      if (destination.headersSent && !destination.destroyed) destination.destroy();
      return { outcome: 'terminated', bytesTransferred: 0, error: normalized };
    }

    throw normalized;
  }
}
