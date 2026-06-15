import { Logger } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'crypto';

/**
 * Blind index (deterministic keyed hash) for encrypted-at-rest lookup columns.
 * ===========================================================================
 *
 * # Why this primitive exists
 *
 * AES-256-GCM column encryption (see `createEncryptedColumnTransformer`) is
 * non-deterministic by design: a fresh random IV per write means the same
 * plaintext produces different ciphertext every time. That is exactly what we
 * want for confidentiality — but it makes the column useless for equality
 * lookups (`WHERE email = ?`) and impossible to put a UNIQUE constraint on:
 * two rows with the SAME email encrypt to DIFFERENT ciphertext, so the DB sees
 * no collision and the uniqueness guarantee silently evaporates.
 *
 * A blind index restores BOTH capabilities without ever putting plaintext on
 * disk. We persist a second column holding `HMAC-SHA256(key, normalize(value))`:
 *   - Deterministic: the same input always maps to the same hash, so a UNIQUE
 *     index over the hash column enforces application-level uniqueness, and an
 *     equality query becomes `WHERE <col>Hash = blindIndex(value)`.
 *   - One-way + keyed: without the HMAC key an attacker who exfiltrates the DB
 *     cannot reverse the hash to plaintext, and cannot precompute a rainbow
 *     table (the key raises the attack cost to offline HMAC brute force).
 *
 * # Why HMAC, not raw SHA-256
 *
 * Emails are low-entropy and enumerable. A raw `sha256(email)` is reversible in
 * seconds with a wordlist/rainbow table. The keyed HMAC moves the secret out of
 * the database boundary: compromising the at-rest data is no longer sufficient
 * to deanonymise — the attacker also needs the key, which lives in the env /
 * secret manager, a separate security boundary. Same rationale as
 * `hmac-tenant-hash.util.ts`, generalised to arbitrary PII lookup columns.
 *
 * # Key resolution
 *
 * Reuses the SAME env-var resolution discipline as the encryption transformer:
 * the key is read once from `process.env[envVarName]`, accepted as a 32-char
 * ASCII string or a 64-char hex value, cached per env var. In production an
 * unset key is fatal (fail closed); in dev a documented deterministic fallback
 * keeps local tests reproducible.
 *
 * # Usage
 *
 * ```ts
 * const emailBlindIndex = createBlindIndex('EMPLOYEE_PII_BLIND_INDEX_KEY');
 *
 * // On the entity (derive the hash from the plaintext before persist):
 * this.emailHash = emailBlindIndex(this.email);
 *
 * // On lookup (route equality through the hash, never the encrypted column):
 * repo.findOne({ where: { tenantId, emailHash: emailBlindIndex(input.email) } });
 * ```
 */

/** AES-256 / HMAC-SHA256 key must be exactly 32 bytes. */
const KEY_LENGTH = 32;

/** Deterministic dev-only key — never used in production. */
const DEV_FALLBACK_KEY = 'b'.repeat(KEY_LENGTH);

const logger = new Logger('BlindIndex');

/**
 * Resolved key buffers, cached per env var. Shared across all blind-index
 * functions created for the same key name so the env var is read once.
 */
const keyCache = new Map<string, Buffer>();

/**
 * Resolve the blind-index key from an environment variable. Accepts a
 * 64-char hex value or a 32-char ASCII string — identical contract to the
 * encryption transformer so a deployment provisions one key format for both.
 *
 * @param envVarName Environment variable name holding the key.
 * @returns Buffer with the 32-byte HMAC key.
 */
function resolveKey(envVarName: string): Buffer {
  const cached = keyCache.get(envVarName);
  if (cached) return cached;

  const rawKey = process.env[envVarName];
  const isProduction = process.env['NODE_ENV'] === 'production';

  if (!rawKey) {
    if (isProduction) {
      throw new Error(
        `[BlindIndex] ${envVarName} environment variable is required in production. ` +
          'Set a 32-byte (64 hex character) HMAC key before starting the service. ' +
          'Without it, encrypted-column equality lookups and uniqueness cannot function.',
      );
    }

    // SECURITY: Dev fallback only — never in production.
    logger.warn(
      `[BlindIndex] ${envVarName} is not set. ` +
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
      `[BlindIndex] ${envVarName} must be either a 32-character ASCII string ` +
        'or a 64-character hex-encoded value.',
    );
  }

  keyCache.set(envVarName, key);
  return key;
}

/**
 * Normalize a lookup value before hashing so semantically-equal inputs map to
 * the same hash. Emails and similar identifiers are case-insensitive and
 * whitespace-insensitive at the edges; normalising here guarantees the blind
 * index agrees with the application's own equality semantics
 * (`email.toLowerCase().trim()`), which is what makes the UNIQUE index correct.
 */
function normalize(value: string): string {
  return value.toLowerCase().trim();
}

/**
 * Create a deterministic blind-index function bound to an HMAC key env var.
 *
 * The returned function maps a plaintext lookup value to a stable, keyed,
 * lowercase-hex HMAC-SHA256 digest suitable for persisting in a `<col>Hash`
 * column and enforcing a UNIQUE constraint over.
 *
 * @param envVarName - Environment variable holding the 32-byte HMAC key.
 * @returns A pure function `(value: string) => string` producing a 64-char hex digest.
 */
export function createBlindIndex(envVarName: string): (value: string) => string {
  return (value: string): string => {
    const key = resolveKey(envVarName);
    return createHmac('sha256', key).update(normalize(value), 'utf8').digest('hex');
  };
}

/**
 * Constant-time equality check for two blind-index digests. Use when comparing
 * a freshly-computed hash against a persisted one in a security-sensitive path
 * (authorization, dedup), to avoid leaking match length via timing. Plain `===`
 * short-circuits on the first differing byte; `timingSafeEqual` does not.
 */
export function blindIndexesEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
  } catch {
    return false;
  }
}
