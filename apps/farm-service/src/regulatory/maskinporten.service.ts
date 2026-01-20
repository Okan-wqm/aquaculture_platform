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

import { Injectable, Logger, Inject, forwardRef } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as jwt from 'jsonwebtoken';
import * as crypto from 'crypto';
import { RegulatorySettingsService } from './regulatory-settings.service';

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
export class MaskinportenService {
  private readonly logger = new Logger(MaskinportenService.name);

  /** Token cache: Map<tenantId:scopes, CachedToken> */
  private tokenCache: Map<string, CachedToken> = new Map();

  /** Discovery cache per environment: Map<environment, { tokenEndpoint, issuer }> */
  private discoveryCache: Map<string, { tokenEndpoint: string; issuer: string }> = new Map();

  constructor(
    private readonly configService: ConfigService,
    @Inject(forwardRef(() => RegulatorySettingsService))
    private readonly settingsService: RegulatorySettingsService,
  ) {}

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
  private async discoverEndpoints(environment: string): Promise<{ tokenEndpoint: string; issuer: string }> {
    // Check cache first
    const cached = this.discoveryCache.get(environment);
    if (cached) {
      return cached;
    }

    const envConfig = MASKINPORTEN_ENVIRONMENTS[environment as keyof typeof MASKINPORTEN_ENVIRONMENTS]
      || MASKINPORTEN_ENVIRONMENTS.TEST;

    try {
      this.logger.debug(`Discovering Maskinporten endpoints for environment: ${environment}`);
      const response = await fetch(envConfig.wellKnownUrl);
      if (!response.ok) {
        throw new Error(`Failed to fetch well-known config: ${response.status}`);
      }

      const discovery = await response.json();
      const result = {
        tokenEndpoint: discovery.token_endpoint,
        issuer: discovery.issuer,
      };

      // Cache discovery result
      this.discoveryCache.set(environment, result);
      this.logger.debug(`Discovered token endpoint: ${discovery.token_endpoint}`);

      return result;
    } catch (error) {
      this.logger.error(`Failed to discover Maskinporten endpoints: ${error}`);
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
    // Get tenant credentials
    const clientId = await this.settingsService.getDecryptedClientId(tenantId);
    const privateKey = await this.settingsService.getDecryptedPrivateKey(tenantId);
    const config = await this.settingsService.getMaskinportenConfig(tenantId);

    if (!clientId || !privateKey) {
      throw new Error('Maskinporten not configured for this tenant. Please configure credentials in Setup > Company & Regulatory.');
    }

    const requestedScopes = scopes || ALL_MATTILSYNET_SCOPES;
    const environment = config?.environment || 'TEST';
    const cacheKey = `${tenantId}:${requestedScopes.sort().join(' ')}`;

    // Check cache
    const cached = this.tokenCache.get(cacheKey);
    if (cached && this.isTokenValid(cached)) {
      this.logger.debug(`Using cached Maskinporten token for tenant: ${tenantId}`);
      return cached.accessToken;
    }

    // Discover endpoints for this environment
    const discovery = await this.discoverEndpoints(environment);

    // Request new token
    this.logger.debug(`Requesting new Maskinporten token for tenant ${tenantId}, scopes: ${requestedScopes.join(', ')}`);
    const token = await this.requestTokenWithCredentials(
      clientId,
      this.normalizePrivateKey(privateKey),
      config?.keyId || undefined,
      discovery,
      requestedScopes,
    );

    // Cache the token
    const expiresAt = new Date(Date.now() + (token.expires_in - 60) * 1000); // 1 min buffer
    this.tokenCache.set(cacheKey, {
      accessToken: token.access_token,
      expiresAt,
      scopes: requestedScopes,
    });

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

    // Request token
    const response = await fetch(discovery.tokenEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
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
    this.tokenCache.forEach((_, key) => {
      if (key.startsWith(`${tenantId}:`)) {
        keysToDelete.push(key);
      }
    });
    keysToDelete.forEach(key => this.tokenCache.delete(key));
    this.logger.debug(`Token cache cleared for tenant: ${tenantId}`);
  }

  /**
   * Clear entire token cache (useful for testing)
   */
  clearCache(): void {
    this.tokenCache.clear();
    this.logger.debug('All token cache cleared');
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
  } {
    const defaultEnv = this.configService.get<string>('MASKINPORTEN_ENV', 'TEST');
    const discovery = this.discoveryCache.get(defaultEnv);

    return {
      configured: false, // Always false - use isConfiguredForTenant() for tenant-specific check
      environment: defaultEnv,
      scopes: ALL_MATTILSYNET_SCOPES,
      tokenEndpoint: discovery?.tokenEndpoint,
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
