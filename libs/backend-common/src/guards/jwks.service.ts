import * as crypto from 'crypto';

import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';

import { clearManagedTimer, createManagedInterval, type ManagedInterval } from '../utils';

/**
 * JSON Web Key interface for RSA keys.
 */
export interface JwkKey {
  kty: string;
  n: string;
  e: string;
  kid: string;
  use?: string;
  alg?: string;
  [key: string]: unknown;
}

/**
 * JWKS response shape from /.well-known/jwks.json
 */
export interface JwksResponse {
  keys: JwkKey[];
}

/**
 * Cached key entry with timestamp.
 */
interface CachedKey {
  publicKey: crypto.KeyObject;
  pem: string;
  fetchedAt: number;
}

/**
 * JwksService — Fetches and caches public keys from a JWKS endpoint.
 *
 * Used by the gateway (and optionally other services) to verify RS256 JWTs
 * using public keys published by auth-service's /.well-known/jwks.json endpoint.
 *
 * Features:
 * - Caches keys with configurable TTL (default: 1 hour)
 * - Auto-refreshes on cache miss (handles key rotation transparently)
 * - Thread-safe refresh (deduplicates concurrent fetch requests)
 */
@Injectable()
export class JwksService implements OnModuleDestroy {
  private readonly logger = new Logger(JwksService.name);
  private readonly cache = new Map<string, CachedKey>();
  private cacheTtlMs: number;
  private jwksUrl: string;
  private pendingFetch: Promise<void> | null = null;
  private refreshTimer: ManagedInterval | null = null;

  constructor() {
    // Defaults — configure via init()
    this.cacheTtlMs = 60 * 60 * 1000; // 1 hour
    this.jwksUrl = '';
  }

  /**
   * Initialize the JWKS service with configuration.
   * Call this once during module setup.
   */
  init(jwksUrl: string, cacheTtlMs?: number): void {
    this.jwksUrl = jwksUrl;
    if (cacheTtlMs !== undefined) {
      this.cacheTtlMs = cacheTtlMs;
    }

    this.logger.log(`JWKS service initialized: url=${jwksUrl}, cacheTtl=${this.cacheTtlMs}ms`);

    clearManagedTimer(this.refreshTimer);

    // Proactive background refresh at 75% of TTL
    const refreshInterval = Math.floor(this.cacheTtlMs * 0.75);
    this.refreshTimer = createManagedInterval(() => {
      void this.refreshKeys().catch((err) =>
        this.logger.warn(`Background JWKS refresh failed: ${(err as Error).message}`),
      );
    }, refreshInterval);
  }

  onModuleDestroy(): void {
    clearManagedTimer(this.refreshTimer);
    this.refreshTimer = null;
  }

  /**
   * Get the signing key (as PEM string) for a given key ID.
   * If not cached or cache expired, fetches from JWKS endpoint.
   *
   * @param kid - The key ID from the JWT header
   * @returns PEM-encoded public key string
   * @throws Error if key not found after refresh
   */
  async getSigningKey(kid: string): Promise<string> {
    // Check cache first
    const cached = this.cache.get(kid);
    if (cached && Date.now() - cached.fetchedAt < this.cacheTtlMs) {
      return cached.pem;
    }

    // Cache miss or expired — refresh
    await this.refreshKeys();

    const refreshed = this.cache.get(kid);
    if (!refreshed) {
      throw new Error(`Signing key not found for kid: ${kid}`);
    }

    return refreshed.pem;
  }

  /**
   * Get all cached key IDs (useful for debugging).
   */
  getCachedKeyIds(): string[] {
    return Array.from(this.cache.keys());
  }

  /**
   * Force refresh keys from JWKS endpoint.
   * Deduplicates concurrent calls.
   */
  async refreshKeys(): Promise<void> {
    if (!this.jwksUrl) {
      throw new Error('JWKS service not initialized. Call init() first.');
    }

    // Deduplicate concurrent fetches
    if (this.pendingFetch) {
      return this.pendingFetch;
    }

    this.pendingFetch = this.doFetch();
    try {
      await this.pendingFetch;
    } finally {
      this.pendingFetch = null;
    }
  }

  /**
   * Internal fetch implementation.
   */
  private async doFetch(): Promise<void> {
    try {
      this.logger.debug(`Fetching JWKS from ${this.jwksUrl}`);

      const response = await fetch(this.jwksUrl, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(10000), // 10s timeout
      });

      if (!response.ok) {
        throw new Error(`JWKS fetch failed: HTTP ${response.status}`);
      }

      const jwks = (await response.json()) as JwksResponse;

      if (!jwks.keys || !Array.isArray(jwks.keys)) {
        throw new Error('Invalid JWKS response: missing keys array');
      }

      const now = Date.now();

      for (const jwk of jwks.keys) {
        if (!jwk.kid || jwk.kty !== 'RSA') {
          continue;
        }

        try {
          const publicKey = crypto.createPublicKey({ key: jwk, format: 'jwk' });
          const pem = publicKey.export({ type: 'spki', format: 'pem' }) as string;

          this.cache.set(jwk.kid, {
            publicKey,
            pem,
            fetchedAt: now,
          });
        } catch (err) {
          this.logger.warn(`Failed to import JWK kid=${jwk.kid}: ${(err as Error).message}`);
        }
      }

      this.logger.debug(`JWKS refreshed: ${jwks.keys.length} key(s) loaded`);
    } catch (error) {
      this.logger.error(`Failed to fetch JWKS from ${this.jwksUrl}: ${(error as Error).message}`);
      // Don't clear cache on fetch failure — stale keys are better than no keys
      throw error;
    }
  }
}
