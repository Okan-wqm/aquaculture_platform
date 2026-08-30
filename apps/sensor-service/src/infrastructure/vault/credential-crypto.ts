import * as crypto from 'crypto';

import { ENCRYPTION_ALGORITHM, IV_LENGTH, ENCRYPTED_PREFIX } from './credential-vault.constants';

/**
 * Pure AES-256-GCM credential crypto (SENSOR-MEDIUM-080).
 *
 * The single source of truth for the sensor-service at-rest secret format
 * `enc:<iv_hex>:<authTag_hex>:<ciphertext_hex>`. Kept as free functions (not a
 * Nest service) so BOTH the runtime `CredentialVaultService` AND the offline
 * backfill migration can produce/consume byte-identical ciphertext — a migration
 * runs in the db-migrate CLI with no DI container, so it cannot use the service.
 */

/** AES-256 key must be exactly 32 bytes. */
export const KEY_LENGTH = 32;

/**
 * Deterministic dev-only key — 32 bytes of ASCII 'd'. Never used in production;
 * callers gate its use behind an explicit dev/test environment.
 */
export const DEV_FALLBACK_KEY = 'd'.repeat(KEY_LENGTH);

/**
 * Resolve the AES-256 key from a raw env value. Accepts a 64-char hex string or
 * a 32-char ASCII string. Returns `null` when no key is configured so the caller
 * decides whether the dev fallback is acceptable in this environment.
 */
export function resolveEncryptionKey(rawKey: string | undefined | null): Buffer | null {
  if (!rawKey) {
    return null;
  }
  if (rawKey.length === KEY_LENGTH * 2 && /^[0-9a-fA-F]+$/.test(rawKey)) {
    return Buffer.from(rawKey, 'hex');
  }
  if (rawKey.length === KEY_LENGTH) {
    return Buffer.from(rawKey, 'utf8');
  }
  throw new Error(
    'CREDENTIAL_ENCRYPTION_KEY must be either a 32-character ASCII string or a ' +
      '64-character hex-encoded value.',
  );
}

/** True if a value is in the canonical `enc:` ciphertext form. */
export function isEncryptedValue(value: string): boolean {
  return value.startsWith(ENCRYPTED_PREFIX);
}

/**
 * Encrypt a plaintext string with AES-256-GCM.
 * Output: `enc:<iv_hex>:<authTag_hex>:<ciphertext_hex>`.
 */
export function encryptSecretValue(plaintext: string, key: Buffer): string {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ENCRYPTION_ALGORITHM, key, iv) as crypto.CipherGCM;
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return (
    ENCRYPTED_PREFIX +
    iv.toString('hex') +
    ':' +
    authTag.toString('hex') +
    ':' +
    encrypted.toString('hex')
  );
}

/**
 * Decrypt a value produced by `encryptSecretValue`. Values without the `enc:`
 * prefix are returned as-is (backward compatibility for data written before
 * encryption was enabled).
 */
export function decryptSecretValue(value: string, key: Buffer): string {
  if (!isEncryptedValue(value)) {
    return value;
  }
  const parts = value.slice(ENCRYPTED_PREFIX.length).split(':');
  if (parts.length !== 3) {
    throw new Error('Malformed encrypted value: expected format enc:<iv>:<authTag>:<ciphertext>');
  }
  const [ivHex, authTagHex, ciphertextHex] = parts as [string, string, string];
  const decipher = crypto.createDecipheriv(
    ENCRYPTION_ALGORITHM,
    key,
    Buffer.from(ivHex, 'hex'),
  ) as crypto.DecipherGCM;
  decipher.setAuthTag(Buffer.from(authTagHex, 'hex'));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(ciphertextHex, 'hex')),
    decipher.final(),
  ]);
  return decrypted.toString('utf8');
}
