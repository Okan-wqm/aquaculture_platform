import { Inject, Injectable, Logger } from '@nestjs/common';
import { BaseEvent } from '@platform/event-contracts';

/**
 * Narrow publish capability this wrapper needs (Interface Segregation over the
 * fat IEventBus, which also carries connect/disconnect/subscribe/health). The
 * 'EVENT_BUS' provider (full IEventBus) satisfies this structurally, and a test
 * can supply a one-method double with no cast.
 */
export interface EventPublishPort {
  publish(event: BaseEvent): Promise<void>;
}

/**
 * BestEffortEventPublisher — the sanctioned, EXPLICIT path for the handful of
 * auth events that are deliberately NOT routed through the durable outbox
 * (DATA-HIGH-001).
 *
 * # Why a wrapper instead of raw `eventBus.publish()`
 *
 * After DATA-HIGH-001 no auth domain service injects the raw event bus. Every
 * state-change event with no other durable record (UserInvited → notification
 * delivery, TenantCreated → provisioning, UserDeleted → cross-service erasure)
 * goes through {@link OutboxPublisher.enqueue} inside its write transaction.
 *
 * Two narrow categories legitimately CANNOT (or need not) be durable:
 *   1. Pure telemetry whose source-of-truth is the audit log (UserLoggedIn).
 *   2. Account/security notifications that are likewise audit-log-backed AND
 *      can originate from a platform-level (SUPER_ADMIN, tenantId = NULL) actor
 *      — the durable outbox requires a UUID tenantId, which these lack.
 *
 * Routing those through this wrapper makes "this event is allowed to be lossy"
 * an explicit, reviewable, allowlisted decision rather than an accidental
 * fire-and-forget. A publish failure here is swallowed (logged) so it never
 * fails the user's operation — the audit log already persisted the fact.
 *
 * Any event NOT on the allowlist throws: it is forcing the author to either
 * add it deliberately (with a justification) or — correctly — use the durable
 * outbox.
 */
@Injectable()
export class BestEffortEventPublisher {
  private readonly logger = new Logger(BestEffortEventPublisher.name);

  /**
   * Event types permitted on the lossy best-effort path. Each is audit-log-
   * backed (the audit log is the durable source-of-truth) and/or platform-
   * scoped (no tenant UUID for the durable outbox). Adding an entry is a
   * deliberate architectural decision — keep this set as small as possible.
   */
  private static readonly ALLOWLIST: ReadonlySet<string> = new Set<string>([
    'UserLoggedIn', // pure login telemetry; auth.audit_logs is the SoT
    'UserAccountLocked', // ORPHAN-MEDIUM-320 owner-notification trigger; the
    // CRITICAL ACCOUNT_LOCKED audit row is the durable SoT, the actor can be
    // platform-level (tenantId NULL → 'system'), and the lock expires on its
    // own — a lost email degrades UX, never correctness.
    'UserProfileUpdated', // profile sync; audit log is the SoT
    'UserPasswordChanged', // security signal; audit log is the SoT
    'PasswordResetRequested', // email-delivery trigger; user can re-request
    'PasswordResetCompleted', // security signal; audit log is the SoT
    'InvitationAccepted', // onboarding-complete signal; the user + invitation
    // rows are already durably committed, the actor can be a platform admin
    // (NULL tenant), and the audit log records the acceptance — the event is a
    // downstream welcome-workflow trigger, retriable, not a durability vector.
    'UserInvited', // notification trigger. The invitation row IS durably
    // persisted; if the event is lost the admin sees the pending invitation and
    // re-sends, so it is recoverable rather than a data-loss vector. NOTE: the
    // *ideal* end-state is durable (outbox), but createUser is currently a
    // non-transactional dual-write (ORPHAN-HIGH-090) — making UserInvited
    // durable requires first wrapping the whole user-creation flow in a
    // transaction, a focused change tracked separately.
  ]);

  constructor(@Inject('EVENT_BUS') private readonly eventBus: EventPublishPort) {}

  /**
   * Publish a best-effort event. Throws if the event is not allowlisted
   * (forcing durable-outbox usage); never throws on a downstream publish
   * failure (best-effort — the audit log is the durable record).
   */
  async publish<TEvent extends BaseEvent>(event: TEvent): Promise<void> {
    if (!BestEffortEventPublisher.ALLOWLIST.has(event.eventType)) {
      throw new Error(
        `BestEffortEventPublisher: "${event.eventType}" is not allowlisted for the ` +
          `lossy best-effort path. A tenant-scoped state-change event with no other ` +
          `durable record MUST use OutboxPublisher.enqueue() inside its write ` +
          `transaction. If this event is genuinely audit-log-backed telemetry, add ` +
          `it to the allowlist with a justification.`,
      );
    }

    try {
      await this.eventBus.publish(event);
    } catch (error) {
      // Best-effort: a publish failure must NOT fail the user's operation.
      this.logger.warn(
        `Best-effort publish of ${event.eventType} failed (non-fatal, audit log is the ` +
          `durable record): ${(error as Error).message}`,
      );
    }
  }
}
