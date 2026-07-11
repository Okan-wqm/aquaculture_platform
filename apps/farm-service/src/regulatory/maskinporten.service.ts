/**
 * Maskinporten OAuth2 Service
 *
 * Norwegian government authentication service for machine-to-machine
 * (M2M) API access. Used to obtain access tokens for Mattilsynet
 * regulatory reporting APIs.
 *
 * TENANT-AWARE: Uses per-tenant credentials from RegulatorySettingsService.
 *
 * Documentation: https://docs.digdir.no/maskinporten_overordnet.html
 *
 * Required Scopes for Mattilsynet:
 * - mattilsynet:akvakultur.innrapportering.lakselus
 * - mattilsynet:akvakultur.innrapportering.rensefisk
 * - mattilsynet:akvakultur.innrapportering.settefisk
 * - mattilsynet:akvakultur.innrapportering.slakt
 */

import { Injectable, Logger, Inject, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as jwt from 'jsonwebtoken';
import * as crypto from 'crypto';
import {
  clearManagedTimer,
  createManagedInterval,
  maskAndTruncatePii,
  type ManagedInterval,
} from '@aquaculture/backend-common/utils';
import {
  CircuitBreakerService,
  DEFAULT_BREAKER_OPTIONS,
  type CircuitBreakerOptions,
} from '@aquaculture/backend-common/resilience';

import { RegulatorySettingsService } from './regulatory-settings.service';

/**
 * Hard deadline for every outbound Maskinporten HTTP call (discovery + token). An
 * auth server that accepts the TCP/TLS connection but never responds must not hang
 * a request thread or a lock-held cron sweep indefinitely.
 */
const MASKINPORTEN_HTTP_TIMEOUT_MS = 5000;

/**
 * Fail-closed breaker for the Maskinporten auth server: on trip the token/discovery
 * call throws (never fabricates a token), which the submission pipeline classifies
 * as a transient failure and replays. The token breaker is keyed PER TENANT so one
 * tenant's revoked client / wrong key cannot open the breaker for everyone.
 */
const MASKINPORTEN_BREAKER_OPTIONS: CircuitBreakerOptions = {
  ...DEFAULT_BREAKER_OPTIONS,
  failureMode: 'fail-closed',
};

// ============================================================================
// Types
// ============================================================================

export interface MaskinportenConfig {
  /** Well-known endpoint for discovery */
  wellKnownUrl: string;
  /** Client ID (Integration ID) from Samarbeidsportalen */
  clientId: string;
  /** Private key in PEM format for signing JWTs */
  privateKeyPem: string;
  /** Key ID from the certificate/keypair */
  keyId?: string;
  /** OAuth2 scopes to request */
  scopes: string[];
  /** Token endpoint (auto-discovered from well-known) */
  tokenEndpoint?: string;
  /** Issuer (auto-discovered from well-known) */
  issuer?: string;
}

export interface TokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  scope: string;
}

export interface CachedToken {
  accessToken: string;
  expiresAt: Date;
  scopes: string[];
}

export interface CacheEntry<T> {
  data: T;
  expiresAt: number;
}

// ============================================================================
// Constants
// ============================================================================

/** Mattilsynet API scopes for aquaculture reporting */
export const MATTILSYNET_SCOPES = {
  SEA_LICE: 'mattilsynet:akvakultur.innrapportering.lakselus',
  CLEANER_FISH: 'mattilsynet:akvakultur.innrapportering.rensefisk',
  SMOLT: 'mattilsynet:akvakultur.innrapportering.settefisk',
  SLAUGHTER: 'mattilsynet:akvakultur.innrapportering.slakt',
} as const;

/** All Mattilsynet scopes combined */
export const ALL_MATTILSYNET_SCOPES = Object.values(MATTILSYNET_SCOPES);

/** Maskinporten environments */
export const MASKINPORTEN_ENVIRONMENTS = {
  PRODUCTION: {
    wellKnownUrl: 'https://maskinporten.no/.well-known/oauth-authorization-server',
    audience: 'https://maskinporten.no/',
  },
  TEST: {
    wellKnownUrl: 'https://test.maskinporten.no/.well-known/oauth-authorization-server',
    audience: 'https://test.maskinporten.no/',
  },
  VER2: {
    wellKnownUrl: 'https://ver2.maskinporten.no/.well-known/oauth-authorization-server',
    audience: 'https://ver2.maskinporten.no/',
  },
} as const;

// ============================================================================
// Service
// ============================================================================

@Injectable()
export class MaskinportenService implements OnModuleDestroy {
  private readonly logger = new Logger(MaskinportenService.name);

  /** Baseline cap for the discovery cache and the token-cache floor. */
  private readonly MAX_CACHE_SIZE = 100;

  /**
   * Distinct token cacheKeys a single tenant can hold (4 single-scope tokens +
   * the all-scopes token, plus headroom for bespoke scope arrays). The token
   * cache is sized to the observed tenant population × this, so a deployment with
   * many tenants never FIFO-thrashes a still-valid token out of the cache
   * (FARM-MEDIUM-172).
   */
  private readonly TOKEN_SCOPE_COMBINATIONS = 8;

  /** Tenants that have requested a token this process — drives token-cache sizing. */
  private readonly seenTenants = new Set<string>();

  /**
   * In-flight token acquisitions keyed by cacheKey. Single-flight (FARM-MEDIUM-172):
   * when N concurrent callers miss the cache for the same tenant+scopes (e.g. a
   * rollover auto-submitting several drafts at once, or a cold cache under load),
   * only the FIRST performs the Maskinporten round-trip; the rest await the same
   * promise instead of stampeding the auth server with duplicate JWT-bearer grants.
   */
  private readonly inFlightTokens = new Map<string, Promise<string>>();

  /** TTL for token cache entries in milliseconds (1 hour) */
  private readonly TOKEN_CACHE_TTL = 3600000;

  /** TTL for discovery cache entries in milliseconds (24 hours) */
  private readonly DISCOVERY_CACHE_TTL = 86400000;

  /** Cleanup interval in milliseconds (5 minutes) */
  private readonly CLEANUP_INTERVAL = 300000;

  /** Token cache: Map<tenantId:scopes, CacheEntry<CachedToken>> */
  private tokenCache: Map<string, CacheEntry<CachedToken>> = new Map();

  /** Discovery cache per environment: Map<environment, CacheEntry<{ tokenEndpoint, issuer }>> */
  private discoveryCache: Map<string, CacheEntry<{ tokenEndpoint: string; issuer: string }>> =
    new Map();

  /** Interval for periodic cache cleanup */
  private cleanupInterval: ManagedInterval | null;

  constructor(
    private readonly configService: ConfigService,
    @Inject(RegulatorySettingsService)
    private readonly settingsService: RegulatorySettingsService,
    private readonly circuitBreaker: CircuitBreakerService,
  ) {
    // Start periodic cleanup to prevent memory leaks
    this.cleanupInterval = createManagedInterval(
      () => this.cleanupExpiredEntries(),
      this.CLEANUP_INTERVAL,
    );
  }

  /**
   * Lifecycle hook - clean up resources on module destroy
   */
  onModuleDestroy(): void {
    this.logger.debug('Cleaning up MaskinportenService resources');
    if (this.cleanupInterval) {
      clearManagedTimer(this.cleanupInterval);
      this.cleanupInterval = null;
    }
    this.tokenCache.clear();
    this.discoveryCache.clear();
    this.inFlightTokens.clear();
  }

  /**
   * Clean up expired entries from all caches
   */
  private cleanupExpiredEntries(): void {
    const now = Date.now();
    let tokenCleanedCount = 0;
    let discoveryCleanedCount = 0;

    for (const [key, entry] of this.tokenCache) {
      if (entry.expiresAt < now) {
        this.tokenCache.delete(key);
        tokenCleanedCount++;
      }
    }

    for (const [key, entry] of this.discoveryCache) {
      if (entry.expiresAt < now) {
        this.discoveryCache.delete(key);
        discoveryCleanedCount++;
      }
    }

    if (tokenCleanedCount > 0 || discoveryCleanedCount > 0) {
      this.logger.debug(
        `Cache cleanup: removed ${tokenCleanedCount} token entries and ${discoveryCleanedCount} discovery entries`,
      );
    }
  }

  /**
   * Set a cache entry with TTL and LRU size-limit enforcement. Eviction removes
   * the LEAST-RECENTLY-USED entry (the first key in insertion order, which
   * getCacheEntry re-inserts to the end on every hit), not merely the oldest
   * inserted — so an actively-used token is never thrown out from under a busy
   * tenant (FARM-MEDIUM-172). `maxSize` lets the token cache scale with the
   * tenant population while the discovery cache keeps the fixed baseline.
   */
  private setCacheEntry<T>(
    cache: Map<string, CacheEntry<T>>,
    key: string,
    data: T,
    ttl: number,
    maxSize: number = this.MAX_CACHE_SIZE,
  ): void {
    // Re-inserting an existing key must not count against the size check.
    cache.delete(key);
    while (cache.size >= maxSize) {
      const lruKey = cache.keys().next().value;
      if (lruKey === undefined) break;
      cache.delete(lruKey);
      this.logger.debug(`Cache size limit reached, evicted least-recently-used entry: ${lruKey}`);
    }
    cache.set(key, { data, expiresAt: Date.now() + ttl });
  }

  /**
   * Get a cache entry if it exists and is not expired. On a hit the entry is
   * re-inserted at the end of the Map so it becomes most-recently-used — this is
   * what makes eviction in setCacheEntry a true LRU rather than FIFO.
   */
  private getCacheEntry<T>(cache: Map<string, CacheEntry<T>>, key: string): T | null {
    const entry = cache.get(key);
    if (!entry) {
      return null;
    }
    if (entry.expiresAt < Date.now()) {
      cache.delete(key);
      return null;
    }
    // Mark most-recently-used: delete + re-set moves the key to the Map's tail.
    cache.delete(key);
    cache.set(key, entry);
    return entry.data;
  }

  /**
   * Current token-cache ceiling: the observed tenant population × the per-tenant
   * scope-combination count, floored at the baseline. Grows as new tenants appear
   * so a large fleet never evicts a valid token that is still in active rotation.
   */
  private tokenCacheMaxSize(): number {
    return Math.max(this.MAX_CACHE_SIZE, this.seenTenants.size * this.TOKEN_SCOPE_COMBINATIONS);
  }

  /**
   * Normalize private key (handle escaped newlines from env vars or textarea input)
   */
  private normalizePrivateKey(key: string): string {
    // Replace escaped newlines with actual newlines
    return key.replace(/\\n/g, '\n');
  }

  /**
   * Discover OAuth2 endpoints from well-known configuration
   */
  private async discoverEndpoints(
    environment: string,
  ): Promise<{ tokenEndpoint: string; issuer: string }> {
    // Check cache first
    const cached = this.getCacheEntry(this.discoveryCache, environment);
    if (cached) {
      return cached;
    }

    const envConfig =
      MASKINPORTEN_ENVIRONMENTS[environment as keyof typeof MASKINPORTEN_ENVIRONMENTS] ||
      MASKINPORTEN_ENVIRONMENTS.TEST;

    try {
      this.logger.debug(`Discovering Maskinporten endpoints for environment: ${environment}`);
      // Bounded deadline: a hung auth server must never hang the caller (or, via a
      // submission, the lock-held cron sweep). A timeout aborts into the catch and
      // surfaces as a transient failure the retry sweep replays.
      const response = await fetch(envConfig.wellKnownUrl, {
        signal: AbortSignal.timeout(MASKINPORTEN_HTTP_TIMEOUT_MS),
      });
      if (!response.ok) {
        throw new Error(`Failed to fetch well-known config: ${response.status}`);
      }

      const discovery = await response.json();
      const result = {
        tokenEndpoint: discovery.token_endpoint,
        issuer: discovery.issuer,
      };

      // Cache discovery result with TTL
      this.setCacheEntry(this.discoveryCache, environment, result, this.DISCOVERY_CACHE_TTL);
      this.logger.debug(`Discovered token endpoint: ${discovery.token_endpoint}`);

      return result;
    } catch (error) {
      const masked = maskAndTruncatePii(
        error instanceof Error ? error.message : String(error),
      );
      this.logger.error(`Failed to discover Maskinporten endpoints: ${masked ?? 'unknown error'}`);
      throw error;
    }
  }

  /**
   * Get an access token for a specific tenant and scopes
   * Uses tenant-specific credentials from RegulatorySettingsService
   *
   * @param tenantId - The tenant ID to get credentials for
   * @param scopes - OAuth2 scopes to request (defaults to all Mattilsynet scopes)
   */
  async getAccessToken(tenantId: string, scopes?: string[]): Promise<string> {
    const requestedScopes = scopes || ALL_MATTILSYNET_SCOPES;
    // Sort a COPY — sorting `scopes` in place would mutate the caller's array.
    const cacheKey = `${tenantId}:${[...requestedScopes].sort().join(' ')}`;

    // Fast path: a valid cached token, no round-trip, no single-flight.
    const cached = this.getCacheEntry(this.tokenCache, cacheKey);
    if (cached && this.isTokenValid(cached)) {
      this.logger.debug(`Using cached Maskinporten token for tenant: ${tenantId}`);
      return cached.accessToken;
    }

    // Single-flight: collapse concurrent misses for the same tenant+scopes onto
    // one acquisition so a burst never stampedes the Maskinporten token endpoint.
    const existing = this.inFlightTokens.get(cacheKey);
    if (existing) {
      this.logger.debug(`Joining in-flight Maskinporten token acquisition for tenant: ${tenantId}`);
      return existing;
    }

    const acquisition = this.acquireAndCacheToken(tenantId, requestedScopes, cacheKey).finally(
      () => {
        this.inFlightTokens.delete(cacheKey);
      },
    );
    this.inFlightTokens.set(cacheKey, acquisition);
    return acquisition;
  }

  /**
   * Perform the actual Maskinporten acquisition (credentials → discovery → token)
   * and cache the result. Serialised per cacheKey by getAccessToken's
   * single-flight map, so at most one of these runs concurrently per tenant+scope.
   */
  private async acquireAndCacheToken(
    tenantId: string,
    requestedScopes: string[],
    cacheKey: string,
  ): Promise<string> {
    this.seenTenants.add(tenantId);

    // Get tenant credentials
    const clientId = await this.settingsService.getDecryptedClientId(tenantId);
    const privateKey = await this.settingsService.getDecryptedPrivateKey(tenantId);
    const config = await this.settingsService.getMaskinportenConfig(tenantId);

    if (!clientId || !privateKey) {
      throw new Error(
        'Maskinporten not configured for this tenant. Please configure credentials in Setup > Company & Regulatory.',
      );
    }

    const environment = config?.environment || 'TEST';

    // Discover endpoints for this environment. Discovery is env-shared (cached
    // 24h), so its breaker uses the global key; a discovery outage is not tenant-
    // specific.
    const discovery = await this.circuitBreaker.execute({
      serviceName: 'maskinporten-discovery',
      fn: () => this.discoverEndpoints(environment),
      options: MASKINPORTEN_BREAKER_OPTIONS,
    });

    // Request new token — PER-TENANT breaker so one tenant's bad credentials
    // (steady 401/403) cannot trip the auth breaker for every other tenant.
    this.logger.debug(
      `Requesting new Maskinporten token for tenant ${tenantId}, scopes: ${requestedScopes.join(', ')}`,
    );
    const token = await this.circuitBreaker.execute({
      serviceName: 'maskinporten-token',
      tenantId,
      fn: () =>
        this.requestTokenWithCredentials(
          clientId,
          this.normalizePrivateKey(privateKey),
          config?.keyId || undefined,
          discovery,
          requestedScopes,
        ),
      options: MASKINPORTEN_BREAKER_OPTIONS,
    });

    // Cache the token with TTL based on token expiration (with 1 min buffer).
    // The token cache is LRU and sized to the tenant population so a large fleet
    // never evicts a still-valid token that is in active rotation.
    const tokenTtl = Math.min((token.expires_in - 60) * 1000, this.TOKEN_CACHE_TTL);
    const expiresAt = new Date(Date.now() + tokenTtl);
    const cachedToken: CachedToken = {
      accessToken: token.access_token,
      expiresAt,
      scopes: requestedScopes,
    };
    this.setCacheEntry(this.tokenCache, cacheKey, cachedToken, tokenTtl, this.tokenCacheMaxSize());

    return token.access_token;
  }

  /**
   * Check if a cached token is still valid
   */
  private isTokenValid(cached: CachedToken): boolean {
    return cached.expiresAt > new Date();
  }

  /**
   * Request a new access token from Maskinporten using provided credentials
   */
  private async requestTokenWithCredentials(
    clientId: string,
    privateKeyPem: string,
    keyId: string | undefined,
    discovery: { tokenEndpoint: string; issuer: string },
    scopes: string[],
  ): Promise<TokenResponse> {
    // Create JWT assertion
    const assertion = this.createJwtAssertionWithCredentials(
      clientId,
      privateKeyPem,
      keyId,
      discovery.issuer,
      scopes,
    );

    // Request token — bounded deadline (see discoverEndpoints).
    const response = await fetch(discovery.tokenEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion,
      }),
      signal: AbortSignal.timeout(MASKINPORTEN_HTTP_TIMEOUT_MS),
    });

    if (!response.ok) {
      // SEC-MEDIUM-004: the Maskinporten token-endpoint error body can carry
      // sensitive OAuth detail — mask + bound it before it reaches the log
      // stream OR the thrown message (which is re-logged upstream).
      const errorText = maskAndTruncatePii(await response.text()) ?? '';
      this.logger.error(`Token request failed: ${response.status} - ${errorText}`);
      throw new Error(`Maskinporten token request failed: ${response.status} - ${errorText}`);
    }

    return response.json();
  }

  /**
   * Create a signed JWT assertion for the token request
   */
  private createJwtAssertionWithCredentials(
    clientId: string,
    privateKeyPem: string,
    keyId: string | undefined,
    issuer: string,
    scopes: string[],
  ): string {
    const now = Math.floor(Date.now() / 1000);
    const jti = crypto.randomUUID();

    const payload = {
      aud: issuer,
      iss: clientId,
      scope: scopes.join(' '),
      iat: now,
      exp: now + 120, // 2 minutes validity
      jti,
    };

    const header: jwt.JwtHeader = {
      alg: 'RS256',
      typ: 'JWT',
    };

    if (keyId) {
      header.kid = keyId;
    }

    return jwt.sign(payload, privateKeyPem, {
      algorithm: 'RS256',
      header,
    });
  }

  /**
   * Get a token specifically for Sea Lice reporting
   */
  async getSeaLiceToken(tenantId: string): Promise<string> {
    return this.getAccessToken(tenantId, [MATTILSYNET_SCOPES.SEA_LICE]);
  }

  /**
   * Get a token specifically for Cleaner Fish reporting
   */
  async getCleanerFishToken(tenantId: string): Promise<string> {
    return this.getAccessToken(tenantId, [MATTILSYNET_SCOPES.CLEANER_FISH]);
  }

  /**
   * Get a token specifically for Smolt reporting
   */
  async getSmoltToken(tenantId: string): Promise<string> {
    return this.getAccessToken(tenantId, [MATTILSYNET_SCOPES.SMOLT]);
  }

  /**
   * Get a token specifically for Slaughter reporting
   */
  async getSlaughterToken(tenantId: string): Promise<string> {
    return this.getAccessToken(tenantId, [MATTILSYNET_SCOPES.SLAUGHTER]);
  }

  /**
   * Get a token for all Mattilsynet scopes
   */
  async getAllMattilsynetToken(tenantId: string): Promise<string> {
    return this.getAccessToken(tenantId, ALL_MATTILSYNET_SCOPES);
  }

  /**
   * Clear the token cache for a specific tenant
   */
  clearTenantCache(tenantId: string): void {
    const keysToDelete: string[] = [];
    for (const key of this.tokenCache.keys()) {
      if (key.startsWith(`${tenantId}:`)) {
        keysToDelete.push(key);
      }
    }
    keysToDelete.forEach((key) => this.tokenCache.delete(key));
    this.logger.debug(`Token cache cleared for tenant: ${tenantId}`);
  }

  /**
   * Clear entire token cache (useful for testing)
   */
  clearCache(): void {
    this.tokenCache.clear();
    this.discoveryCache.clear();
    this.logger.debug('All caches cleared');
  }

  /**
   * Get cache statistics (useful for monitoring/debugging)
   */
  getCacheStats(): { tokenCacheSize: number; discoveryCacheSize: number } {
    return {
      tokenCacheSize: this.tokenCache.size,
      discoveryCacheSize: this.discoveryCache.size,
    };
  }

  /**
   * Check if a tenant has Maskinporten configured
   */
  async isConfiguredForTenant(tenantId: string): Promise<boolean> {
    return this.settingsService.isConfigured(tenantId);
  }

  /**
   * Get current configuration status (for health checks)
   * Note: This returns global status since tenant-specific check needs tenantId
   */
  getStatus(): {
    configured: boolean;
    environment: string;
    scopes: string[];
    tokenEndpoint?: string;
    cacheStats?: { tokenCacheSize: number; discoveryCacheSize: number };
  } {
    const defaultEnv = this.configService.get<string>('MASKINPORTEN_ENV', 'TEST');
    const discovery = this.getCacheEntry(this.discoveryCache, defaultEnv);

    return {
      configured: false, // Always false - use isConfiguredForTenant() for tenant-specific check
      environment: defaultEnv,
      scopes: ALL_MATTILSYNET_SCOPES,
      tokenEndpoint: discovery?.tokenEndpoint,
      cacheStats: this.getCacheStats(),
    };
  }

  /**
   * Check if the service is configured (legacy - always returns false, use isConfiguredForTenant)
   * @deprecated Use isConfiguredForTenant(tenantId) instead
   */
  isConfigured(): boolean {
    return false;
  }
}
