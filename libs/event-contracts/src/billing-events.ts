import { BaseEvent, PlanTier } from './base-event';

/**
 * Subscription Created Event
 */
export interface SubscriptionCreatedEvent extends BaseEvent {
  eventType: 'SubscriptionCreated';
  subscriptionId: string;
  tier: PlanTier;
  monthlyPrice: number;
  currency: string;
  startDate: Date;
  features: Record<string, unknown>;
}

/**
 * Subscription Updated Event
 */
export interface SubscriptionUpdatedEvent extends BaseEvent {
  eventType: 'SubscriptionUpdated';
  subscriptionId: string;
  tier?: PlanTier;
  monthlyPrice?: number;
  currency?: string;
  startDate?: Date;
  features?: Record<string, unknown>;
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
 * Subscription Provisioning Failed Event
 * Published when the billing service fails to create a subscription
 * from a TenantSubscriptionRequested event.
 */
export interface SubscriptionProvisioningFailedEvent extends BaseEvent {
  eventType: 'SubscriptionProvisioningFailed';
  error: string;
  tier?: PlanTier;
  moduleIds?: string[];
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
  currency: string;
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
  currency: string;
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
  currency: string;
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
  currency: string;
  dueDate: Date;
  daysOverdue: number;
}

// ==================== Type Union ====================

/**
 * Union type for all billing events
 */
export type BillingEvent =
  | SubscriptionCreatedEvent
  | SubscriptionUpdatedEvent
  | SubscriptionCancelledEvent
  | SubscriptionProvisioningFailedEvent
  | InvoiceGeneratedEvent
  | PaymentReceivedEvent
  | PaymentFailedEvent
  | InvoiceOverdueEvent;
