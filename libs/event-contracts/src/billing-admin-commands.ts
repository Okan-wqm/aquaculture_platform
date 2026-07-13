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
