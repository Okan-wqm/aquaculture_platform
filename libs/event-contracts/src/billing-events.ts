import { BaseEvent, PlanTier } from './base-event';
import { BillingPlanTier } from './billing/billing-plan-tier';

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
  startDate: string;
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
  startDate?: string;
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
  cancellationDate: string;
  effectiveEndDate: string;
  reason?: string;
}

/**
 * Subscription Provisioning Failed Event
 * Intended for admin alerting when the billing service fails to provision a
 * subscription. NOTE (ORPHAN-LOW-396): currently has no emitter — its only
 * emitter was the deleted event-driven handler; tracked for wire-up or removal.
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
  effectiveDate: string;
}

/**
 * Subscription Plan Change Scheduled Event
 * Published when a plan change is accepted and journaled into the
 * scheduled_plan_changes operation saga (the durable journal that owns
 * both immediate and future plan changes). applyAfter is the wall-clock
 * moment the change becomes effective.
 */
export interface SubscriptionPlanChangeScheduledEvent extends BaseEvent {
  eventType: 'SubscriptionPlanChangeScheduled';
  operationId: string;
  subscriptionId: string;
  previousTier: BillingPlanTier;
  newTier: BillingPlanTier;
  previousPlanName: string;
  newPlanName: string;
  newPlanId: string;
  applyAfter: string;
}

/**
 * Subscription Plan Change Reconciliation Required Event
 * Published when a journaled plan-change operation exhausts its safe retry
 * path and lands in the RECONCILIATION_REQUIRED terminal state — an operator
 * must resolve the operation by hand (Stripe and the subscription may have
 * diverged).
 *
 * reasonCode mirrors the saga's lastAttemptErrorCode column (varchar(64)):
 * an open, length-bounded string today — the closed vocabulary lands with
 * the saga service that produces it, not ahead of it.
 */
export interface SubscriptionPlanChangeReconciliationRequiredEvent extends BaseEvent {
  eventType: 'SubscriptionPlanChangeReconciliationRequired';
  operationId: string;
  subscriptionId: string;
  reasonCode: string;
  detectedAt: string;
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
  dueDate: string;
  billingPeriodStart: string;
  billingPeriodEnd: string;
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
  paidAt: string;
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
  refundedAt: string;
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
  dueDate: string;
  daysOverdue: number;
}

/**
 * Subscription Past Due Event
 *
 * Published by billing-scheduler when a subscription's current cycle
 * has been unpaid past the grace window. Consumers (gateway-api,
 * notification-service) downgrade access tier and notify the tenant
 * admin.
 *
 * WHY: Pre-fix `BillingScheduler` emitted this via
 * `createBaseEvent('SubscriptionPastDue', …)` with NO interface in
 * billing-events.ts and no entry in `BillingEvent` union — DATA-HIGH-004
 * + CONTRACT-CRITICAL-002. A producer-side bump to add a new field
 * would not have surfaced as a consumer compile break, inviting
 * silent consumer crashes.
 */
export interface SubscriptionPastDueEvent extends BaseEvent {
  eventType: 'SubscriptionPastDue';
  subscriptionId: string;
  /** Number of days past due as of emission. */
  daysPastDue: number;
  /** Total outstanding amount in subunits (cents). */
  outstandingAmountMinorUnits: number;
  /** ISO 4217 currency code matching the subscription. */
  currency: string;
  /** When the grace period expires and access is suspended. ISO 8601 per BaseEvent contract. */
  gracePeriodExpiresAtIso: string;
}

/**
 * Subscription Expired Event
 *
 * Published when a subscription's grace window has elapsed without
 * payment. Consumers fully suspend tenant access and queue a final-
 * notice email. Distinct from SubscriptionCancelled (intentional
 * cancellation by tenant); Expired is involuntary.
 */
export interface SubscriptionExpiredEvent extends BaseEvent {
  eventType: 'SubscriptionExpired';
  subscriptionId: string;
  /** Final unpaid total at expiry, in minor units. */
  outstandingAmountMinorUnits: number;
  /** ISO 4217 currency code. */
  currency: string;
  /** When the subscription expired. ISO 8601 per BaseEvent contract. */
  expiredAtIso: string;
  /** Whether the tenant retains read-only access for export (typical: 30 days). */
  readOnlyAccessGranted: boolean;
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
  | InvoiceOverdueEvent
  | SubscriptionPastDueEvent
  | SubscriptionExpiredEvent
  | SubscriptionPlanChangeScheduledEvent
  | SubscriptionPlanChangeReconciliationRequiredEvent;
