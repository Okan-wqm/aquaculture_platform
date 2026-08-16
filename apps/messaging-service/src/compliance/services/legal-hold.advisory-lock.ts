import { createHash } from 'node:crypto';
import type { QueryRunner } from 'typeorm';

/**
 * Postgres advisory-lock helpers for the legal-hold↔retention TOCTOU
 * race (LEGAL-MEDIUM-004 cure).
 *
 * # Why this exists
 *
 * `RetentionPolicyService.cleanupForPolicy()` reads the hold registry
 * BEFORE calling TimescaleDB `drop_chunks(...)`. Between the read and
 * the destructive op, a concurrent `ActivateLegalHoldHandler.execute()`
 * could land a new hold that the cleanup will silently bypass. The
 * destructive op cannot be rolled back (drop_chunks is historically
 * non-transactional in TimescaleDB) so a SELECT ... FOR UPDATE on the
 * hold rows is necessary but not sufficient — we also need to
 * serialize against concurrent hold creation.
 *
 * The pattern: a Postgres SESSION-level advisory lock keyed on the
 * tenant id. Any code path that takes destructive action against a
 * tenant's data acquires the lock; any code path that creates / toggles
 * a hold acquires the same lock. The two are mutually exclusive for
 * the duration of the transaction.
 *
 * `pg_advisory_xact_lock(BIGINT)` auto-releases at COMMIT/ROLLBACK so
 * there is no leak risk. The 64-bit lock id is a deterministic hash of
 * the tenant uuid string — same uuid → same id, different uuids never
 * collide unless the SHA-256 prefix collides (cryptographic-strength
 * collision resistance is overkill but cheap).
 */

/**
 * Postgres advisory-lock identifiers are signed 64-bit integers
 * (`bigint`). We hash the tenant uuid with SHA-256 and take the first
 * 8 bytes as a signed bigint. Same uuid → same id.
 */
export function tenantAdvisoryLockKey(tenantId: string): bigint {
  if (!tenantId) {
    throw new Error('tenantAdvisoryLockKey: tenantId is required');
  }
  const digest = createHash('sha256').update(tenantId, 'utf8').digest();
  // Read first 8 bytes as big-endian, reinterpret to signed bigint.
  const unsigned = digest.readBigUInt64BE(0);
  // Map [0, 2^64) → [-2^63, 2^63) by reinterpreting bits as signed.
  // BIGINT in postgres is signed; we want the same sign behavior.
  const SIGNED_MASK = 1n << 63n;
  return unsigned >= SIGNED_MASK ? unsigned - (1n << 64n) : unsigned;
}

/**
 * Acquire a Postgres transaction-scoped advisory lock for a given
 * tenant. Auto-releases at COMMIT/ROLLBACK; safe under any error.
 *
 * Must be called inside a transaction (the QueryRunner must have
 * `startTransaction()` already invoked); otherwise pg silently
 * upgrades to a session-scoped lock that we'd have to release manually.
 *
 * # Why xact (transaction-scoped) vs session-scoped
 *
 * A session-scoped lock would persist past the transaction and require
 * an explicit `pg_advisory_unlock()` to release. Forgetting that on an
 * error path leaks the lock and deadlocks the next caller. The xact
 * variant is safe by construction: `await qr.commitTransaction()` or
 * `await qr.rollbackTransaction()` releases it as a side-effect.
 */
export async function acquireTenantAdvisoryLock(
  queryRunner: QueryRunner,
  tenantId: string,
): Promise<void> {
  const key = tenantAdvisoryLockKey(tenantId);
  // pg_advisory_xact_lock blocks until acquired. The hold-toggle path
  // and retention path both contend on the same key so they serialize.
  await queryRunner.query(`SELECT pg_advisory_xact_lock($1::bigint)`, [key.toString()]);
}
