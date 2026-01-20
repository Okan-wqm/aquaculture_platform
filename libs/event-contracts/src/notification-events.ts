import { BaseEvent } from './base-event';

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
