import { BaseEvent } from './base-event';

/**
 * Subscription Created Event
 */
export interface SubscriptionCreatedEvent extends BaseEvent {
  eventType: 'SubscriptionCreated';
  subscriptionId: string;
  tier: 'basic' | 'pro' | 'enterprise';
  monthlyPrice: number;
  startDate: Date;
  features: Record<string, unknown>;
}

/**
 * Subscription Updated Event
 */
export interface SubscriptionUpdatedEvent extends BaseEvent {
  eventType: 'SubscriptionUpdated';
  subscriptionId: string;
  changes: Record<string, unknown>;
}

/**
 * Subscription Cancelled Event
 */
export interface SubscriptionCancelledEvent extends BaseEvent {
  eventType: 'SubscriptionCancelled';
  subscriptionId: string;
  cancellationDate: Date;
  effectiveEndDate: Date;
  reason?: string;
}

/**
 * Invoice Generated Event
 */
export interface InvoiceGeneratedEvent extends BaseEvent {
  eventType: 'InvoiceGenerated';
  invoiceId: string;
  invoiceNumber: string;
  subscriptionId: string;
  subtotal: number;
  tax: number;
  total: number;
  dueDate: Date;
  billingPeriodStart: Date;
  billingPeriodEnd: Date;
}

/**
 * Payment Received Event
 */
export interface PaymentReceivedEvent extends BaseEvent {
  eventType: 'PaymentReceived';
  paymentId: string;
  invoiceId: string;
  amount: number;
  paymentMethod: string;
  transactionId?: string;
  paidAt: Date;
}

/**
 * Payment Failed Event
 */
export interface PaymentFailedEvent extends BaseEvent {
  eventType: 'PaymentFailed';
  paymentId: string;
  invoiceId: string;
  amount: number;
  paymentMethod: string;
  failureReason: string;
  retryCount: number;
  willRetry: boolean;
}

/**
 * Invoice Overdue Event
 */
export interface InvoiceOverdueEvent extends BaseEvent {
  eventType: 'InvoiceOverdue';
  invoiceId: string;
  invoiceNumber: string;
  amount: number;
  dueDate: Date;
  daysOverdue: number;
}
