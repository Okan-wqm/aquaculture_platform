/**
 * TenantStatus — canonical SSoT (auth-audit HIGH-007 cure)
 * ============================================================================
 *
 * # Why this lives in event-contracts
 *
 * Pre-fix EIGHT copies of the tenant lifecycle status existed, three of
 * them mutually incompatible in casing or value set:
 *
 *   - libs/shared-contracts:        6 values, UPPERCASE — but the lib is
 *                                   NOT wired into tsconfig paths / the nx
 *                                   graph, so NO backend service could
 *                                   actually import it (a dead "SSoT").
 *   - auth-service / admin-api:     8 values, UPPERCASE (+ PROVISIONING,
 *                                   PROVISIONING_FAILED) — each a private copy.
 *   - admin-api/analytics:          4 values (missing DEACTIVATED/ARCHIVED).
 *   - gateway-api middleware:       LOWERCASE drift ('active', 'suspended', …)
 *                                   plus non-canonical TRIAL/EXPIRED, papered
 *                                   over by a `mapStatus()` `.toLowerCase()`
 *                                   shim — any direct equality against a
 *                                   backend UPPERCASE value silently missed.
 *   - 3 × frontend copies:          three different value sets.
 *
 * The drift meant "is this tenant suspended?" had a different answer
 * depending on which module asked. Canonical declaration here — beside
 * the already-canonical {@link TenantPlan} and the TenantStatusChanged
 * event that carries it — is the single source of truth. Every service
 * and the frontend re-export from this module so `TenantStatus` is
 * structurally identical everywhere; the {@link TenantStatusMachine}
 * sibling is the only thing allowed to decide whether a transition is
 * legal.
 *
 * # Why UPPERCASE
 *
 * The auth.tenants `status` column (VARCHAR(20)) has always persisted
 * UPPERCASE values ('PENDING', 'ACTIVE', …). UPPERCASE is therefore the
 * zero-migration canonical form — gateway-api's lowercase enum is the
 * regression, and its `mapStatus` shim is deleted once gateway consumes
 * this enum directly. The longest value, PROVISIONING_FAILED (19 chars),
 * still fits VARCHAR(20).
 *
 * # The 9 values (strict superset of every prior copy)
 *
 *   PENDING              registration submitted, not yet provisioned
 *   PROVISIONING         schema clone + role seed in progress
 *   PROVISIONING_FAILED  provisioning errored; retryable or abandon
 *   ACTIVE               fully operational — the ONLY login-allowed state
 *   SUSPENDED            temporarily blocked (payment / policy)
 *   DEACTIVATED          admin-revoked access; data preserved
 *   CANCELLED            subscription cancelled; grace period before archive
 *   ARCHIVED             data archived, access revoked; precursor to deletion
 *   PURGED               GDPR Art-17 erasure complete — terminal, irreversible
 *
 * PROVISIONING / PROVISIONING_FAILED come from the auth + admin copies;
 * PURGED is new (the GDPR-erasure terminal the lifecycle previously had
 * no name for). Including every prior value makes this a strict superset
 * so no consumer loses a state it relied on.
 */
export enum TenantStatus {
  /** Registration submitted but provisioning has not started. */
  PENDING = 'PENDING',

  /** Schema clone + role/permission seed in progress (saga running). */
  PROVISIONING = 'PROVISIONING',

  /** Provisioning errored — retryable (→ PROVISIONING) or abandon (→ CANCELLED). */
  PROVISIONING_FAILED = 'PROVISIONING_FAILED',

  /** Fully operational. The ONLY status for which login is permitted. */
  ACTIVE = 'ACTIVE',

  /** Temporarily blocked by admin (payment issue, policy violation). */
  SUSPENDED = 'SUSPENDED',

  /** Admin explicitly revoked access — data preserved, reactivatable. */
  DEACTIVATED = 'DEACTIVATED',

  /** Subscription cancelled — grace window before archival. */
  CANCELLED = 'CANCELLED',

  /** Data archived and access fully revoked — precursor to GDPR purge. */
  ARCHIVED = 'ARCHIVED',

  /** GDPR Art-17 erasure complete. Terminal and irreversible. */
  PURGED = 'PURGED',
}
