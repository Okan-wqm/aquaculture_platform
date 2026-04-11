import { BaseEvent } from './base-event';

// ==================== Auth Events ====================

/**
 * User Registered Event
 * Published when a new user registers in the system
 */
export interface UserRegisteredEvent extends BaseEvent {
  eventType: 'UserRegistered';
  userId: string;
  email?: string;
  role?: string;
}

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

// ==================== Type Union ====================

/**
 * Union type for all auth events
 */
export type AuthEvent =
  | UserRegisteredEvent
  | UserLoggedInEvent
  | InvitationAcceptedEvent
  | PasswordResetRequestedEvent
  | PasswordResetCompletedEvent;
