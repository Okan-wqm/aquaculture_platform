import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs';

const logger = new Logger('JwtKeyUtil');

/**
 * Load a PEM key from either an env var (inline PEM) or a file path env var.
 *
 * @param configService - NestJS ConfigService
 * @param envVar - Environment variable name for inline PEM content
 * @param fileEnvVar - Environment variable name for PEM file path
 * @returns PEM string or undefined if neither is configured
 */
export function loadPemKey(
  configService: ConfigService,
  envVar: string,
  fileEnvVar: string,
): string | undefined {
  // Try inline PEM first
  const inline = configService.get<string>(envVar);
  if (inline) {
    return inline;
  }

  // Try file path
  const filePath = configService.get<string>(fileEnvVar);
  if (filePath) {
    try {
      return fs.readFileSync(filePath, 'utf-8');
    } catch (error) {
      logger.warn(`Failed to read key file ${filePath}: ${(error as Error).message}`);
    }
  }

  return undefined;
}

/**
 * Build JwtModule configuration options that support RS256 (asymmetric) with
 * backward-compatible fallback to HS256 (symmetric).
 *
 * For auth-service (signs tokens):
 *   - Uses privateKey + RS256 if JWT_PRIVATE_KEY / JWT_PRIVATE_KEY_FILE is set
 *   - Falls back to secret + HS256 (JWT_SECRET) otherwise
 *
 * For all other services (verify only):
 *   - Uses publicKey + RS256 if JWT_PUBLIC_KEY / JWT_PUBLIC_KEY_FILE is set
 *   - Falls back to secret + HS256 (JWT_SECRET) otherwise
 *
 * @param configService - NestJS ConfigService
 * @param mode - 'sign' for auth-service (needs private key), 'verify' for all others
 */
export function buildJwtModuleOptions(
  configService: ConfigService,
  mode: 'sign' | 'verify',
): Record<string, unknown> {
  if (mode === 'sign') {
    // Auth-service: try RS256 signing with private key
    const privateKey = loadPemKey(configService, 'JWT_PRIVATE_KEY', 'JWT_PRIVATE_KEY_FILE');
    const publicKey = loadPemKey(configService, 'JWT_PUBLIC_KEY', 'JWT_PUBLIC_KEY_FILE');

    if (privateKey) {
      const keyId = configService.get<string>('JWT_KEY_ID', 'key-1');
      logger.log('RS256 mode: using private key for JWT signing');

      return {
        privateKey,
        ...(publicKey ? { publicKey } : {}),
        signOptions: {
          algorithm: 'RS256' as const,
          expiresIn: configService.get('JWT_EXPIRES_IN', '15m'),
          issuer: configService.get('JWT_ISSUER', 'aquaculture-platform'),
          audience: configService.get('JWT_AUDIENCE', 'aquaculture-platform'),
          keyid: keyId,
        },
        verifyOptions: {
          algorithms: ['RS256', 'HS256'] as const,
        },
      };
    }

    // Fallback: HS256 with secret
    logger.warn('RS256 not configured: JWT_PRIVATE_KEY not set. Falling back to HS256 (JWT_SECRET).');
    return {}; // Return empty — caller handles HS256 config
  }

  // Verify mode (all non-auth services)
  const publicKey = loadPemKey(configService, 'JWT_PUBLIC_KEY', 'JWT_PUBLIC_KEY_FILE');

  if (publicKey) {
    logger.log('RS256 mode: using public key for JWT verification');
    return {
      publicKey,
      verifyOptions: {
        algorithms: ['RS256', 'HS256'] as const,
      },
    };
  }

  // Fallback: HS256 with secret
  logger.debug('RS256 not configured: JWT_PUBLIC_KEY not set. Using HS256 (JWT_SECRET).');
  return {}; // Return empty — caller handles HS256 config
}
