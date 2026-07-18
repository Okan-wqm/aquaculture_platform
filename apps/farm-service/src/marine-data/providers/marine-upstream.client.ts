import {
  BadGatewayException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';

import {
  CircuitBreakerService,
  CircuitOpenError,
  DEFAULT_BREAKER_OPTIONS,
  type CircuitBreakerOptions,
} from '@aquaculture/backend-common/resilience';

/** Hard deadline for every marine upstream call. A hung provider must not tie up a request thread. */
const UPSTREAM_TIMEOUT_MS = 30_000;
const CMEMS_SERVICE = 'cmems-wmts';
const SENTINEL_SERVICE = 'sentinel-process';

/**
 * Fail-closed breaker for both marine upstreams. CMEMS is public and globally
 * keyed (failures are upstream-wide, not tenant-caused); Sentinel/CDSE is keyed
 * per tenant (per-tenant credentials + processing-unit quota), so one tenant's
 * failing integration cannot open the breaker for everyone else.
 */
const MARINE_BREAKER_OPTIONS: CircuitBreakerOptions = {
  ...DEFAULT_BREAKER_OPTIONS,
  failureMode: 'fail-closed',
};

/**
 * Marker thrown inside the breaker fn on an upstream 5xx so the breaker counts a
 * server outage — `fetch` resolves normally on a 5xx, so without this a sustained
 * outage would never trip the breaker. The original response rides along so the
 * caller still receives the unchanged status; the marine tile/point paths own
 * their own upstream-status handling.
 */
class UpstreamServerError extends Error {
  constructor(readonly response: Response) {
    super(`Marine upstream server error ${response.status}`);
    this.name = 'UpstreamServerError';
  }
}

/**
 * The single choke point for every marine upstream call: a 30 s deadline, a
 * bounded retry for idempotent CMEMS GETs, and the canonical
 * CircuitBreakerService. Routing both providers through here means no marine code
 * path can reach CMEMS or CDSE without the breaker — the repo's external-call
 * invariant holds by construction rather than by reviewer vigilance.
 */
@Injectable()
export class MarineUpstreamClient {
  private readonly logger = new Logger(MarineUpstreamClient.name);

  constructor(private readonly circuitBreaker: CircuitBreakerService) {}

  /** CMEMS public WMTS GET — globally keyed, one bounded retry (network error or 5xx). */
  async fetchCmems(url: string): Promise<Response> {
    return this.execute(CMEMS_SERVICE, undefined, () => this.timedFetch(url), 1);
  }

  /** Sentinel/CDSE Process POST — per-tenant key, no retry (each call burns processing units). */
  async fetchSentinel(tenantId: string, url: string, init: RequestInit): Promise<Response> {
    return this.execute(SENTINEL_SERVICE, tenantId, () => this.timedFetch(url, init), 0);
  }

  private timedFetch(url: string, init?: RequestInit): Promise<Response> {
    return fetch(url, { ...init, signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) });
  }

  private async execute(
    serviceName: string,
    tenantId: string | undefined,
    doFetch: () => Promise<Response>,
    retries: number,
  ): Promise<Response> {
    try {
      return await this.circuitBreaker.execute({
        serviceName,
        tenantId,
        options: MARINE_BREAKER_OPTIONS,
        fn: () => this.attempt(doFetch, retries),
      });
    } catch (error) {
      if (error instanceof UpstreamServerError) {
        // 5xx: counted by the breaker, surfaced to the caller unchanged.
        return error.response;
      }
      if (error instanceof CircuitOpenError) {
        this.logger.warn(`Circuit OPEN for ${serviceName}; shedding marine upstream call`);
        throw new ServiceUnavailableException('Marine upstream temporarily unavailable');
      }
      this.logger.warn(
        `Marine upstream request failed: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
      throw new BadGatewayException('Marine upstream request failed');
    }
  }

  private async attempt(doFetch: () => Promise<Response>, retries: number): Promise<Response> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        const response = await doFetch();
        if (response.status >= 500) {
          throw new UpstreamServerError(response);
        }
        return response;
      } catch (error) {
        if (attempt >= retries) {
          throw error;
        }
        // Bounded retry for transient network errors / 5xx on idempotent GETs.
      }
    }
  }
}
