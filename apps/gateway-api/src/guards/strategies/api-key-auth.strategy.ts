/**
 * API Key Authentication Strategy
 *
 * Validates API key authentication using HMAC-SHA256 with timing-safe comparison.
 * Supports legacy SHA-256 hashes during migration period.
 *
 * SECURITY (H-09): API key hashing upgraded from plain SHA-256 to HMAC-SHA256
 * with a server-side secret (API_KEY_HMAC_SECRET). Timing-safe comparison is
 * used for all hash lookups to prevent side-channel attacks. Legacy SHA-256
 * is supported during the migration period.
 */

import * as crypto from 'crypto';

import {
  Injectable,
  UnauthorizedException,
  Logger,
  Inject,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { AuthenticatedRequest, ApiKeyInfo } from '../../types/index';

/**
 * API Key Authentication Strategy
 * Handles validation of API key credentials from request headers
 *
 * NOTE: Explicit @Inject() decorators are required because Nx webpack (SWC loader)
 * strips TypeScript emitDecoratorMetadata (design:paramtypes) during bundling.
 * Without explicit @Inject(), NestJS cannot resolve constructor dependencies at runtime.
 */
@Injectable()
export class ApiKeyAuthStrategy {
  private readonly logger = new Logger(ApiKeyAuthStrategy.name);
  private readonly apiKeys: Map<string, ApiKeyInfo>;

  constructor(@Inject(ConfigService) private readonly configService: ConfigService) {
    this.apiKeys = new Map();
    this.loadApiKeys();
  }

  /**
   * Validate API key from request
   *
   * SECURITY: API keys must only be accepted from headers, never from query parameters.
   * Query parameters are logged, cached, and visible in browser history.
   *
   * @param request - The incoming HTTP request
   * @returns true if the API key is valid and active
   * @throws {UnauthorizedException} If the API key is missing, invalid, disabled, or expired
   */
  validate(request: AuthenticatedRequest): boolean {
    // SECURITY: Only accept API key from x-api-key header
    // Never from query parameters (would be exposed in logs, URLs, referrer headers)
    const apiKey = request.headers['x-api-key'] as string;

    if (!apiKey) {
      throw new UnauthorizedException({
        code: 'MISSING_API_KEY',
        message: 'API key is required. Use x-api-key header.',
      });
    }

    const keyInfo = this.findApiKeyInfo(apiKey);

    if (!keyInfo) {
      throw new UnauthorizedException({
        code: 'INVALID_API_KEY',
        message: 'Invalid API key',
      });
    }

    if (!keyInfo.active) {
      throw new UnauthorizedException({
        code: 'API_KEY_DISABLED',
        message: 'API key is disabled',
      });
    }

    if (keyInfo.expiresAt && keyInfo.expiresAt < new Date()) {
      throw new UnauthorizedException({
        code: 'API_KEY_EXPIRED',
        message: 'API key has expired',
      });
    }

    // Attach API key info to request
    request.apiKey = apiKey;
    request.authMethod = 'api_key';
    request.user = {
      sub: keyInfo.userId,
      tenantId: keyInfo.tenantId,
      roles: keyInfo.roles,
      permissions: keyInfo.permissions,
      type: 'access',
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 3600,
    };

    return true;
  }

  /**
   * Hash an API key using HMAC-SHA256 with a server-side secret.
   *
   * SECURITY (H-09): Plain SHA-256 hashing of API keys is vulnerable because
   * an attacker who obtains the hashed key database can run offline brute-force
   * or rainbow-table attacks without knowing a secret. HMAC-SHA256 binds the
   * hash to a server-side secret (`API_KEY_HMAC_SECRET` env var), so the
   * attacker must also compromise the secret to mount an offline attack.
   *
   * During the migration period, both the new HMAC-SHA256 format and the legacy
   * SHA-256 format are checked (see {@link findApiKeyInfo}). Once all stored
   * keys have been re-hashed with HMAC, the legacy path should be removed.
   *
   * @param key - The raw API key to hash
   * @returns HMAC-SHA256 hex digest prefixed with `hmac:` to distinguish from legacy hashes
   */
  private hashApiKey(key: string): string {
    const hmacSecret = this.configService.get<string>('API_KEY_HMAC_SECRET', '');
    if (hmacSecret) {
      return 'hmac:' + crypto.createHmac('sha256', hmacSecret).update(key).digest('hex');
    }
    // Fallback to legacy SHA-256 when HMAC secret is not configured (dev/migration)
    return crypto.createHash('sha256').update(key).digest('hex');
  }

  /**
   * Hash an API key using the legacy unsalted SHA-256 algorithm.
   *
   * SECURITY: This method exists solely for backward compatibility during the
   * migration period from plain SHA-256 to HMAC-SHA256. It MUST be removed
   * once all API keys in the store have been re-hashed with the HMAC scheme.
   *
   * @param key - The raw API key to hash
   * @returns Plain SHA-256 hex digest (legacy format, no prefix)
   */
  private legacyHashApiKey(key: string): string {
    return crypto.createHash('sha256').update(key).digest('hex');
  }

  /**
   * Look up API key info using timing-safe comparison.
   *
   * SECURITY (H-09): Tries the new HMAC-SHA256 hash first, then falls back to
   * the legacy SHA-256 hash for backward compatibility during migration.
   * Uses `crypto.timingSafeEqual` to prevent timing side-channel attacks that
   * could reveal partial hash matches.
   *
   * @param rawKey - The raw API key from the request header
   * @returns The matching ApiKeyInfo, or undefined if no match
   */
  private findApiKeyInfo(rawKey: string): ApiKeyInfo | undefined {
    const hmacHash = this.hashApiKey(rawKey);
    const legacyHash = this.legacyHashApiKey(rawKey);

    for (const [storedHash, info] of this.apiKeys.entries()) {
      const storedBuf = Buffer.from(storedHash, 'utf8');
      const hmacBuf = Buffer.from(hmacHash, 'utf8');
      const legacyBuf = Buffer.from(legacyHash, 'utf8');

      // Try HMAC-SHA256 match (new format, prefixed with 'hmac:')
      if (storedBuf.length === hmacBuf.length) {
        if (crypto.timingSafeEqual(storedBuf, hmacBuf)) {
          return info;
        }
      }

      // Try legacy SHA-256 match (migration period backward compatibility)
      if (storedBuf.length === legacyBuf.length) {
        if (crypto.timingSafeEqual(storedBuf, legacyBuf)) {
          this.logger.warn(
            'API key matched via legacy SHA-256 hash. Re-hash with HMAC-SHA256 recommended.',
          );
          return info;
        }
      }
    }

    return undefined;
  }

  /**
   * Load API keys from configuration
   */
  private loadApiKeys(): void {
    const keysConfig = this.configService.get<string>('API_KEYS', '');
    if (!keysConfig) return;

    try {
      const keys = JSON.parse(keysConfig) as ApiKeyInfo[];
      for (const key of keys) {
        const hashedKey = this.hashApiKey(key.key || '');
        this.apiKeys.set(hashedKey, key);
      }
    } catch {
      this.logger.warn('Failed to parse API keys config');
    }
  }
}
