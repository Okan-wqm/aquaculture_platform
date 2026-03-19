import { Controller, Get, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';
import * as fs from 'fs';
import { Public } from '@platform/backend-common';

/**
 * JWKS (JSON Web Key Set) Controller
 *
 * Exposes the public key(s) used for RS256 JWT verification in standard JWKS format.
 * This endpoint is publicly accessible (no auth required) so that any service
 * can fetch the public keys to verify tokens signed by auth-service.
 *
 * Supports key rotation: both current and previous keys can be served simultaneously.
 *
 * @see https://datatracker.ietf.org/doc/html/rfc7517
 */
@Controller()
export class JwksController {
  private readonly logger = new Logger(JwksController.name);
  private cachedJwks: { keys: JsonWebKey[] } | null = null;

  constructor(private readonly configService: ConfigService) {}

  /**
   * GET /.well-known/jwks.json
   *
   * Returns the public keys in JWKS format for JWT verification.
   * No authentication required — this is a public endpoint.
   */
  @Get('.well-known/jwks.json')
  @Public()
  getJwks(): { keys: JsonWebKey[] } {
    if (this.cachedJwks) {
      return this.cachedJwks;
    }

    const keys: JsonWebKey[] = [];

    // Load current public key
    const currentKey = this.loadPublicKeyJwk(
      this.configService.get<string>('JWT_PUBLIC_KEY'),
      this.configService.get<string>('JWT_PUBLIC_KEY_FILE'),
      this.configService.get<string>('JWT_KEY_ID', 'key-1'),
    );

    if (currentKey) {
      keys.push(currentKey);
    }

    // Load previous public key for rotation support
    const previousKey = this.loadPublicKeyJwk(
      this.configService.get<string>('JWT_PREVIOUS_PUBLIC_KEY'),
      this.configService.get<string>('JWT_PREVIOUS_PUBLIC_KEY_FILE'),
      this.configService.get<string>('JWT_PREVIOUS_KEY_ID'),
    );

    if (previousKey) {
      keys.push(previousKey);
    }

    if (keys.length === 0) {
      this.logger.warn(
        'No RS256 public keys configured. JWKS endpoint returns empty key set. ' +
        'Set JWT_PUBLIC_KEY or JWT_PUBLIC_KEY_FILE to enable RS256 verification.',
      );
    }

    this.cachedJwks = { keys };
    return this.cachedJwks;
  }

  /**
   * Convert an RSA public key PEM to JWK format.
   */
  private loadPublicKeyJwk(
    pemContent: string | undefined,
    pemFilePath: string | undefined,
    keyId: string | undefined,
  ): JsonWebKey | null {
    let pem = pemContent;

    // Load from file if inline not provided
    if (!pem && pemFilePath) {
      try {
        pem = fs.readFileSync(pemFilePath, 'utf-8');
      } catch (error) {
        this.logger.warn(`Failed to read public key file ${pemFilePath}: ${(error as Error).message}`);
        return null;
      }
    }

    if (!pem) {
      return null;
    }

    if (!keyId) {
      return null;
    }

    try {
      const publicKey = crypto.createPublicKey(pem);
      const jwk = publicKey.export({ format: 'jwk' }) as JsonWebKey;

      return {
        ...jwk,
        kid: keyId,
        use: 'sig',
        alg: 'RS256',
      };
    } catch (error) {
      this.logger.error(`Failed to convert public key to JWK: ${(error as Error).message}`);
      return null;
    }
  }
}

/**
 * Standard JSON Web Key interface (subset relevant for RSA).
 */
interface JsonWebKey {
  kty?: string;
  n?: string;
  e?: string;
  kid?: string;
  use?: string;
  alg?: string;
  [key: string]: unknown;
}
