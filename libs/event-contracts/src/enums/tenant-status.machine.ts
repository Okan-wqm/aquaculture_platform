/**
 * TenantStatusMachine — the ONLY authority on tenant lifecycle transitions.
 * ============================================================================
 *
 * # Why a machine and not scattered `if (status === …)` checks
 *
 * Pre-fix every service decided lifecycle legality independently:
 *   - admin-api's suspend/activate/deactivate/archive handlers each
 *     hand-coded their own precondition (`status === ACTIVE`, `!== ARCHIVED`),
 *   - auth-service's login path blocked only SUSPENDED + CANCELLED, so a
 *     DEACTIVATED or ARCHIVED tenant could still authenticate (latent bug),
 *   - nothing stopped an illegal jump (e.g. PURGED → ACTIVE) at all.
 *
 * Centralising the transition matrix here makes the legal lifecycle a
 * single table that every writer consults. {@link canTransition} /
 * {@link assertTransition} gate state changes; {@link isLoginAllowed}
 * gates authentication; {@link isTerminal} gates further mutation. A new
 * rule is a one-line edit to {@link TENANT_STATUS_TRANSITIONS}, and the
 * table-driven spec pins every illegal pair so drift is caught at CI time.
 *
 * # The lifecycle
 *
 *   PENDING ─▶ PROVISIONING ─▶ ACTIVE ─▶ SUSPENDED ⇄ ACTIVE
 *      │            │            │   │        │
 *      │            ▼            │   ▼        ▼
 *      │   PROVISIONING_FAILED   │ DEACTIVATED ⇄ ACTIVE
 *      │      │        │         │   │
 *      ▼      ▼        ▼         ▼   ▼
 *   CANCELLED ◀────────┴─────── CANCELLED ─▶ ACTIVE (resubscribe)
 *      │                                       │
 *      └──────────────▶ ARCHIVED ◀─────────────┘
 *                          │
 *                          ▼
 *                       PURGED   (GDPR Art-17 terminal — irreversible)
 */
import { TenantStatus } from './tenant-status.enum';

/**
 * Adjacency list of legal transitions: `from → allowed[]`.
 *
 * Every {@link TenantStatus} MUST appear as a key (enforced by the
 * `Record` type + the machine spec) so a newly-added status cannot be
 * forgotten here — TypeScript fails to compile until its row exists.
 */
export const TENANT_STATUS_TRANSITIONS: Readonly<Record<TenantStatus, readonly TenantStatus[]>> = {
  // Registration submitted: either provisioning starts, or it is abandoned.
  [TenantStatus.PENDING]: [TenantStatus.PROVISIONING, TenantStatus.CANCELLED],

  // Saga running: success → ACTIVE, error → PROVISIONING_FAILED.
  [TenantStatus.PROVISIONING]: [TenantStatus.ACTIVE, TenantStatus.PROVISIONING_FAILED],

  // Failure is recoverable: retry the saga, or give up.
  [TenantStatus.PROVISIONING_FAILED]: [TenantStatus.PROVISIONING, TenantStatus.CANCELLED],

  // Operational: admin may suspend/deactivate, or the subscription is cancelled.
  [TenantStatus.ACTIVE]: [
    TenantStatus.SUSPENDED,
    TenantStatus.DEACTIVATED,
    TenantStatus.CANCELLED,
  ],

  // Short-lived block: lift back to ACTIVE, escalate, cancel, or archive.
  [TenantStatus.SUSPENDED]: [
    TenantStatus.ACTIVE,
    TenantStatus.DEACTIVATED,
    TenantStatus.CANCELLED,
    TenantStatus.ARCHIVED,
  ],

  // Admin-revoked but data preserved: reactivate, cancel, or archive.
  [TenantStatus.DEACTIVATED]: [
    TenantStatus.ACTIVE,
    TenantStatus.CANCELLED,
    TenantStatus.ARCHIVED,
  ],

  // Cancelled with grace: resubscribe (→ ACTIVE) or let it archive.
  [TenantStatus.CANCELLED]: [TenantStatus.ACTIVE, TenantStatus.ARCHIVED],

  // Archived: the only forward path is GDPR erasure.
  [TenantStatus.ARCHIVED]: [TenantStatus.PURGED],

  // Erasure complete: terminal — no outgoing transitions.
  [TenantStatus.PURGED]: [],
};

/** The single status in which a tenant's users may authenticate. */
const LOGIN_ALLOWED_STATUSES: ReadonlySet<TenantStatus> = new Set([TenantStatus.ACTIVE]);

/**
 * True when `from → to` is a legal lifecycle transition. A self-transition
 * (`from === to`) is NOT legal — callers should no-op rather than re-emit a
 * status-changed event for an unchanged status.
 */
export function canTransition(from: TenantStatus, to: TenantStatus): boolean {
  return TENANT_STATUS_TRANSITIONS[from].includes(to);
}

/**
 * Assert a legal transition or throw. Writers call this immediately before
 * persisting a new status so an illegal jump fails loudly at the source
 * instead of corrupting the lifecycle silently.
 *
 * @throws {Error} with a deterministic, log-safe message when illegal.
 */
export function assertTransition(from: TenantStatus, to: TenantStatus): void {
  if (!canTransition(from, to)) {
    throw new Error(
      `Illegal tenant status transition: ${from} → ${to}. ` +
        `Allowed from ${from}: [${TENANT_STATUS_TRANSITIONS[from].join(', ') || '(terminal)'}].`,
    );
  }
}

/**
 * True only for ACTIVE. Replaces the old auth-service block list that
 * enumerated *rejected* statuses (SUSPENDED, CANCELLED) and so let every
 * other non-operational status (DEACTIVATED, ARCHIVED, PROVISIONING…) slip
 * through. Allow-listing the single operational state is fail-closed.
 */
export function isLoginAllowed(status: TenantStatus): boolean {
  return LOGIN_ALLOWED_STATUSES.has(status);
}

/** True when no further transition is possible (PURGED). */
export function isTerminal(status: TenantStatus): boolean {
  return TENANT_STATUS_TRANSITIONS[status].length === 0;
}
