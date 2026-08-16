import { BaseEvent } from './base-event';

/**
 * Cross-cutting compliance event contracts.
 *
 * # Events declared here
 *
 *   - LegalHoldAppliedEvent      — published when a legal hold is activated
 *   - LegalHoldReleasedEvent     — published when a hold is released (post dual-control approval)
 *   - LegalHoldExpiredEvent      — published when a hold's expiresAt timestamp passes
 *
 * # Why a dedicated event family
 *
 * Legal-hold lifecycle is observed by every service that performs
 * destructive operations — hold activation triggers a cache-invalidation
 * fan-out, release triggers retention sweeps to resume, expiry triggers
 * a notification to the legal team. Multiple consumers, multiple
 * services — the event-bus is the right transport.
 *
 * Closes: docs/reviews/legal-hold-auditor/2026-04-28-core-platform-review.md#LEGAL-LOW-001 (event-contract surface)
 */

/**
 * Legal hold applied to a (tenantId, scope, resourceId) tuple. Consumers
 * invalidate their LegalHoldService cache key for the tuple so the next
 * destructive op consults the current DB state, not a stale cache hit.
 */
export interface LegalHoldAppliedEvent extends BaseEvent {
  readonly eventType: 'LegalHoldApplied';
  /** Hold registry row id. */
  readonly holdId: string;
  /** Hold scope discriminator (tenant|channel|farm|invoice|audit|user). */
  readonly scope: string;
  /** Resource identifier within the scope; null for tenant-wide holds. */
  readonly resourceId: string | null;
  /** Reference to the legal matter that prompted the hold. */
  readonly legalMatterId: string;
  /** Free-text reason captured at hold-application time. */
  readonly reason: string;
  /** auth.users.id of the applying operator. */
  readonly appliedBy: string;
  /** ISO 8601 timestamp string per BaseEvent contract. */
  readonly appliedAtIso: string;
}

/**
 * Legal hold released after dual-control approval + MFA step-up. Consumers
 * resume the destructive operations they had paused during the hold —
 * retention sweeps, partition GC, outbox cleanup, etc. — but only the
 * NEXT scheduled cycle; in-flight operations from a release-vs-cron race
 * window are still expected to honor the latest registry state.
 */
export interface LegalHoldReleasedEvent extends BaseEvent {
  readonly eventType: 'LegalHoldReleased';
  /** Wire-contract revision. Legal-hold release evidence is immutable at v1. */
  readonly version: 1;
  readonly holdId: string;
  readonly scope: 'tenant' | 'channel';
  readonly resourceId: string | null;
  readonly legalMatterId: string;
  /** Durable two-person workflow row that authorized this transition. */
  readonly releaseOperationId: string;
  /** auth.users.id of the operator who requested release. */
  readonly releaseRequestedBy: string;
  /** auth.users.id of the distinct operator who authorized release. */
  readonly releaseAuthorizedBy: string;
  /** Free-text reason captured at release time. */
  readonly releaseReason: string;
  readonly releasedAtIso: string;
}

/**
 * Legal hold expired by reaching its expiresAt timestamp. Distinct from
 * Released because expiry is automatic (no operator action) and the
 * legal team gets a notification to confirm whether a follow-up hold
 * is required.
 */
export interface LegalHoldExpiredEvent extends BaseEvent {
  readonly eventType: 'LegalHoldExpired';
  readonly holdId: string;
  readonly scope: string;
  readonly resourceId: string | null;
  readonly legalMatterId: string;
  readonly expiredAtIso: string;
}

/**
 * Union type for compliance-domain events.
 */
export type ComplianceEvent =
  | LegalHoldAppliedEvent
  | LegalHoldReleasedEvent
  | LegalHoldExpiredEvent;
