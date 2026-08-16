// Platform convention: every auth-path caller uses bcryptjs (ships its own
// type declarations, pure-JS, identical hash format to node-bcrypt). Align
// here so the library has one bcrypt implementation — not two that can
// drift on cost-factor defaults or constant-time comparison behavior.
import { createHmac } from 'crypto';

import * as bcrypt from 'bcryptjs';

/**
 * @module PasswordUtil
 *
 * Platform password hashing — HMAC-peppered bcrypt with a lazy migration path
 * from legacy unpeppered hashes.
 *
 * SECURITY (HIGH-006): a password pepper (server-side HMAC key) adds an extra
 * layer of defence against offline attacks on a stolen password database. Even
 * if the database is exfiltrated, the attacker must also steal the pepper from
 * the secret store (separate blast radius) before they can attempt the hashes.
 *
 * # Storage format (versioned prefix — no migration DDL required)
 *
 * - Legacy (pre-pepper):  `$2[aby]?\$12\$...........................`  (raw bcrypt)
 * - Peppered v1:          `p1:$2[aby]?\$12\$...........................`
 *
 * The prefix is the ONLY marker distinguishing the two formats — checking
 * `startsWith('p1:')` is sufficient to route to the correct verification path.
 *
 * # Lazy migration
 *
 * When a user logs in with a legacy hash and `PASSWORD_PEPPER` is configured,
 * `verifyPassword()` returns `{ matched: true, shouldMigrate: true }`. The
 * caller MUST re-hash with `hashPassword()` and persist. Users who never log
 * in retain their legacy hash — still bcrypt-protected, just without the
 * server-side pepper. No forced password reset.
 *
 * # Operational knobs
 *
 * - `PASSWORD_PEPPER` (env): required in production. Generate with
 *   `openssl rand -base64 48`. NEVER share with the database — keep it in
 *   AWS Secrets Manager / Vault separately.
 * - `BCRYPT_SALT_ROUNDS` (env, default 12): cost factor. Only affects new
 *   hashes; existing hashes keep their cost factor embedded in the storage.
 */

export const PEPPERED_PREFIX_V1 = 'p1:';

/** Resolve the pepper from env, throwing in production if unset. */
function getPepper(): string | null {
  const pepper = process.env['PASSWORD_PEPPER'];
  if (pepper && pepper.length > 0) return pepper;

  if (process.env['NODE_ENV'] === 'production') {
    throw new Error(
      '[password.util] PASSWORD_PEPPER is required in production. ' +
        'Generate with: openssl rand -base64 48. Store in the platform secret manager ' +
        '(AWS Secrets Manager / Vault) SEPARATELY from the database so a DB exfiltration ' +
        'does not compromise the hashes.',
    );
  }
  // Non-production: null pepper is allowed — bcrypt remains the single line
  // of defence. Explicit null rather than empty string so application code
  // can distinguish "pepper not configured" from "pepper is the empty string".
  return null;
}

/** Apply the pepper to a plaintext password, producing a fixed-length hex digest. */
function applyPepper(plain: string, pepper: string): string {
  return createHmac('sha256', pepper).update(plain, 'utf8').digest('hex');
}

/** Read the bcrypt cost factor from env, with a sane default. */
function getSaltRounds(): number {
  const raw = process.env['BCRYPT_SALT_ROUNDS'];
  const parsed = raw ? parseInt(raw, 10) : NaN;
  if (Number.isFinite(parsed) && parsed >= 10 && parsed <= 14) return parsed;
  return 12;
}

/**
 * Hash a plaintext password with HMAC-pepper + bcrypt. Output is prefixed
 * with `p1:` so verification can detect the format.
 *
 * In non-production environments where `PASSWORD_PEPPER` is unset, this
 * returns a plain bcrypt hash (no prefix) so existing dev data continues
 * to validate against it.
 */
export async function hashPassword(plain: string): Promise<string> {
  const pepper = getPepper();
  const rounds = getSaltRounds();

  if (pepper === null) {
    // Dev-only path: no pepper configured. Produce a legacy-shape hash so
    // test fixtures and seed scripts keep working without pepper env.
    return bcrypt.hash(plain, rounds);
  }

  const peppered = applyPepper(plain, pepper);
  const hash = await bcrypt.hash(peppered, rounds);
  return `${PEPPERED_PREFIX_V1}${hash}`;
}

export interface VerifyPasswordResult {
  /** True when the plaintext matches the stored hash. */
  matched: boolean;
  /**
   * True when a LEGACY (unpeppered) hash matched AND a pepper is configured.
   * Callers should re-hash via `hashPassword()` and persist so the user
   * migrates to the peppered format on their next login. When false, no
   * migration is needed — either the hash was already peppered, or no
   * pepper is configured.
   */
  shouldMigrate: boolean;
}

/**
 * Verify a plaintext password against a stored hash. Routes automatically
 * between the peppered (`p1:` prefix) and legacy (raw bcrypt) formats.
 *
 * Returns `{ matched, shouldMigrate }` so the caller can trigger a lazy
 * re-hash on successful legacy matches.
 */
export async function verifyPassword(plain: string, stored: string): Promise<VerifyPasswordResult> {
  if (!stored) return { matched: false, shouldMigrate: false };

  const pepper = getPepper();

  // ── Peppered format (p1:) ──
  if (stored.startsWith(PEPPERED_PREFIX_V1)) {
    if (pepper === null) {
      // Production ALREADY threw above; this branch is dev with a legacy
      // hash migrated from a peppered environment. Fail closed.
      return { matched: false, shouldMigrate: false };
    }
    const rawHash = stored.slice(PEPPERED_PREFIX_V1.length);
    const peppered = applyPepper(plain, pepper);
    const matched = await bcrypt.compare(peppered, rawHash);
    return { matched, shouldMigrate: false };
  }

  // ── Legacy format (raw bcrypt, no prefix) ──
  const matched = await bcrypt.compare(plain, stored);
  return {
    matched,
    shouldMigrate: matched && pepper !== null,
  };
}
