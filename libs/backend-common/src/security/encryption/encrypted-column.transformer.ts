import * as crypto from 'crypto';

import { Logger } from '@nestjs/common';
import { ValueTransformer } from 'typeorm';

/**
 * AES-256-GCM encryption algorithm.
 * GCM provides both confidentiality and integrity (authenticated encryption).
 */
const ALGORITHM = 'aes-256-gcm';

/** Initialization vector length in bytes. */
const IV_LENGTH = 16;

/** Prefix to identify encrypted values (enables backward compat with plaintext). */
const ENCRYPTED_PREFIX = 'enc:';

/** AES-256 key must be exactly 32 bytes. */
const KEY_LENGTH = 32;

/** Deterministic dev-only key -- never used in production. */
const DEV_FALLBACK_KEY = 'd'.repeat(KEY_LENGTH);

const logger = new Logger('EncryptedColumn');

/**
 * Resolved encryption key buffer, lazily initialized from env var.
 * Shared across all EncryptedColumnTransformer instances for the same key name.
 */
const keyCache = new Map<string, Buffer>();

/**
 * Resolve the encryption key from environment variable.
 * Supports hex-encoded 32-byte key (64 hex chars) or raw 32-char ASCII key.
 *
 * @param envVarName Environment variable name holding the key
 * @returns Buffer with the 32-byte encryption key
 */
function resolveKey(envVarName: string): Buffer {
  const cached = keyCache.get(envVarName);
  if (cached) return cached;

  const rawKey = process.env[envVarName];
  const nodeEnv = process.env['NODE_ENV'];
  // SEC-MEDIUM-003: the insecure dev-fallback key must be opt-in via a KNOWN
  // development environment, not merely "NODE_ENV is not the string 'production'".
  // The old gate silently used the fallback in staging, in CI with an unset
  // NODE_ENV, and under any typo'd env value — encrypting real Maskinporten
  // secrets / PII with a public `dddd…` key. Fail closed everywhere except an
  // explicit development/test env.
  const isRecognizedDevEnv = nodeEnv === 'development' || nodeEnv === 'test';

  if (!rawKey) {
    if (!isRecognizedDevEnv) {
      throw new Error(
        `[EncryptedColumn] ${envVarName} environment variable is required unless NODE_ENV is ` +
          `explicitly 'development' or 'test' (got '${nodeEnv ?? 'unset'}'). Set a 32-byte ` +
          '(64 hex character) AES-256 key before starting the service — the insecure dev-only ' +
          'fallback key is never used in production, staging, or an unset environment.',
      );
    }

    // SECURITY: Dev fallback only -- gated on an explicit development/test env.
    logger.warn(
      `[EncryptedColumn] ${envVarName} is not set (NODE_ENV='${nodeEnv}'). ` +
        'Using insecure dev-only fallback key. DO NOT use this in production.',
    );
    const key = Buffer.from(DEV_FALLBACK_KEY, 'utf8');
    keyCache.set(envVarName, key);
    return key;
  }

  let key: Buffer;
  if (rawKey.length === KEY_LENGTH * 2 && /^[0-9a-fA-F]+$/.test(rawKey)) {
    key = Buffer.from(rawKey, 'hex');
  } else if (rawKey.length === KEY_LENGTH) {
    key = Buffer.from(rawKey, 'utf8');
  } else {
    throw new Error(
      `[EncryptedColumn] ${envVarName} must be either a 32-character ASCII string ` +
        'or a 64-character hex-encoded value.',
    );
  }

  keyCache.set(envVarName, key);
  return key;
}

/**
 * Encrypt a plaintext string using AES-256-GCM.
 *
 * Output format: `enc:<keyVersion>:<iv_hex>:<authTag_hex>:<ciphertext_hex>`
 * The keyVersion prefix enables future key rotation without re-encrypting all data.
 */
function encrypt(plaintext: string, key: Buffer, keyVersion: string): string {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);

  const authTag = cipher.getAuthTag();

  return (
    ENCRYPTED_PREFIX +
    keyVersion +
    ':' +
    iv.toString('hex') +
    ':' +
    authTag.toString('hex') +
    ':' +
    encrypted.toString('hex')
  );
}

/**
 * Decrypt a value encrypted by `encrypt()`.
 * If the value does not start with `enc:`, it is returned as-is
 * (backward compatibility for existing plaintext data).
 */
function decrypt(encrypted: string, key: Buffer): string {
  if (!encrypted.startsWith(ENCRYPTED_PREFIX)) {
    // Plaintext value from before encryption was enabled -- return as-is
    return encrypted;
  }

  const withoutPrefix = encrypted.slice(ENCRYPTED_PREFIX.length);
  const parts = withoutPrefix.split(':');

  if (parts.length !== 4) {
    throw new Error(
      '[EncryptedColumn] Malformed encrypted value: expected format enc:<version>:<iv>:<authTag>:<ciphertext>',
    );
  }

  // parts[0] is keyVersion (unused while only one key is active —
  // multi-key rotation will read it). parts[1..3] are crypto components.
  const [, ivHex, authTagHex, ciphertextHex] = parts as [string, string, string, string];
  const iv = Buffer.from(ivHex, 'hex');
  const authTag = Buffer.from(authTagHex, 'hex');
  const ciphertext = Buffer.from(ciphertextHex, 'hex');

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);

  return decrypted.toString('utf8');
}

/**
 * Creates a TypeORM ValueTransformer that transparently encrypts on write
 * and decrypts on read using AES-256-GCM.
 *
 * Supports both string columns and JSONB columns (serialized to/from JSON).
 *
 * Usage:
 * ```typescript
 * @Column({ type: 'text', transformer: createEncryptedColumnTransformer('EMPLOYEE_PII_ENCRYPTION_KEY') })
 * nationalId!: string;
 *
 * @Column({ type: 'text', transformer: createEncryptedColumnTransformer('EMPLOYEE_PII_ENCRYPTION_KEY', { json: true }) })
 * bankDetails!: BankDetails;
 * ```
 *
 * @param envVarName - Environment variable name holding the AES-256 key
 * @param options.json - If true, JSON.stringify before encrypt, JSON.parse after decrypt
 * @param options.keyVersion - Key version tag for rotation support (default: 'v1')
 */
export function createEncryptedColumnTransformer(
  envVarName: string,
  options?: { json?: boolean; keyVersion?: string },
): ValueTransformer {
  const isJson = options?.json ?? false;
  const keyVersion = options?.keyVersion ?? 'v1';

  return {
    to(value: unknown): string | null | undefined {
      if (value === null || value === undefined) return value;

      const key = resolveKey(envVarName);
      const plaintext = serializePlaintext(value, isJson);

      // SECURITY: Idempotency -- don't double-encrypt
      if (typeof value === 'string' && value.startsWith(ENCRYPTED_PREFIX)) {
        return value;
      }

      return encrypt(plaintext, key, keyVersion);
    },

    from(value: string | null | undefined): unknown {
      if (value === null || value === undefined) return value;

      const key = resolveKey(envVarName);

      try {
        const decrypted = decrypt(value, key);
        return isJson ? JSON.parse(decrypted) : decrypted;
      } catch {
        // SECURITY: never log PII content -- only log opaque error code
        logger.error('Decryption failed for stored column value (content redacted)');
        return isJson ? null : '[DECRYPTION_FAILED]';
      }
    },
  };
}

function serializePlaintext(value: unknown, json: boolean): string {
  if (json) {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) {
      throw new TypeError('Encrypted JSON value is not serializable');
    }
    return serialized;
  }

  if (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'bigint' ||
    typeof value === 'boolean'
  ) {
    return String(value);
  }
  throw new TypeError('Encrypted scalar value must be a primitive');
}
