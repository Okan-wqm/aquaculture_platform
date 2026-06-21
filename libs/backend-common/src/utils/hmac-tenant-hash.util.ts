/**
 * HMAC Tenant Hash Utility — GDPR Art 17 Cascade-Safe Pseudonymisation
 * ===========================================================================
 *
 * Produces a keyed one-way hash of a `tenant_<uuid16>` schema name that
 * is safe to persist beyond tenant lifetime for observability/audit
 * purposes and does not leak tenant identity to anyone without the
 * per-environment pepper.
 *
 * # Why not raw sha256(tenant_schema)?
 *
 * `tenant_schema` follows a deterministic pattern (`tenant_<16 hex>`).
 * The total key-space is 16^16 ≈ 1.8e19 — theoretically resistant to
 * brute force, but practically any operator holding a list of active
 * tenant names can precompute a rainbow table in <1s and reverse a
 * raw `sha256(tenant_schema)` trivially.
 *
 * Per GDPR Recital 26, pseudonymised data that can be attributed to a
 * natural person "by the use of additional information" remains personal
 * data. Raw sha256 therefore inherits GDPR Art 17 obligations — a
 * 90-day retention of sha256 rows is a 90-day Art-17 violation window
 * after any tenant invokes erasure.
 *
 * HMAC with a secret pepper raises the attack cost from "rainbow table
 * on known tenant list" to "offline HMAC brute force without the pepper".
 * With a 256-bit pepper stored in Vault, the effort is infeasible without
 * Vault compromise — a separate security boundary with its own monitoring.
 *
 * See `docs/adr/022-pseudonymisation-key-management.md` for the full
 * rotation contract + `docs/adr/024-compliance-retention-matrix.md` for
 * the retention policy this utility enables.
 *
 * # Usage
 *
 * ```ts
 * import { hmacTenantHash, assertTenantHashPepperSet } from '@aquaculture/backend-common/hmac-tenant-hash.util.ts';
 *
 * // At app startup (in main.ts or AppModule):
 * assertTenantHashPepperSet();
 *
 * // In observability-service consumer / any service that persists tenant refs:
 * const tenantIdHash = hmacTenantHash(tenantSchema);
 * await repository.insert({ tenant_id_hash: tenantIdHash, ... });
 * ```
 *
 * # Pepper source + rotation
 *
 * - Reads `process.env['TENANT_HASH_PEPPER']`. In production this is a
 *   Vault-sourced 32-byte base64 value mounted via the container's env
 *   injection pathway (not `.env` at rest on disk).
 * - If unset in production (NODE_ENV=production), the utility throws at
 *   first invocation — NEVER silently falls back to raw sha256. Fail
 *   closed so a misconfigured deploy produces a loud, auditable error
 *   rather than quietly degrading pseudonymisation.
 * - Dev default pepper (NODE_ENV ≠ production AND env unset): a
 *   documented deterministic value so local tests are reproducible.
 *   This is intentional for dev ergonomics; the assertion guards prod.
 *
 * # Cascade / erasure contract
 *
 * During tenant erasure, the target handler re-computes
 * `hmacTenantHash(erased_schema)` and issues a direct `DELETE ... WHERE
 * tenant_id_hash = $1` against every retention-bearing table
 * (observability.migration_events, observability.schema_object_history,
 * etc.). The hash is stable under the current pepper, so the DELETE is
 * a single indexed lookup — <100ms for millions of rows per table.
 *
 * See ADR-022 for the rotation flow that handles pepper change.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

/** Env var that carries the 32-byte (or longer) base64 pepper in prod. */
export const TENANT_HASH_PEPPER_ENV = 'TENANT_HASH_PEPPER';

/**
 * Dev-only deterministic pepper used when `NODE_ENV !== 'production'`
 * and `TENANT_HASH_PEPPER` is unset. Intentionally published in this
 * source file: its only purpose is to make local tests reproducible;
 * prod NEVER reaches this branch (see `assertTenantHashPepperSet`).
 */
const DEV_ONLY_DEFAULT_PEPPER =
  'dev-only-tenant-hash-pepper-NEVER-use-in-production-envelope';

/**
 * Validate at startup that the pepper is configured for the current
 * environment. Throws in production if unset; logs a warn otherwise.
 *
 * Call this ONCE from the app's bootstrap path (main.ts before creating
 * the NestJS app, or as an `onApplicationBootstrap` hook). Failing early
 * produces a clear error message with remediation pointer rather than
 * a silent pseudonymisation downgrade at runtime.
 */
export function assertTenantHashPepperSet(logger?: {
  warn: (msg: string) => void;
}): void {
  const pepper = process.env[TENANT_HASH_PEPPER_ENV];
  const isProd = process.env['NODE_ENV'] === 'production';

  if (!pepper) {
    if (isProd) {
      throw new Error(
        `[hmac-tenant-hash] ${TENANT_HASH_PEPPER_ENV} env var is REQUIRED in production. ` +
          `Without it, tenant pseudonymisation silently falls back to a dev-only default, ` +
          `producing an immediately-compromisable pseudonymisation scheme. ` +
          `Provision via Vault → container env injection. ` +
          `See docs/adr/022-pseudonymisation-key-management.md.`,
      );
    }
    logger?.warn(
      `[hmac-tenant-hash] ${TENANT_HASH_PEPPER_ENV} unset; using dev-only default. ` +
        `Safe for local dev/tests only. Production WILL refuse to start without this var.`,
    );
    return;
  }

  // Length sanity: documented 32 bytes base64 = 44 chars with padding,
  // 43 without. Allow anything ≥ 32 chars to tolerate alternative
  // encodings, but refuse anything suspiciously short.
  if (pepper.length < 32) {
    throw new Error(
      `[hmac-tenant-hash] ${TENANT_HASH_PEPPER_ENV} is too short (<${pepper.length} chars). ` +
        `Minimum 32 chars (256 bits of entropy in base64). ` +
        `See docs/adr/022-pseudonymisation-key-management.md.`,
    );
  }
}

/**
 * Resolve the current pepper. Prefers env, falls back to dev default
 * only when NODE_ENV !== 'production'. In prod without the env var,
 * this function throws — which is correct behaviour, because a
 * production service emitting tenant-hash rows under a weak pepper is
 * a GDPR incident.
 */
function resolvePepper(): string {
  const env = process.env[TENANT_HASH_PEPPER_ENV];
  if (env) return env;
  if (process.env['NODE_ENV'] === 'production') {
    throw new Error(
      `[hmac-tenant-hash] ${TENANT_HASH_PEPPER_ENV} env var is REQUIRED in production. ` +
        `See assertTenantHashPepperSet() — call it at app bootstrap to fail fast.`,
    );
  }
  return DEV_ONLY_DEFAULT_PEPPER;
}

/**
 * Compute the HMAC-SHA256 tenant hash.
 *
 * @param tenantSchema  The canonical schema name, e.g. `tenant_abc123def456789a`.
 *                      Must match the platform's tenant-schema pattern; this
 *                      utility does NOT validate the pattern — that's the
 *                      caller's job (SAFE_IDENT_RE at the trust boundary).
 * @returns hex-encoded 64-character HMAC-SHA256.
 *
 * # Stability guarantee
 *
 * Output is stable under the current pepper. If the pepper rotates,
 * downstream persistence (e.g. migration_events rows) must be re-hashed
 * via the `recompute-tenant-hash` batch job per ADR-022.
 *
 * # Not for equality checks
 *
 * For comparing two hashes for equality in security-sensitive contexts
 * (e.g. lookup against a stored hash), prefer `tenantHashesEqual()`
 * which uses `timingSafeEqual` — avoids timing oracles on hash strings.
 */
export function hmacTenantHash(tenantSchema: string): string {
  if (!tenantSchema || typeof tenantSchema !== 'string') {
    throw new TypeError(
      '[hmac-tenant-hash] tenantSchema must be a non-empty string',
    );
  }
  const pepper = resolvePepper();
  return createHmac('sha256', pepper).update(tenantSchema).digest('hex');
}

/**
 * Constant-time equality check for two tenant hashes.
 *
 * Use this when comparing a freshly-computed hash against a persisted
 * hash during erasure cascade or authorization decisions. String `===`
 * leaks timing information proportional to prefix match length.
 */
export function tenantHashesEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
  } catch {
    return false;
  }
}
