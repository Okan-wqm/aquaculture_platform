import { BaseEvent } from './base-event';

// ==================== Auth Events ====================

// NOTE (SEC-CRITICAL-001): UserRegisteredEvent was REMOVED together with the
// public register mutation — no producer or consumer existed. User creation
// emits UserInvited / InvitationAccepted through the invitation flow instead.

/**
 * User Logged In Event
 * Published when a user successfully logs in
 */
export interface UserLoggedInEvent extends BaseEvent {
  eventType: 'UserLoggedIn';
  userId: string;
  ipAddress?: string;
  userAgent?: string;
}

/**
 * Invitation Accepted Event
 * Published when a user accepts a tenant invitation
 */
export interface InvitationAcceptedEvent extends BaseEvent {
  eventType: 'InvitationAccepted';
  userId: string;
  invitationId?: string;
  email?: string;
}

/**
 * Password Reset Requested Event
 * Published when a user requests a password reset.
 * The notification service listens to this event to send the reset email.
 *
 * SECURITY (CRITICAL-001, CRITICAL-002): PII and secret URLs removed from event payload.
 * Previously this event carried email, firstName, and actionUrl (with embedded reset token)
 * on the immutable event bus, creating a permanent PII and credential archive.
 *
 * NOW: Only opaque references (userId, actionTokenId) are carried. The notification
 * service resolves PII and the action URL at delivery time via the auth-service API.
 * cryptoShredKeyId is MANDATORY — enables GDPR erasure via crypto-shredding.
 *
 * BREAKING CHANGE: email, actionUrl, firstName fields removed.
 * Consumers must resolve user details via userId and actionTokenId.
 */
/**
 * ORPHAN-MEDIUM-320: emitted when the failed-login threshold locks an
 * account. Consumed by notification-service to send the owner-facing
 * "your account was locked" email — the wire login response stays the
 * generic anti-enumeration message, so this event is the ONLY channel
 * that tells the legitimate owner what happened.
 *
 * No PII: the consumer resolves the email address at delivery time via
 * the authenticated internal PII endpoint (CRITICAL-001/002 discipline).
 * Audit-log-backed (the CRITICAL ACCOUNT_LOCKED row is the durable SoT),
 * so it rides the best-effort path.
 */
export interface UserAccountLockedEvent extends BaseEvent {
  eventType: 'UserAccountLocked';
  /** Locked user — opaque reference, NOT PII */
  userId: string;
  /** Failed attempts that triggered the lock (the configured threshold). */
  failedAttempts: number;
  /** ISO-8601 instant at which the lock expires. */
  lockedUntil: string;
}

export interface PasswordResetRequestedEvent extends BaseEvent {
  eventType: 'PasswordResetRequested';
  /** User requesting the password reset — opaque reference, NOT PII */
  userId: string;
  /**
   * Opaque reference to the action token stored in auth-service.
   * The notification service uses this to build the reset URL at delivery time
   * via a secure, authenticated internal API call.
   *
   * SECURITY: The actual reset token / URL is NEVER placed on the event bus.
   */
  actionTokenId: string;
  /**
   * MANDATORY for events related to user PII.
   * Enables GDPR erasure via crypto-shredding: deleting this key renders
   * all associated PII irrecoverable without replaying events.
   */
  cryptoShredKeyId: string;
}

/**
 * Password Reset Completed Event
 * Published when a user successfully resets their password
 */
export interface PasswordResetCompletedEvent extends BaseEvent {
  eventType: 'PasswordResetCompleted';
  userId: string;
}

/**
 * User Deleted Event
 *
 * Published when a user account is deleted via either user-initiated
 * delete or admin/GDPR-erasure cascade. Consumed by every tenant-data-
 * bearing service to erase per-user data (sensor history, audit rows
 * (legal-hold permitting), notification subscriptions, etc.) and by the
 * AI service to drop conversation context for the user.
 *
 * WHY: Pre-fix the event was emitted via raw `createBaseEvent('UserDeleted', …)`
 * with NO interface, losing the branded-EventId Tier-1 type safety the
 * SSoT promises (ADR-006). COMPLIANCE-CRITICAL-003. The interface here
 * makes the event type-checked at compile time and enables JSON Schema
 * validation at consumer trust-boundaries.
 *
 * `cryptoShredKeyId` is MANDATORY for the GDPR erasure path — deleting
 * the underlying KMS key after cascade renders any cryptographically
 * shredded PII irrecoverable, providing legal-grade right-to-erasure.
 */
export interface UserDeletedEvent extends BaseEvent {
  eventType: 'UserDeleted';
  /** Canonical deletion target. BaseEvent.userId remains the actor/requester when present. */
  deletedUserId: string;
  /** Whether the row was hard-deleted (true) or anonymized in place (false). */
  hardDelete: boolean;
  /** Whether downstream services should cascade their own per-user data erasure. */
  cascadeRequested: boolean;
  /** Caller of the delete: user-initiated, admin action, or GDPR erasure. */
  initiatedBy: 'user' | 'admin' | 'gdpr-erasure';
  /** MANDATORY — KMS key id for crypto-shred completion of PII erasure. */
  cryptoShredKeyId: string;
}

/**
 * User Data Anonymized Event
 *
 * Published when a user record is anonymized in place rather than
 * deleted (typical for users referenced by historical events that must
 * survive for audit/regulatory reasons). Consumers update their local
 * denormalised user references to the anonymised placeholder.
 */
export interface UserDataAnonymizedEvent extends BaseEvent {
  eventType: 'UserDataAnonymized';
  userId: string;
  /** Anonymisation method recorded for audit trail (e.g. 'pii-fields-nulled', 'crypto-shredded'). */
  method: 'pii-fields-nulled' | 'crypto-shredded';
  /** Caller of the anonymisation. */
  initiatedBy: 'user' | 'admin' | 'gdpr-erasure';
  /** Crypto-shred key id when method='crypto-shredded'. */
  cryptoShredKeyId?: string;
}

/**
 * GDPR Anonymize Requested Event
 *
 * Published when a user (or admin on user's behalf) submits an Art 17
 * right-to-erasure request that will be fulfilled via anonymisation
 * (rather than hard delete). Consumers begin the legal-hold check and,
 * if clear, schedule the anonymisation work.
 */
export interface GdprAnonymizeRequestedEvent extends BaseEvent {
  eventType: 'GdprAnonymizeRequested';
  userId: string;
  /** Reference to the GDPR request row in the canonical registry. */
  requestId: string;
  /** Deadline by which fulfilment must complete (ISO 8601 string per BaseEvent contract). */
  fulfilByIso: string;
  /** Optional operator note explaining the request. */
  reason?: string;
}

/**
 * Consent Recorded Event
 *
 * Published when a user grants a new consent (e.g. analytics, AI
 * processing). Consumers gate their respective behaviours on consent
 * presence — AI service only embeds tenant data when AI consent is
 * present and current.
 *
 * WHY: Pre-fix `UserConsentService.recordConsent` and `withdrawConsent`
 * emitted ZERO events on the outbox — withdrawal of ANALYTICS|PROFILING
 * consent was invisible cross-service, violating GDPR Art 7(3) instant-
 * effect. COMPLIANCE-CRITICAL-003.
 */
export interface ConsentRecordedEvent extends BaseEvent {
  eventType: 'ConsentRecorded';
  userId: string;
  consentType: string;
  /** Schema version of the consent text the user accepted. */
  consentVersion: string;
  /** Legal basis the consent rests on (Art 6: 'consent', 'contract', 'legal-obligation', etc.). */
  legalBasis: string;
}

/**
 * Consent Withdrawn Event
 *
 * Published when a user revokes a previously-recorded consent. Art 7(3)
 * requires withdrawal to take effect "as easily as it was given" —
 * downstream consumers must pause / scrub the dependent processing
 * within seconds.
 */
export interface ConsentWithdrawnEvent extends BaseEvent {
  eventType: 'ConsentWithdrawn';
  userId: string;
  consentType: string;
  /** Reason captured at withdrawal time (free text, GDPR Art 7(3) record). */
  reason?: string;
}

// ==================== Type Union ====================

/**
 * Union type for all auth events
 */
/**
 * User Profile Updated Event
 *
 * Published when a user changes their own profile fields (name, locale,
 * contact preferences) through `AccountService.updateMyProfile`. Consumers
 * refresh denormalised user copies; nothing security-relevant changes here,
 * which is why the payload carries no field-level diff — a profile diff would
 * put PII on the bus for consumers that only need the invalidation signal.
 *
 * DATA-HIGH-004: the emitter existed with no declared interface, so the event
 * crossed the bus with a shape no consumer could type against and no upcaster
 * could version. Declaring it is what makes the contract enforceable.
 */
export interface UserProfileUpdatedEvent extends BaseEvent {
  eventType: 'UserProfileUpdated';
}

/**
 * User Password Changed Event
 *
 * Published when a user changes their own password through
 * `AccountService.changeMyPassword`, AFTER the credential revocation sweep has
 * run. Consumers holding cached sessions or derived credentials for the user
 * must treat them as void.
 *
 * Deliberately carries no credential material and no indication of the old or
 * new secret — the event's whole purpose is the invalidation signal, and any
 * additional field would be a secret on the bus.
 *
 * DATA-HIGH-004: same as its sibling above — emitted since the account service
 * was written, declared nowhere.
 */
export interface UserPasswordChangedEvent extends BaseEvent {
  eventType: 'UserPasswordChanged';
}

export type AuthEvent =
  | UserLoggedInEvent
  | UserProfileUpdatedEvent
  | UserPasswordChangedEvent
  | UserAccountLockedEvent
  | InvitationAcceptedEvent
  | PasswordResetRequestedEvent
  | PasswordResetCompletedEvent
  | UserDeletedEvent
  | UserDataAnonymizedEvent
  | GdprAnonymizeRequestedEvent
  | ConsentRecordedEvent
  | ConsentWithdrawnEvent;
