import {
  type BoundedHttpStreamPolicy,
  type BoundedHttpStreamResult,
  type HttpResponseStreamSource,
  type HttpStreamDestination,
  type HttpStreamLifetime,
  type HttpStreamLifetimeRequest,
  assertBoundedHttpStreamPolicy,
  createHttpStreamLifetime,
  normalizeHttpStreamError,
  streamBoundedHttpResponse,
} from '@aquaculture/backend-common/http';
import { GatewayTimeoutException, Injectable } from '@nestjs/common';

export interface FarmStreamingSourceContext {
  readonly signal: AbortSignal;
  readonly requestHeaders: Readonly<Record<string, string>>;
}

export interface FarmStreamingResponseOptions {
  readonly policy: BoundedHttpStreamPolicy;
  readonly openSource: (context: FarmStreamingSourceContext) => Promise<HttpResponseStreamSource>;
}

/**
 * Farm-side transport boundary for provider/MinIO response streams. The source
 * factory receives the browser-linked AbortSignal explicitly; application and
 * provider layers never need an Express response object.
 */
@Injectable()
export class FarmStreamingResponseAdapter {
  async stream(
    request: HttpStreamLifetimeRequest,
    destination: HttpStreamDestination,
    options: FarmStreamingResponseOptions,
  ): Promise<BoundedHttpStreamResult> {
    assertBoundedHttpStreamPolicy(options.policy);
    const lifetime = createHttpStreamLifetime(request, destination, options.policy.timeoutMs);

    try {
      const requestHeaders: Readonly<Record<string, string>> = Object.freeze({
        'Accept-Encoding': 'identity',
      });
      const source = await options.openSource({
        signal: lifetime.signal,
        requestHeaders,
      });
      const result = await streamBoundedHttpResponse(
        source,
        destination,
        options.policy,
        lifetime.signal,
      );
      this.throwPreHeaderTimeout(result, lifetime, destination);
      return result;
    } catch (error) {
      return this.handleOpeningFailure(error, lifetime, destination);
    } finally {
      lifetime.dispose();
    }
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
      throw new GatewayTimeoutException('Provider response timed out before headers');
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
        throw new GatewayTimeoutException('Provider response timed out before headers');
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
