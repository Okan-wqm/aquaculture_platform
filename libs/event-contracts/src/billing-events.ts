import { BaseEvent, PlanTier } from './base-event';

/**
 * Typed subscription feature flags.
 * SECURITY: Replaces Record<string, unknown> to prevent arbitrary payloads
 * and ensure compile-time validation of feature flags.
 * @see DATA-HIGH-005 (Record<string,unknown> features field)
 */
export interface SubscriptionFeatures {
  /** Maximum number of users allowed under this subscription. */
  maxUsers?: number;
  /** Maximum number of farms allowed. */
  maxFarms?: number;
  /** Maximum number of ponds allowed. */
  maxPonds?: number;
  /** Maximum number of sensors allowed. */
  maxSensors?: number;
  /** Maximum number of employees allowed. */
  maxEmployees?: number;
  /** Whether AI analysis is included. */
  aiAnalysisEnabled?: boolean;
  /** Whether advanced reporting is included. */
  advancedReportingEnabled?: boolean;
  /** Whether real-time alerts are included. */
  realTimeAlertsEnabled?: boolean;
  /** Whether data export is included. */
  dataExportEnabled?: boolean;
  /** Whether API access is included. */
  apiAccessEnabled?: boolean;
  /** Plan-specific numeric limits (e.g., maxApiCalls, maxStorageMb). */
  limits?: Record<string, number>;
}

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
  /** Typed feature flags — replaces Record<string, unknown> for compile-time safety. */
  features: SubscriptionFeatures;
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
  /** Whether this update is a downgrade from a higher tier. */
  isDowngrade?: boolean;
  /** The plan tier before this update (e.g., 'professional' before downgrade to 'starter'). */
  previousPlanTier?: PlanTier;
  /** Typed feature flags — replaces Record<string, unknown> for compile-time safety. */
  features?: SubscriptionFeatures;
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
 * Subscription Plan Changed Event
 * Published when a tenant upgrades or downgrades their subscription plan.
 */
export interface SubscriptionPlanChangedEvent extends BaseEvent {
  eventType: 'SubscriptionPlanChanged';
  subscriptionId: string;
  previousTier: PlanTier;
  newTier: PlanTier;
  previousPlanName: string;
  newPlanName: string;
  newPlanId: string;
  proRataCredit: number;
  currency: string;
  isUpgrade: boolean;
  effectiveDate: Date;
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
 * Payment Refunded Event
 */
export interface PaymentRefundedEvent extends BaseEvent {
  eventType: 'PaymentRefunded';
  paymentId: string;
  invoiceId: string;
  refundAmount: number;
  totalRefunded: number;
  currency: string;
  reason: string;
  refundId?: string;
  isFullRefund: boolean;
  refundedAt: Date;
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
  | SubscriptionPlanChangedEvent
  | SubscriptionProvisioningFailedEvent
  | InvoiceGeneratedEvent
  | PaymentReceivedEvent
  | PaymentFailedEvent
  | PaymentRefundedEvent
  | InvoiceOverdueEvent;
