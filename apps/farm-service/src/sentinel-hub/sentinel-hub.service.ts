import type { CdseProviderCredentialBundle } from '@aquaculture/backend-common/config-client';
import { createAbortSignalTimeout } from '@aquaculture/backend-common/utils';
import { Inject, Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';

import {
  MarineProviderCredentialsService,
  type ResolvedProviderCredential,
} from './marine-provider-credentials.service';
import { cancelResponseBody, readBoundedJsonResponse } from './bounded-json-response';
import { parseProviderRetryAfterMs } from '../weather/services/provider-http-headers';

const CDSE_TOKEN_URL =
  'https://identity.dataspace.copernicus.eu/auth/realms/CDSE/protocol/openid-connect/token';
export const CDSE_TOKEN_REQUEST_TIMEOUT_MS = 10_000;
export const CDSE_TOKEN_MAX_ATTEMPTS = 2;
export const CDSE_TOKEN_MAX_RETRY_AFTER_MS = 2_000;
export const CDSE_TOKEN_CACHE_MAX_GENERATIONS = 2_048;
const MAX_TOKEN_LIFETIME_SECONDS = 24 * 60 * 60;

export const CDSE_TOKEN_DELAY = Symbol('CDSE_TOKEN_DELAY');

export interface CdseTokenDelay {
  wait(milliseconds: number): Promise<void>;
}

export enum CdseTokenErrorCode {
  CREDENTIAL_SERVICE = 'CREDENTIAL_SERVICE',
  AUTHENTICATION = 'AUTHENTICATION',
  RATE_LIMITED = 'RATE_LIMITED',
  UPSTREAM = 'UPSTREAM',
  TIMEOUT = 'TIMEOUT',
  TRANSPORT = 'TRANSPORT',
  SCHEMA = 'SCHEMA',
  REDIRECT_BLOCKED = 'REDIRECT_BLOCKED',
}

interface CdseTokenErrorOptions {
  readonly code: CdseTokenErrorCode;
  readonly message: string;
  readonly retryable: boolean;
  readonly httpStatus?: number;
  readonly retryAfterMs?: number;
  readonly cause?: unknown;
}

export class CdseTokenError extends Error {
  readonly code: CdseTokenErrorCode;
  readonly retryable: boolean;
  readonly httpStatus?: number;
  readonly retryAfterMs?: number;
  readonly providerCause?: unknown;

  constructor(options: CdseTokenErrorOptions) {
    super(options.message);
    this.name = 'CdseTokenError';
    this.code = options.code;
    this.retryable = options.retryable;
    this.httpStatus = options.httpStatus;
    this.retryAfterMs = options.retryAfterMs;
    this.providerCause = options.cause;
  }
}

const SYSTEM_TOKEN_DELAY: CdseTokenDelay = {
  wait: async (milliseconds: number): Promise<void> => {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, milliseconds);
    });
  },
};

interface CachedToken {
  accessToken: string;
  expiresAt: number;
  credentialGeneration: string;
}

interface CdseTokenResponse {
  access_token: string;
  expires_in?: number;
}

export interface CdseCredentialResolver {
  resolveCdse(
    tenantId: string,
  ): Promise<ResolvedProviderCredential<CdseProviderCredentialBundle> | null>;
}

/**
 * CDSE access facade.
 *
 * config-service is the only credential SSoT. The retained
 * sentinel_hub_settings entity is used exclusively by the one-shot cutover
 * service; this active read/write path never consults the legacy table.
 */
@Injectable()
export class SentinelHubService implements OnModuleInit {
  private readonly logger = new Logger(SentinelHubService.name);
  private static readonly TOKEN_REFRESH_MARGIN_MS = 60_000;
  private readonly tokenCache = new Map<string, CachedToken>();
  private readonly tokenRefreshInFlight = new Map<
    string,
    Promise<{ accessToken: string; expiresIn: number } | null>
  >();
  private readonly delay: CdseTokenDelay;

  constructor(
    @Inject(MarineProviderCredentialsService)
    private readonly providerCredentials: CdseCredentialResolver,
    @Optional() @Inject(CDSE_TOKEN_DELAY) delay?: CdseTokenDelay,
  ) {
    this.delay = delay ?? SYSTEM_TOKEN_DELAY;
  }

  onModuleInit(): void {
    this.logger.log('SentinelHubService initialized with config-service credential SSoT');
  }

  async getAccessToken(
    tenantId: string,
  ): Promise<{ accessToken: string; expiresIn: number } | null> {
    const resolved = await this.resolveCredential(tenantId);
    if (!resolved) {
      return null;
    }
    const credentialGeneration = this.generation(resolved);
    const now = Date.now();
    this.pruneTokenCache(now);
    const cached = this.tokenCache.get(credentialGeneration);
    const cachedRemainingMs = cached ? cached.expiresAt - now : 0;
    if (cached && cachedRemainingMs >= 1_000) {
      // Refresh insertion order so the fixed-size cache evicts the least
      // recently used generation when a deployment serves many tenants.
      this.tokenCache.delete(credentialGeneration);
      this.tokenCache.set(credentialGeneration, cached);
      return {
        accessToken: cached.accessToken,
        expiresIn: Math.floor(cachedRemainingMs / 1000),
      };
    }
    if (cached) {
      // Never return `expiresIn: 0`: downstream correctly treats that as an
      // invalid provider contract. Refresh during this sub-second boundary.
      this.tokenCache.delete(credentialGeneration);
    }

    const inFlight = this.tokenRefreshInFlight.get(credentialGeneration);
    if (inFlight) {
      return inFlight;
    }
    const refresh = this.fetchAndCacheToken(credentialGeneration, resolved.bundle).finally(() => {
      this.tokenRefreshInFlight.delete(credentialGeneration);
    });
    this.tokenRefreshInFlight.set(credentialGeneration, refresh);
    return refresh;
  }

  private generation(resolved: ResolvedProviderCredential<CdseProviderCredentialBundle>): string {
    return `${resolved.sourceTenantId}:${resolved.configVersion}`;
  }

  private async fetchAndCacheToken(
    credentialGeneration: string,
    bundle: CdseProviderCredentialBundle,
  ): Promise<{ accessToken: string; expiresIn: number }> {
    const fresh = await this.fetchFreshToken(bundle);
    const expiresAt =
      Date.now() + fresh.expiresIn * 1000 - SentinelHubService.TOKEN_REFRESH_MARGIN_MS;
    this.tokenCache.set(credentialGeneration, {
      accessToken: fresh.accessToken,
      expiresAt,
      credentialGeneration,
    });
    this.trimTokenCache();
    return fresh;
  }

  private pruneTokenCache(now: number): void {
    for (const [generation, token] of this.tokenCache) {
      if (token.expiresAt <= now) {
        this.tokenCache.delete(generation);
      }
    }
  }

  private trimTokenCache(): void {
    while (this.tokenCache.size > CDSE_TOKEN_CACHE_MAX_GENERATIONS) {
      const oldestGeneration = this.tokenCache.keys().next().value as string | undefined;
      if (oldestGeneration === undefined) {
        return;
      }
      this.tokenCache.delete(oldestGeneration);
    }
  }

  private async fetchFreshToken(
    bundle: CdseProviderCredentialBundle,
  ): Promise<{ accessToken: string; expiresIn: number }> {
    return this.executeTransientAttempts(() => this.fetchFreshTokenOnce(bundle));
  }

  private async resolveCredential(
    tenantId: string,
  ): Promise<ResolvedProviderCredential<CdseProviderCredentialBundle> | null> {
    return this.executeTransientAttempts(async () => {
      try {
        return await this.providerCredentials.resolveCdse(tenantId);
      } catch (cause) {
        throw tokenError(
          CdseTokenErrorCode.CREDENTIAL_SERVICE,
          'CDSE credential service is unavailable',
          true,
          { cause },
        );
      }
    });
  }

  private async fetchFreshTokenOnce(
    bundle: CdseProviderCredentialBundle,
  ): Promise<{ accessToken: string; expiresIn: number }> {
    const timeout = createAbortSignalTimeout(CDSE_TOKEN_REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(CDSE_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'client_credentials',
          client_id: bundle.clientId,
          client_secret: bundle.clientSecret,
        }),
        signal: timeout.signal,
        redirect: 'manual',
      });
      await this.assertAcceptedTokenResponse(response);
      if (!this.isJsonResponse(response)) {
        await cancelResponseBody(response);
        throw tokenError(
          CdseTokenErrorCode.SCHEMA,
          'CDSE token response media type was invalid',
          false,
        );
      }
      const payload = await readBoundedJsonResponse(response);
      if (payload === null) {
        throw tokenError(
          CdseTokenErrorCode.SCHEMA,
          'CDSE token response exceeded its contract',
          false,
        );
      }
      if (!this.isTokenResponse(payload)) {
        throw tokenError(CdseTokenErrorCode.SCHEMA, 'CDSE token response shape was invalid', false);
      }
      return {
        accessToken: payload.access_token,
        expiresIn: payload.expires_in ?? 1800,
      };
    } catch (error) {
      if (error instanceof CdseTokenError) {
        throw error;
      }
      const timedOut = timeout.signal.aborted || isAbortError(error);
      throw tokenError(
        timedOut ? CdseTokenErrorCode.TIMEOUT : CdseTokenErrorCode.TRANSPORT,
        timedOut ? 'CDSE token request timed out' : 'CDSE token transport failed',
        true,
        { cause: error },
      );
    } finally {
      timeout.clear();
    }
  }

  private async assertAcceptedTokenResponse(response: Response): Promise<void> {
    if (response.status >= 300 && response.status < 400) {
      await cancelResponseBody(response);
      throw tokenError(
        CdseTokenErrorCode.REDIRECT_BLOCKED,
        'CDSE token endpoint returned an unexpected redirect',
        false,
        { httpStatus: response.status },
      );
    }
    if (response.status === 400 || response.status === 401 || response.status === 403) {
      await cancelResponseBody(response);
      throw tokenError(
        CdseTokenErrorCode.AUTHENTICATION,
        'CDSE rejected the configured client credential',
        false,
        { httpStatus: response.status },
      );
    }
    if (
      response.status === 408 ||
      response.status === 425 ||
      response.status === 429 ||
      response.status >= 500
    ) {
      const retryAfterMs = parseProviderRetryAfterMs(
        response.headers.get('retry-after'),
        new Date(),
        CDSE_TOKEN_MAX_RETRY_AFTER_MS,
      );
      await cancelResponseBody(response);
      const code =
        response.status === 408
          ? CdseTokenErrorCode.TIMEOUT
          : response.status === 429
            ? CdseTokenErrorCode.RATE_LIMITED
            : CdseTokenErrorCode.UPSTREAM;
      throw tokenError(code, 'CDSE token endpoint is temporarily unavailable', true, {
        httpStatus: response.status,
        ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
      });
    }
    if (!response.ok) {
      await cancelResponseBody(response);
      throw tokenError(
        CdseTokenErrorCode.SCHEMA,
        'CDSE token endpoint rejected the fixed backend request',
        false,
        { httpStatus: response.status },
      );
    }
  }

  private async executeTransientAttempts<T>(operation: () => Promise<T>): Promise<T> {
    let lastError: CdseTokenError | null = null;
    for (let attempt = 0; attempt < CDSE_TOKEN_MAX_ATTEMPTS; attempt += 1) {
      try {
        return await operation();
      } catch (error) {
        if (!(error instanceof CdseTokenError) || !error.retryable) {
          throw error;
        }
        lastError = error;
        if (attempt + 1 < CDSE_TOKEN_MAX_ATTEMPTS && error.retryAfterMs !== undefined) {
          await this.delay.wait(error.retryAfterMs);
        }
      }
    }
    if (lastError === null) {
      throw tokenError(
        CdseTokenErrorCode.TRANSPORT,
        'CDSE token acquisition failed without a classified result',
        true,
      );
    }
    throw lastError;
  }

  private isTokenResponse(value: unknown): value is CdseTokenResponse {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return false;
    }
    const record = value as Record<string, unknown>;
    return (
      typeof record['access_token'] === 'string' &&
      record['access_token'].length > 0 &&
      (record['expires_in'] === undefined ||
        (typeof record['expires_in'] === 'number' &&
          Number.isSafeInteger(record['expires_in']) &&
          record['expires_in'] > 0 &&
          record['expires_in'] <= MAX_TOKEN_LIFETIME_SECONDS))
    );
  }

  private isJsonResponse(response: Response): boolean {
    const contentType = response.headers.get('content-type');
    return contentType?.split(';', 1)[0]?.trim().toLowerCase() === 'application/json';
  }
}

function tokenError(
  code: CdseTokenErrorCode,
  message: string,
  retryable: boolean,
  details: {
    readonly httpStatus?: number;
    readonly retryAfterMs?: number;
    readonly cause?: unknown;
  } = {},
): CdseTokenError {
  return new CdseTokenError({
    code,
    message,
    retryable,
    ...(details.httpStatus === undefined ? {} : { httpStatus: details.httpStatus }),
    ...(details.retryAfterMs === undefined ? {} : { retryAfterMs: details.retryAfterMs }),
    ...(details.cause === undefined ? {} : { cause: details.cause }),
  });
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError');
}
