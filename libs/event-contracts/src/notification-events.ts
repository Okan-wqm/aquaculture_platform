import { BaseEvent } from './base-event';

/**
 * User Invited Event - Triggered when a new user is created and needs welcome email
 */
export interface UserInvitedEvent extends BaseEvent {
  eventType: 'UserInvited';
  userId: string;
  email: string;
  firstName?: string;
  lastName?: string;
  role: string;
  tenantName: string;
  invitedBy?: string;
  /**
   * Whether to send a password reset link or other credential type
   */
  credentialType: 'temporary_password' | 'reset_token';
  /**
   * URL for password reset or first login.
   * Credentials are embedded as short-lived tokens in the URL query string.
   */
  actionUrl?: string;
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
  deliveredAt: Date;
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
