import { BaseEvent } from './base-event';

/**
 * User Invited Event - Triggered when a new user is created and needs welcome email
 *
 * SECURITY (CRITICAL-001, CRITICAL-002): PII and secret URLs removed from event payload.
 * Previously this event carried email, firstName, lastName, tenantName, and actionUrl
 * (with embedded invitation token) on the immutable event bus, creating a permanent
 * PII and credential archive violating GDPR.
 *
 * NOW: Only opaque references (userId, tenantId, actionTokenId) are carried. The
 * notification service resolves user details, tenant name, and the action URL at
 * delivery time via authenticated internal API calls.
 * cryptoShredKeyId is MANDATORY — enables GDPR erasure via crypto-shredding.
 *
 * BREAKING CHANGE: email, firstName, lastName, tenantName, actionUrl fields removed.
 * Consumers must resolve these via userId/tenantId lookups.
 */
export interface UserInvitedEvent extends BaseEvent {
  eventType: 'UserInvited';
  /** Invited user — opaque reference, NOT PII */
  userId: string;
  /** Role assigned to the invited user */
  role: string;
  /** User who sent the invitation (opaque reference) */
  invitedBy?: string;
  /** Whether to send a password reset link or other credential type */
  credentialType: 'temporary_password' | 'reset_token';
  /**
   * Opaque reference to the action token stored in auth-service.
   * The notification service uses this to build the invitation URL at delivery
   * time via a secure, authenticated internal API call.
   *
   * SECURITY: The actual invitation token / URL is NEVER placed on the event bus.
   */
  actionTokenId: string;
  /**
   * MANDATORY for events related to user PII.
   * Enables GDPR erasure via crypto-shredding.
   */
  cryptoShredKeyId: string;
}

/**
 * Notification Sent Event
 * Represents a successfully dispatched notification.
 * For failures, see `NotificationFailedEvent`.
 */
export interface NotificationSentEvent extends BaseEvent {
  eventType: 'NotificationSent';
  notificationId: string;
  channel: 'email' | 'sms' | 'push' | 'webhook';
  recipient: string;
  subject: string;
  externalId?: string;
}

/**
 * Notification Delivered Event
 */
export interface NotificationDeliveredEvent extends BaseEvent {
  eventType: 'NotificationDelivered';
  notificationId: string;
  channel: string;
  deliveredAt: string;
  externalId?: string;
}

/**
 * Notification Failed Event
 */
export interface NotificationFailedEvent extends BaseEvent {
  eventType: 'NotificationFailed';
  notificationId: string;
  channel: string;
  errorCode: string;
  errorMessage: string;
  retryCount: number;
  willRetry: boolean;
}

// ==================== Type Union ====================

/**
 * Union type for all notification events
 */
export type NotificationEvent =
  | UserInvitedEvent
  | NotificationSentEvent
  | NotificationDeliveredEvent
  | NotificationFailedEvent;
