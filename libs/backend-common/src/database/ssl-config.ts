import { readFileSync } from 'fs';

import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

const logger = new Logger('DatabaseSSL');

/**
 * SSL configuration result for TypeORM DataSource options.
 * Returns `false` when SSL is disabled, or a TLS options object when enabled.
 */
export type SslConfigResult = false | { rejectUnauthorized: boolean; ca?: Buffer };

/**
 * Build a standardised SSL configuration for TypeORM/pg from environment variables.
 *
 * Environment variables consumed:
 *   DATABASE_SSL              – "true" to enable SSL (default: "false")
 *   DATABASE_SSL_CA           – Filesystem path to a PEM-encoded CA certificate
 *   DATABASE_SSL_REJECT_UNAUTHORIZED – "true" (default) to verify server certificate
 *
 * Behaviour:
 *   1. DATABASE_SSL !== "true"        -> returns false (no SSL)
 *   2. DATABASE_SSL === "true" + CA   -> { rejectUnauthorized, ca }
 *   3. DATABASE_SSL === "true" no CA  -> { rejectUnauthorized }
 *   4. Production + no verification + no CA -> throws (MITM risk)
 */
export function buildDatabaseSslConfig(configService: ConfigService): SslConfigResult {
  const sslEnabled = configService.get<string>('DATABASE_SSL', 'false') === 'true';
  if (!sslEnabled) return false;

  const isProduction = configService.get<string>('NODE_ENV') === 'production';
  const caPath = configService.get<string>('DATABASE_SSL_CA');
  const rejectUnauthorized =
    configService.get<string>('DATABASE_SSL_REJECT_UNAUTHORIZED', 'true') !== 'false';

  // CRITICAL: In production, reject disabled verification without a CA cert
  if (isProduction && !rejectUnauthorized && !caPath) {
    throw new Error(
      'SECURITY: SSL certificate verification is disabled in production without a CA certificate. ' +
        'This exposes the connection to MITM attacks. ' +
        'Set DATABASE_SSL_CA or set DATABASE_SSL_REJECT_UNAUTHORIZED=true.',
    );
  }

  // Warn in non-production when verification is off
  if (!isProduction && !rejectUnauthorized) {
    logger.warn(
      'SSL certificate verification is disabled (DATABASE_SSL_REJECT_UNAUTHORIZED=false). ' +
        'Acceptable for development/staging with self-signed certs only.',
    );
  }

  const sslConfig: { rejectUnauthorized: boolean; ca?: Buffer } = { rejectUnauthorized };

  if (caPath) {
    try {
      sslConfig.ca = readFileSync(caPath);
      logger.log(`Loaded CA certificate from ${caPath}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to read DATABASE_SSL_CA file at "${caPath}": ${message}`);
    }
  } else if (rejectUnauthorized) {
    logger.warn(
      'DATABASE_SSL_CA is not set — the system CA bundle will be used for verification. ' +
        'Set DATABASE_SSL_CA for explicit control.',
    );
  }

  return sslConfig;
}
