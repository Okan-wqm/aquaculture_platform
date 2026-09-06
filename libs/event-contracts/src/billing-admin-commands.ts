import type { BillingCycle, PlanTier } from './base-event';

/**
 * Platform-admin billing command contracts.
 *
 * admin-api-service exposes REST for the platform-admin panel, but billing-service
 * owns billing.* financial writes. These request-reply subjects keep that single
 * writer boundary explicit while still letting the admin panel use a REST facade.
 */

export const BILLING_ADMIN_COMMAND_SUBJECTS = {
  PROVISION_TENANT_SUBSCRIPTION: 'request.billing.tenant.provisionSubscription',
  CREATE_INVOICE: 'request.billing.admin.createInvoice',
  MARK_INVOICE_PAID: 'request.billing.admin.markInvoicePaid',
  VOID_INVOICE: 'request.billing.admin.voidInvoice',
  RECORD_PAYMENT: 'request.billing.admin.recordPayment',
  REFUND_PAYMENT: 'request.billing.admin.refundPayment',
  CHANGE_SUBSCRIPTION_PLAN: 'request.billing.admin.changeSubscriptionPlan',
  CANCEL_SUBSCRIPTION: 'request.billing.admin.cancelSubscription',
  REACTIVATE_SUBSCRIPTION: 'request.billing.admin.reactivateSubscription',
  EXTEND_SUBSCRIPTION_TRIAL: 'request.billing.admin.extendSubscriptionTrial',
  // Discount catalogue (ADR-0013): billing owns every row that prices a
  // subscription or an invoice. admin-api authors through these commands and
  // reads the rows back through a read-only mapping of the billing table.
  CREATE_DISCOUNT_CODE: 'request.billing.admin.createDiscountCode',
  UPDATE_DISCOUNT_CODE: 'request.billing.admin.updateDiscountCode',
  DEACTIVATE_DISCOUNT_CODE: 'request.billing.admin.deactivateDiscountCode',
  BULK_CREATE_DISCOUNT_CODES: 'request.billing.admin.bulkCreateDiscountCodes',
  GENERATE_DISCOUNT_CODE: 'request.billing.admin.generateDiscountCode',
  VALIDATE_DISCOUNT_CODE: 'request.billing.admin.validateDiscountCode',
  APPLY_DISCOUNT_CODE: 'request.billing.admin.applyDiscountCode',
} as const;

export interface BillingAdminCommandMeta {
  actorId: string;
  correlationId?: string;
}

export interface BillingModuleQuantities {
  moduleId: string;
  users?: number;
  farms?: number;
  ponds?: number;
  sensors?: number;
  employees?: number;
  devices?: number;
  storageGb?: number;
  apiCalls?: number;
  alerts?: number;
  reports?: number;
  integrations?: number;
}

/**
 * Fully resolved, priced module line for a provisioning command.
 *
 * admin-api OWNS `admin.module_pricing`, `PricingCalculatorService`, and module
 * code/name resolution (`auth.modules`, via its own grant). It resolves each
 * selected module into this shape BEFORE sending the provisioning command so
 * billing can write `billing.subscription_module_items` rows directly — with no
 * cross-schema `modules` lookup (billing has no grant on `auth.modules`) and no
 * invented $0 prices. When `moduleItems` is present it is the authoritative
 * source for module rows and the subscription's computed monthly price;
 * `moduleIds`/`moduleQuantities` remain for back-compat during the transition.
 *
 * A module with no `admin.module_pricing` catalog entry legitimately resolves to
 * subtotal/discountAmount/total = 0 (free/core tier) — an absent price is not an
 * error and must never fail provisioning.
 */
export interface BillingProvisioningModuleItem {
  moduleId: string;
  code: string;
  name: string;
  quantities?: BillingModuleQuantities;
  lineItems?: unknown[];
  subtotal: number;
  discountAmount: number;
  total: number;
}

export interface BillingTenantProvisioningCommand {
  operationId: string;
  tenantId: string;
  idempotencyKey: string;
  requestPayloadHash: string;
  actorId: string;
  tenantName: string;
  tier: PlanTier;
  billingCycle: BillingCycle;
  moduleIds: string[];
  moduleQuantities?: BillingModuleQuantities[];
  /**
   * Authoritative source for subscription module rows + computed price when
   * present. admin-api populates this on every provisioning command; billing
   * writes each row's code/name/quantities/subtotal/discountAmount/total from
   * here (real values, never 0) instead of a schema-unqualified `modules` query.
   */
  moduleItems?: BillingProvisioningModuleItem[];
  trialDays?: number;
  catalogVersionId?: string;
  quoteId?: string;
  customPlanId?: string;
}

export interface BillingTenantProvisioningResult {
  success: boolean;
  operationId: string;
  tenantId: string;
  subscriptionId?: string;
  status?: string;
  moduleItemCount?: number;
  receiptId?: string;
  resultHash?: string;
  replayed?: boolean;
  errorCode?: BillingAdminCommandErrorCode | 'CATALOG_MISSING';
  error?: string;
}

export interface BillingAdminAddress {
  companyName: string;
  attention?: string;
  street: string;
  city: string;
  state: string;
  postalCode: string;
  country: string;
  taxId?: string;
}

export interface BillingAdminInvoiceLineItem {
  description: string;
  quantity: number;
  unitPrice: number;
  productCode?: string;
}

export interface BillingAdminTaxInfo {
  taxRate: number;
  taxId?: string;
  taxName?: string;
}

export interface BillingAdminCreateInvoiceInput {
  subscriptionId?: string;
  billingAddress: BillingAdminAddress;
  lineItems: BillingAdminInvoiceLineItem[];
  tax?: BillingAdminTaxInfo;
  discount?: number;
  discountCode?: string;
  currency?: string;
  dueDate: string;
  periodStart: string;
  periodEnd: string;
  notes?: string;
}

export interface BillingAdminCreateInvoiceCommand extends BillingAdminCommandMeta {
  tenantId: string;
  input: BillingAdminCreateInvoiceInput;
}

export interface BillingAdminMarkInvoicePaidCommand extends BillingAdminCommandMeta {
  invoiceId: string;
  amount: number;
}

export interface BillingAdminVoidInvoiceCommand extends BillingAdminCommandMeta {
  invoiceId: string;
  reason: string;
}

export interface BillingAdminRecordPaymentInput {
  invoiceId: string;
  amount: number;
  paymentMethod: string;
  paymentDate?: string;
  currency?: string;
  notes?: string;
}

export interface BillingAdminRecordPaymentCommand extends BillingAdminCommandMeta {
  input: BillingAdminRecordPaymentInput;
}

export interface BillingAdminRefundPaymentInput {
  paymentId: string;
  amount: number;
  reason: string;
}

export interface BillingAdminRefundPaymentCommand extends BillingAdminCommandMeta {
  input: BillingAdminRefundPaymentInput;
}

export interface BillingAdminChangeSubscriptionPlanCommand extends BillingAdminCommandMeta {
  tenantId: string;
  currentPlanId?: string;
  newPlanId: string;
  immediate?: boolean;
  reason?: string;
}

export interface BillingAdminCancelSubscriptionCommand extends BillingAdminCommandMeta {
  tenantId: string;
  reason: string;
  cancelImmediately?: boolean;
}

export interface BillingAdminReactivateSubscriptionCommand extends BillingAdminCommandMeta {
  tenantId: string;
}

export interface BillingAdminExtendSubscriptionTrialCommand extends BillingAdminCommandMeta {
  tenantId: string;
  additionalDays: number;
}

export interface BillingAdminInvoiceResult {
  id: string;
  invoiceNumber: string;
  tenantId: string;
  subscriptionId?: string | null;
  amount: number;
  amountPaid: number;
  amountDue: number;
  status: string;
  currency: string;
  dueDate: string;
  paidAt?: string | null;
  issueDate: string;
  periodStart: string;
  periodEnd: string;
  createdAt: string;
  updatedAt: string;
}

export interface BillingAdminPaymentResult {
  id: string;
  tenantId: string;
  transactionId: string;
  invoiceId: string;
  amount: number;
  currency: string;
  status: string;
  paymentMethod: string;
  paymentDate: string;
  processedAt?: string | null;
  failureReason?: string | null;
  refundedAmount: number;
  notes?: string | null;
  createdAt: string;
  updatedAt: string;
  createdBy?: string | null;
}

export type BillingAdminCommandErrorCode =
  | 'NOT_FOUND'
  | 'VALIDATION_ERROR'
  | 'CONFLICT'
  | 'INTERNAL_ERROR';

export interface BillingAdminInvoiceCommandResult {
  success: boolean;
  invoice?: BillingAdminInvoiceResult;
  errorCode?: BillingAdminCommandErrorCode;
  error?: string;
}

export interface BillingAdminPaymentCommandResult {
  success: boolean;
  payment?: BillingAdminPaymentResult;
  errorCode?: BillingAdminCommandErrorCode;
  error?: string;
}

export interface BillingAdminSubscriptionCommandResult {
  success: boolean;
  effectiveDate?: string;
  newTrialEnd?: string;
  message?: string;
  errorCode?: BillingAdminCommandErrorCode;
  error?: string;
}

// ============================================================================
// Discount catalogue (ADR-0013 / BILLING-CRITICAL-002)
//
// The discount code, its redemptions and the money they move live in
// `billing`. Two rules make the shape honest on the wire:
//
//  1. Money and percentages cross as exact decimal STRINGS, never as
//     IEEE-754 numbers: '12.50' is the same value on both sides of the
//     transport, 12.5 is not necessarily.
//  2. A discount's VALUE is a discriminated union, not one polymorphic
//     `discountValue` column. `admin.discount_codes` stored a percentage
//     and an amount of money in the same `numeric(10,2)`, which is why no
//     CHECK constraint could exist: `150` was a legal 150% and a legal
//     $150 at once, and `free_months` silently computed a discount of 0.
//     Here the branch names its own field, so a percentage cannot exceed
//     100 and an amount must state its currency — the same split the
//     database CHECK constraints enforce.
// ============================================================================

export type BillingDiscountType =
  | 'percentage'
  | 'fixed_amount'
  | 'free_trial_extension'
  | 'free_months';

export type BillingDiscountAppliesTo =
  | 'all_plans'
  | 'specific_plans'
  | 'upgrades_only'
  | 'new_subscriptions_only';

export type BillingDiscountDuration = 'once' | 'repeating' | 'forever';

/**
 * What the redemption is being applied to. `appliesTo` restricts a code to
 * upgrades or to new subscriptions, and until now nothing carried the fact
 * that would decide it — so both restrictions permitted everything. The
 * caller states the change kind; a code that restricts one and is offered no
 * kind is refused, because "cannot tell" must not mean "allowed".
 */
export type BillingDiscountSubscriptionChange = 'new' | 'upgrade' | 'other';

/**
 * What the code takes off, by kind. Exactly one branch is inhabited, and the
 * branch determines which field carries the value — `billing.discount_codes`
 * holds the same four columns under the same CHECK.
 */
export type BillingDiscountValue =
  /** Exact decimal string in (0, 100]. */
  | { discountType: 'percentage'; percentOff: string }
  /** Exact decimal string > 0, denominated in the code's `currency`. */
  | { discountType: 'fixed_amount'; amountOff: string }
  /** Whole billing cycles granted free; moves no money at redemption time. */
  | { discountType: 'free_months'; freeMonths: number }
  /** Days added to the trial; moves no money at redemption time. */
  | { discountType: 'free_trial_extension'; trialExtensionDays: number };

/** Everything a discount code carries except its code and its value branch. */
export interface BillingDiscountCodeAttributes {
  name: string;
  description?: string;
  /** ISO-4217, upper-case. Denominates `amountOff` and `minimumOrderAmount`. */
  currency?: string;
  appliesTo?: BillingDiscountAppliesTo;
  applicablePlanIds?: string[];
  duration?: BillingDiscountDuration;
  durationInMonths?: number;
  validFrom?: string;
  validUntil?: string;
  maxRedemptions?: number;
  maxRedemptionsPerTenant?: number;
  /** Exact decimal string. */
  minimumOrderAmount?: string;
  campaignId?: string;
  campaignName?: string;
  isReferralCode?: boolean;
  referrerId?: string;
  metadata?: Record<string, unknown>;
}

/** The authoring payload: attributes plus exactly one value branch. */
export type BillingDiscountCodeInput = BillingDiscountCodeAttributes & BillingDiscountValue;

/** A row of `billing.discount_codes` as it crosses the wire. */
export type BillingDiscountCodeSnapshot = BillingDiscountCodeAttributes &
  BillingDiscountValue & {
    id: string;
    code: string;
    currency: string;
    isActive: boolean;
    currentRedemptions: number;
    stripePromotionCodeId?: string | null;
    stripeCouponId?: string | null;
    createdAt: string;
    updatedAt: string;
    createdBy?: string | null;
    updatedBy?: string | null;
  };

/** A row of `billing.discount_redemptions` as it crosses the wire. */
export interface BillingDiscountRedemptionSnapshot {
  id: string;
  discountCodeId: string;
  tenantId: string;
  subscriptionId?: string | null;
  invoiceId?: string | null;
  /** Exact decimal string. */
  discountAmount: string;
  currency: string;
  redeemedAt: string;
  redeemedBy?: string | null;
}

export interface BillingAdminCreateDiscountCodeCommand extends BillingAdminCommandMeta {
  code: string;
  input: BillingDiscountCodeInput;
}

/**
 * The mutable half of a discount code. The value branch, the code and the
 * campaign are immutable once minted: a code already handed to a customer
 * that silently changes what it is worth is a repudiation risk, so a
 * different offer is a different code.
 */
export interface BillingAdminUpdateDiscountCodeInput {
  name?: string;
  description?: string;
  isActive?: boolean;
  validFrom?: string;
  validUntil?: string;
  maxRedemptions?: number;
  maxRedemptionsPerTenant?: number;
  metadata?: Record<string, unknown>;
}

export interface BillingAdminUpdateDiscountCodeCommand extends BillingAdminCommandMeta {
  discountCodeId: string;
  input: BillingAdminUpdateDiscountCodeInput;
}

export interface BillingAdminDeactivateDiscountCodeCommand extends BillingAdminCommandMeta {
  discountCodeId: string;
}

export interface BillingAdminBulkCreateDiscountCodesCommand extends BillingAdminCommandMeta {
  count: number;
  codePrefix?: string;
  template: BillingDiscountCodeInput;
}

export interface BillingAdminGenerateDiscountCodeCommand extends BillingAdminCommandMeta {
  prefix?: string;
  length?: number;
}

export interface BillingAdminValidateDiscountCodeCommand extends BillingAdminCommandMeta {
  code: string;
  tenantId: string;
  planId?: string;
  subscriptionChange?: BillingDiscountSubscriptionChange;
  /** Exact decimal string. */
  orderAmount?: string;
}

export interface BillingAdminApplyDiscountCodeCommand extends BillingAdminCommandMeta {
  code: string;
  tenantId: string;
  /** Exact decimal string. */
  orderAmount: string;
  planId?: string;
  subscriptionChange?: BillingDiscountSubscriptionChange;
  subscriptionId?: string;
  invoiceId?: string;
}

/**
 * Why a code was refused. The caller renders the reason; it does not
 * re-derive it, so the rule and its message have one home (billing).
 */
export type BillingDiscountRejectionReason =
  | 'unknown_code'
  | 'inactive'
  | 'not_yet_valid'
  | 'expired'
  | 'redemption_limit_reached'
  | 'tenant_limit_reached'
  | 'plan_not_eligible'
  | 'upgrades_only'
  | 'new_subscriptions_only'
  | 'below_minimum_order';

export interface BillingAdminDiscountCodeCommandResult {
  success: boolean;
  discountCode?: BillingDiscountCodeSnapshot;
  errorCode?: BillingAdminCommandErrorCode;
  error?: string;
}

export interface BillingAdminBulkDiscountCodeCommandResult {
  success: boolean;
  discountCodes?: BillingDiscountCodeSnapshot[];
  errorCode?: BillingAdminCommandErrorCode;
  error?: string;
}

export interface BillingAdminGenerateDiscountCodeResult {
  success: boolean;
  code?: string;
  errorCode?: BillingAdminCommandErrorCode;
  error?: string;
}

export interface BillingAdminValidateDiscountCodeResult {
  success: boolean;
  valid: boolean;
  reason?: BillingDiscountRejectionReason;
  message?: string;
  /**
   * Exact decimal string. Present only when the caller supplied an
   * `orderAmount` AND the branch moves money — a `free_months` code is valid
   * and takes nothing off this invoice, which is not the same as `'0'`.
   */
  discountAmount?: string;
  discountCode?: BillingDiscountCodeSnapshot;
  errorCode?: BillingAdminCommandErrorCode;
  error?: string;
}

export interface BillingAdminApplyDiscountCodeResult {
  success: boolean;
  valid?: boolean;
  reason?: BillingDiscountRejectionReason;
  /** Exact decimal strings. */
  originalAmount?: string;
  discountAmount?: string;
  finalAmount?: string;
  /** Set by the `free_months` / `free_trial_extension` branches. */
  grantedFreeMonths?: number;
  grantedTrialExtensionDays?: number;
  redemptionId?: string;
  message?: string;
  errorCode?: BillingAdminCommandErrorCode;
  error?: string;
}
