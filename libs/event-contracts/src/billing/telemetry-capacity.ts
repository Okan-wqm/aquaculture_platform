/**
 * Telemetry capacity entitlement contract (Task 8, 100-tenant readiness)
 * ==========================================================================
 *
 * # Why this exists (SENSOR-HIGH-011 / plan Task 8)
 *
 * The platform envelope is LOCKED (2026-08-24): 2.000 MQTT msg/s sustained
 * platform-wide + 15.000 msg/s for 5-minute stress only. Nothing in the
 * repo tracks how much of that envelope individual tenants consume, so a
 * new tenant's devices can silently push the platform past the envelope
 * the 60-minute zero-loss promise is conditioned on.
 *
 * This contract is the billing-side SSoT for a tenant's telemetry capacity
 * ENTITLEMENT — how many msg/s (M) and rows/s (R) a tenant may ingest —
 * and the state machine that keeps platform-wide activations inside the
 * envelope:
 *
 *   PENDING_CAPACITY → ACTIVE → SUPERSEDED
 *                       ↘ RELEASED
 *
 * - `PENDING_CAPACITY`: the reservation does NOT fit the remaining
 *   platform envelope. The tenant is provisioned, the entitlement row is
 *   durable, but it NEVER reaches ACTIVE on its own — `activate()` must be
 *   called after an operator proves the resize (droplet-capacity gate) or
 *   another tenant's release frees headroom. Meanwhile the tenant's
 *   previous ACTIVE entitlement (if any) keeps working.
 * - `ACTIVE`: the entitlement counts against the platform envelope and
 *   downstream services may gate ingestion on it.
 * - `SUPERSEDED`: a newer version of the SAME tenant's entitlement went
 *   ACTIVE; kept for audit, never re-activatable.
 * - `RELEASED`: the tenant's subscription ended / the entitlement was
 *   revoked; its M/R no longer count against the envelope.
 *
 * # Axes
 *
 * `m` and `r` are the plan's LOCKED axes: M = MQTT msg/s, R = PG row/s.
 * R is derived at reservation time (fan-out factor: every reading fans out
 * to N event/router rows) and stored, not recomputed downstream — the
 * entitlement snapshot is the value consumers gate on.
 *
 * # Versioning
 *
 * Every reservation for a tenant bumps `version` monotonically (1, 2, …).
 * Only ONE version per tenant may be ACTIVE; the invariant is enforced by
 * a partial unique index in the backing table (migration 1802200000000)
 * AND by the service's transactional compare-and-set.
 */

/** Lifecycle of one telemetry capacity entitlement row. */
export enum TelemetryCapacityEntitlementState {
  /** Reserved but NOT counted — envelope headroom was insufficient. */
  PENDING_CAPACITY = 'PENDING_CAPACITY',
  /** Counted against the platform envelope; downstream gates on it. */
  ACTIVE = 'ACTIVE',
  /** A newer version of the same tenant's entitlement went ACTIVE. */
  SUPERSEDED = 'SUPERSEDED',
  /** Revoked/ended — no longer counts against the envelope. */
  RELEASED = 'RELEASED',
}

/**
 * The locked platform envelope (Task 0 planning constants). The
 * reservation service sums ACTIVE entitlements against these — they are
 * deliberately here, in the shared contract, so every consumer (billing,
 * admin UI, capacity gates, tests) ranks against the SAME numbers.
 */
export const TELEMETRY_PLATFORM_ENVELOPE = {
  /** 2.000 MQTT msg/s sustained platform-wide (60-min promise scope). */
  totalM: 2000,
  /**
   * 15.000 msg/s for a 5-minute stress window ONLY. Reservations NEVER
   * count against this axis — it exists so gates can distinguish
   * "envelope breach" from "stress-window breach" in alarms.
   */
  stressM: 15000,
} as const;

/** A tenant's telemetry capacity entitlement values (the flat snapshot). */
export interface TelemetryCapacityEntitlementValues {
  /** MQTT messages/second the tenant may ingest (M axis). */
  m: number;
  /** PG rows/second the ingestion fans out to (R axis). */
  r: number;
}

/** Payload carried on the TelemetryCapacityEntitlementChanged event. */
export interface TelemetryCapacityEntitlementChangedEvent {
  eventType: 'TelemetryCapacityEntitlementChanged';
  tenantId: string;
  /** Monotonic per-tenant version of the entitlement that changed. */
  version: number;
  fromState: TelemetryCapacityEntitlementState;
  toState: TelemetryCapacityEntitlementState;
  /** The entitlement snapshot in its NEW state (post-transition). */
  values: TelemetryCapacityEntitlementValues;
  /** Platform envelope remaining AFTER this transition (M axis). */
  remainingM: number;
}
