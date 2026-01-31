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
   * Temporary password or password reset token
   * Note: Should be handled securely and never logged
   */
  temporaryCredential?: string;
  /**
   * Whether this is a password reset token or temporary password
   */
  credentialType: 'temporary_password' | 'reset_token';
  /**
   * URL for password reset or first login
   */
  actionUrl?: string;
}

/**
 * Notification Sent Event
 */
export interface NotificationSentEvent extends BaseEvent {
  eventType: 'NotificationSent';
  notificationId: string;
  channel: 'email' | 'sms' | 'push' | 'webhook';
  recipient: string;
  subject: string;
  status: 'sent' | 'failed';
  externalId?: string;
  errorMessage?: string;
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
