/**
 * Canonical tenant lifecycle status.
 *
 * This is the single source of truth for tenant status values across the entire
 * platform. Both backend entities and frontend types MUST use this enum.
 *
 * ## Existing definitions reconciled
 * - auth-service `Tenant.status`: ACTIVE, SUSPENDED, PENDING, CANCELLED
 * - admin-api `Tenant.status`: PENDING, ACTIVE, SUSPENDED, CANCELLED, DEACTIVATED, ARCHIVED
 * - gateway-api `TenantStatus`: active, suspended, pending, trial, expired (lowercase drift)
 * - frontend `TenantStatus`: pending, active, suspended, deactivated, archived (lowercase drift)
 *
 * The canonical enum uses UPPER_CASE values to match the auth-service (source of truth
 * for tenant records). Services using lowercase must migrate to this enum.
 */
export enum TenantStatus {
  /** Tenant registration submitted but not yet activated by admin. */
  PENDING = 'PENDING',

  /** Tenant is fully operational. */
  ACTIVE = 'ACTIVE',

  /** Tenant temporarily suspended by admin (e.g. payment issue, policy violation). */
  SUSPENDED = 'SUSPENDED',

  /** Tenant explicitly deactivated by admin — data preserved but access revoked. */
  DEACTIVATED = 'DEACTIVATED',

  /** Tenant data archived and access fully revoked — precursor to deletion. */
  ARCHIVED = 'ARCHIVED',

  /** Tenant subscription cancelled — may still have access until period end. */
  CANCELLED = 'CANCELLED',
}
