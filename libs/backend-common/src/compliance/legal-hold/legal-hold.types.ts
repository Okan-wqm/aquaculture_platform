/**
 * @aquaculture/backend-common — canonical legal-hold registry types.
 *
 * # Why this module exists
 *
 * Litigation hold is a CROSS-CUTTING concern. Every destructive
 * operation across all 15 services — DROP SCHEMA CASCADE, GDPR
 * erasure cascade, retention sweep, outbox GC, partition DROP, audit
 * row DELETE — must consult ONE single source of truth before
 * proceeding. Pre-fix the only working implementation lived in
 * apps/messaging-service/src/compliance/services/legal-hold.service.ts
 * and was scoped to messaging only; the other 14 services had no
 * canonical guard, leaving 6+ destructive paths unguarded
 * (LEGAL-CRITICAL-001..003 + LEGAL-HIGH-002..006).
 *
 * # Scope discriminator
 *
 * One registry table holds ALL holds across ALL services. The `scope`
 * field discriminates which class of resource the hold applies to:
 *
 *   - 'tenant'   — tenant-wide. Blocks ANY destructive op on the tenant.
 *   - 'channel'  — messaging-service channel scope (sub-tenant).
 *   - 'farm'     — farm-service farm scope.
 *   - 'invoice'  — billing-service invoice scope.
 *   - 'audit'    — audit-row scope (rare; usually whole-tenant).
 *   - 'user'     — auth-service per-user scope (e.g. one employee under
 *                   subpoena while the rest of the tenant is unaffected).
 *
 * The list is closed by enum on purpose — adding a new scope requires
 * an architectural-arbiter ADR so the corresponding destructive paths
 * can be audited together.
 *
 * Closes: docs/reviews/legal-hold-auditor/2026-04-28-core-platform-review.md#LEGAL-CRITICAL-001 (foundation)
 * Closes: docs/reviews/legal-hold-auditor/2026-04-28-core-platform-review.md#LEGAL-CRITICAL-002 (foundation)
 * Closes: docs/reviews/legal-hold-auditor/2026-04-28-core-platform-review.md#LEGAL-CRITICAL-003 (foundation)
 */

export type HoldScope = 'tenant' | 'channel' | 'farm' | 'invoice' | 'audit' | 'user';

export const HOLD_SCOPES: readonly HoldScope[] = [
  'tenant',
  'channel',
  'farm',
  'invoice',
  'audit',
  'user',
] as const;

export interface LegalHoldRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly scope: HoldScope;
  readonly resourceId: string | null;
  readonly reason: string;
  readonly legalMatterId: string;
  readonly appliedBy: string;
  readonly appliedAtIso: string;
  readonly releasedBy: string | null;
  readonly releasedAtIso: string | null;
  readonly releaseReason: string | null;
}

/**
 * Thrown when a destructive operation is attempted on a resource that
 * is currently under legal hold. Distinct error class so call sites can
 * catch it specifically — typically returning HTTP 423 (Locked) or
 * 451 (Unavailable for Legal Reasons) to the operator.
 *
 * The error carries enough context (tenantId, scope, resourceId, the
 * matching hold's legalMatterId) for the operator to find the
 * blocking hold without re-querying — useful for runbook automation.
 */
export class LegalHoldActiveError extends Error {
  public readonly tenantId: string;
  public readonly scope: HoldScope;
  public readonly resourceId: string | null;
  public readonly legalMatterId: string;

  constructor(args: {
    tenantId: string;
    scope: HoldScope;
    resourceId: string | null;
    legalMatterId: string;
  }) {
    super(
      `Operation blocked by active legal hold (tenantId=${args.tenantId}, scope=${args.scope}, resourceId=${args.resourceId ?? '*'}, legalMatterId=${args.legalMatterId}). ` +
        `Release the hold via the canonical compliance API before retrying.`,
    );
    this.name = 'LegalHoldActiveError';
    this.tenantId = args.tenantId;
    this.scope = args.scope;
    this.resourceId = args.resourceId;
    this.legalMatterId = args.legalMatterId;
  }
}
