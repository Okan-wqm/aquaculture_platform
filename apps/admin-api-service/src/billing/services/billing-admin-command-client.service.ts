import {
  BadGatewayException,
  BadRequestException,
  HttpException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { randomUUID } from 'crypto';
import {
  BILLING_ADMIN_COMMAND_SUBJECTS,
  type BillingAdminCommandMeta,
  type BillingAdminApplyDiscountCodeCommand,
  type BillingAdminApplyDiscountCodeResult,
  type BillingAdminBulkCreateDiscountCodesCommand,
  type BillingAdminBulkDiscountCodeCommandResult,
  type BillingAdminCreateDiscountCodeCommand,
  type BillingAdminDeactivateDiscountCodeCommand,
  type BillingAdminDiscountCodeCommandResult,
  type BillingAdminGenerateDiscountCodeCommand,
  type BillingAdminGenerateDiscountCodeResult,
  type BillingAdminUpdateDiscountCodeCommand,
  type BillingAdminUpdateDiscountCodeInput,
  type BillingAdminValidateDiscountCodeCommand,
  type BillingAdminValidateDiscountCodeResult,
  type BillingDiscountCodeInput,
  type BillingDiscountCodeSnapshot,
  type BillingDiscountSubscriptionChange,
  type BillingAdminDeactivateModulePriceCommand,
  type BillingAdminModulePriceCommandResult,
  type BillingAdminQuoteModuleSelectionCommand,
  type BillingAdminQuoteModuleSelectionResult,
  type BillingAdminSeedModulePricesCommand,
  type BillingAdminSeedModulePricesResult,
  type BillingAdminSetModulePriceCommand,
  type BillingModulePriceInput,
  type BillingModulePriceSnapshot,
  type BillingModuleQuote,
  type BillingModuleQuoteSelection,
  type BillingAdminCreatePlanCommand,
  type BillingAdminDeprecatePlanCommand,
  type BillingAdminPlanCommandResult,
  type BillingAdminUpdatePlanCommand,
  type BillingAdminCloneCustomPlanCommand,
  type BillingAdminCreateCustomPlanCommand,
  type BillingAdminCustomPlanCommandResult,
  type BillingAdminCustomPlanTransitionCommand,
  type BillingAdminDeleteCustomPlanResult,
  type BillingAdminRejectCustomPlanCommand,
  type BillingAdminUpdateCustomPlanCommand,
  type BillingCustomPlanInput,
  type BillingCustomPlanSnapshot,
  type BillingCustomPlanUpdateInput,
  type BillingPlanInput,
  type BillingPlanSnapshot,
  type BillingPlanUpdateInput,
  type BillingPlanTier,
  type BillingCycle,
  type BillingAdminCreateInvoiceCommand,
  type BillingAdminMarkInvoicePaidCommand,
  type BillingAdminVoidInvoiceCommand,
  type BillingAdminRecordPaymentCommand,
  type BillingAdminRefundPaymentCommand,
  type BillingAdminChangeSubscriptionPlanCommand,
  type BillingAdminCancelSubscriptionCommand,
  type BillingAdminReactivateSubscriptionCommand,
  type BillingAdminExtendSubscriptionTrialCommand,
  type BillingAdminCreateInvoiceInput,
  type BillingAdminInvoiceCommandResult,
  type BillingAdminInvoiceResult,
  type BillingAdminPaymentCommandResult,
  type BillingAdminPaymentResult,
  type BillingAdminRecordPaymentInput,
  type BillingAdminRefundPaymentInput,
  type BillingAdminSubscriptionCommandResult,
  type BillingTenantProvisioningCommand,
  type BillingTenantProvisioningResult,
} from '@platform/event-contracts';
import { getRequestContext } from '@aquaculture/backend-common/logging';
import { catchError, firstValueFrom, throwError, timeout } from 'rxjs';

const DEFAULT_BILLING_NATS_TIMEOUT_MS = 15_000;

/** `billing.command_receipts."idempotencyKey"` is VARCHAR(255). */
const MAX_IDEMPOTENCY_KEY_LENGTH = 255;

@Injectable()
export class BillingAdminCommandClientService {
  private readonly logger = new Logger(BillingAdminCommandClientService.name);

  private readonly timeoutMs: number;

  constructor(
    @Inject('BILLING_NATS_CLIENT')
    private readonly billingNatsClient: ClientProxy,
  ) {
    const configured = parseInt(process.env['BILLING_NATS_TIMEOUT_MS'] ?? '', 10);
    this.timeoutMs = Number.isFinite(configured) && configured > 0
      ? configured
      : DEFAULT_BILLING_NATS_TIMEOUT_MS;
  }

  async createInvoice(
    tenantId: string,
    input: BillingAdminCreateInvoiceInput,
    actorId: string,
  ): Promise<BillingAdminInvoiceResult> {
    const result = await this.sendBillingCommand<
      BillingAdminCreateInvoiceCommand,
      BillingAdminInvoiceCommandResult
    >(BILLING_ADMIN_COMMAND_SUBJECTS.CREATE_INVOICE, {
      tenantId,
      input,
      actorId,
    }, `create-invoice:${tenantId}`);
    return this.unwrapInvoiceResult(result);
  }

  async provisionTenantSubscription(
    command: Omit<BillingTenantProvisioningCommand, 'correlationId'>,
  ): Promise<BillingTenantProvisioningResult> {
    // Provisioning carries its OWN idempotency key, derived by the workflow from
    // the run and the request hash, and runs from a workflow continuation that
    // may have no HTTP frame at all. It is the one command that must not
    // require an operator header.
    const result = await this.dispatch<BillingTenantProvisioningResult>(
      BILLING_ADMIN_COMMAND_SUBJECTS.PROVISION_TENANT_SUBSCRIPTION,
      { correlationId: getRequestContext().correlationId ?? randomUUID(), ...command },
    );
    if (result.success) return result;
    throw this.mapBillingError(result.errorCode, result.error);
  }

  async markInvoicePaid(
    invoiceId: string,
    amount: number,
    actorId: string,
  ): Promise<BillingAdminInvoiceResult> {
    const result = await this.sendBillingCommand<
      BillingAdminMarkInvoicePaidCommand,
      BillingAdminInvoiceCommandResult
    >(BILLING_ADMIN_COMMAND_SUBJECTS.MARK_INVOICE_PAID, {
      invoiceId,
      amount,
      actorId,
    }, `mark-invoice-paid:${invoiceId}`);
    return this.unwrapInvoiceResult(result);
  }

  async voidInvoice(
    invoiceId: string,
    reason: string,
    actorId: string,
  ): Promise<BillingAdminInvoiceResult> {
    const result = await this.sendBillingCommand<
      BillingAdminVoidInvoiceCommand,
      BillingAdminInvoiceCommandResult
    >(BILLING_ADMIN_COMMAND_SUBJECTS.VOID_INVOICE, {
      invoiceId,
      reason,
      actorId,
    }, `void-invoice:${invoiceId}`);
    return this.unwrapInvoiceResult(result);
  }

  async recordPayment(
    input: BillingAdminRecordPaymentInput,
    actorId: string,
  ): Promise<BillingAdminPaymentResult> {
    const result = await this.sendBillingCommand<
      BillingAdminRecordPaymentCommand,
      BillingAdminPaymentCommandResult
    >(BILLING_ADMIN_COMMAND_SUBJECTS.RECORD_PAYMENT, {
      input,
      actorId,
    }, `record-payment:${input.invoiceId}`);
    return this.unwrapPaymentResult(result);
  }

  async refundPayment(
    input: BillingAdminRefundPaymentInput,
    actorId: string,
  ): Promise<BillingAdminPaymentResult> {
    const result = await this.sendBillingCommand<
      BillingAdminRefundPaymentCommand,
      BillingAdminPaymentCommandResult
    >(BILLING_ADMIN_COMMAND_SUBJECTS.REFUND_PAYMENT, {
      input,
      actorId,
    }, `refund-payment:${input.paymentId}`);
    return this.unwrapPaymentResult(result);
  }

  async changeSubscriptionPlan(
    input: {
      tenantId: string;
      currentPlanId?: string;
      newPlanId: string;
      effectiveImmediately?: boolean;
      changedBy?: string;
    },
    actorId: string,
  ): Promise<BillingAdminSubscriptionCommandResult> {
    const result = await this.sendBillingCommand<
      BillingAdminChangeSubscriptionPlanCommand,
      BillingAdminSubscriptionCommandResult
    >(BILLING_ADMIN_COMMAND_SUBJECTS.CHANGE_SUBSCRIPTION_PLAN, {
      tenantId: input.tenantId,
      currentPlanId: input.currentPlanId,
      newPlanId: input.newPlanId,
      immediate: input.effectiveImmediately,
      actorId,
    }, `change-plan:${input.tenantId}`);
    return this.unwrapSubscriptionResult(result);
  }

  async cancelSubscription(
    tenantId: string,
    reason: string,
    cancelImmediately: boolean | undefined,
    actorId: string,
  ): Promise<BillingAdminSubscriptionCommandResult> {
    const result = await this.sendBillingCommand<
      BillingAdminCancelSubscriptionCommand,
      BillingAdminSubscriptionCommandResult
    >(BILLING_ADMIN_COMMAND_SUBJECTS.CANCEL_SUBSCRIPTION, {
      tenantId,
      reason,
      cancelImmediately,
      actorId,
    }, `cancel-subscription:${tenantId}`);
    return this.unwrapSubscriptionResult(result);
  }

  async reactivateSubscription(
    tenantId: string,
    actorId: string,
  ): Promise<BillingAdminSubscriptionCommandResult> {
    const result = await this.sendBillingCommand<
      BillingAdminReactivateSubscriptionCommand,
      BillingAdminSubscriptionCommandResult
    >(BILLING_ADMIN_COMMAND_SUBJECTS.REACTIVATE_SUBSCRIPTION, {
      tenantId,
      actorId,
    }, `reactivate-subscription:${tenantId}`);
    return this.unwrapSubscriptionResult(result);
  }

  async extendSubscriptionTrial(
    tenantId: string,
    additionalDays: number,
    actorId: string,
  ): Promise<BillingAdminSubscriptionCommandResult> {
    const result = await this.sendBillingCommand<
      BillingAdminExtendSubscriptionTrialCommand,
      BillingAdminSubscriptionCommandResult
    >(BILLING_ADMIN_COMMAND_SUBJECTS.EXTEND_SUBSCRIPTION_TRIAL, {
      tenantId,
      additionalDays,
      actorId,
    }, `extend-trial:${tenantId}`);
    return this.unwrapSubscriptionResult(result);
  }

  // ── Discount catalogue (ADR-0013) ──────────────────────────────────────
  //
  // billing owns `billing.discount_codes` / `billing.discount_redemptions`;
  // admin-api authors through these commands and reads the rows back through
  // a read-only mapping. A rule refusal is NOT an error here — `validate` and
  // `apply` return the refusal so the operator sees the reason instead of a
  // 502 — but a malformed command still raises.

  async createDiscountCode(
    code: string,
    input: BillingDiscountCodeInput,
    actorId: string,
  ): Promise<BillingDiscountCodeSnapshot> {
    const result = await this.sendBillingCommand<
      BillingAdminCreateDiscountCodeCommand,
      BillingAdminDiscountCodeCommandResult
    >(BILLING_ADMIN_COMMAND_SUBJECTS.CREATE_DISCOUNT_CODE, { code, input, actorId }, `create-discount:${code}`);
    return this.unwrapDiscountCode(result);
  }

  async updateDiscountCode(
    discountCodeId: string,
    input: BillingAdminUpdateDiscountCodeInput,
    actorId: string,
  ): Promise<BillingDiscountCodeSnapshot> {
    const result = await this.sendBillingCommand<
      BillingAdminUpdateDiscountCodeCommand,
      BillingAdminDiscountCodeCommandResult
    >(BILLING_ADMIN_COMMAND_SUBJECTS.UPDATE_DISCOUNT_CODE, { discountCodeId, input, actorId }, `update-discount:${discountCodeId}`);
    return this.unwrapDiscountCode(result);
  }

  async deactivateDiscountCode(
    discountCodeId: string,
    actorId: string,
  ): Promise<BillingDiscountCodeSnapshot> {
    const result = await this.sendBillingCommand<
      BillingAdminDeactivateDiscountCodeCommand,
      BillingAdminDiscountCodeCommandResult
    >(BILLING_ADMIN_COMMAND_SUBJECTS.DEACTIVATE_DISCOUNT_CODE, { discountCodeId, actorId }, `deactivate-discount:${discountCodeId}`);
    return this.unwrapDiscountCode(result);
  }

  async bulkCreateDiscountCodes(
    count: number,
    template: BillingDiscountCodeInput,
    actorId: string,
    codePrefix?: string,
  ): Promise<BillingDiscountCodeSnapshot[]> {
    const result = await this.sendBillingCommand<
      BillingAdminBulkCreateDiscountCodesCommand,
      BillingAdminBulkDiscountCodeCommandResult
    >(BILLING_ADMIN_COMMAND_SUBJECTS.BULK_CREATE_DISCOUNT_CODES, {
      count,
      codePrefix,
      template,
      actorId,
    }, `bulk-discounts:${codePrefix ?? 'auto'}:${count}`);
    if (result.success && result.discountCodes) return result.discountCodes;
    throw this.mapBillingError(result.errorCode, result.error);
  }

  async generateDiscountCode(actorId: string, prefix?: string, length?: number): Promise<string> {
    const result = await this.sendBillingCommand<
      BillingAdminGenerateDiscountCodeCommand,
      BillingAdminGenerateDiscountCodeResult
    >(BILLING_ADMIN_COMMAND_SUBJECTS.GENERATE_DISCOUNT_CODE, { prefix, length, actorId }, `generate-discount:${prefix ?? 'auto'}`);
    if (result.success && result.code) return result.code;
    throw this.mapBillingError(result.errorCode, result.error);
  }

  async validateDiscountCode(
    code: string,
    tenantId: string,
    actorId: string,
    context: {
      planId?: string;
      subscriptionChange?: BillingDiscountSubscriptionChange;
      orderAmount?: string;
    },
  ): Promise<BillingAdminValidateDiscountCodeResult> {
    const result = await this.sendBillingCommand<
      BillingAdminValidateDiscountCodeCommand,
      BillingAdminValidateDiscountCodeResult
    >(BILLING_ADMIN_COMMAND_SUBJECTS.VALIDATE_DISCOUNT_CODE, {
      code,
      tenantId,
      planId: context.planId,
      subscriptionChange: context.subscriptionChange,
      orderAmount: context.orderAmount,
      actorId,
    }, `validate-discount:${code}:${tenantId}`);
    if (!result.success) throw this.mapBillingError(result.errorCode, result.error);
    return result;
  }

  async applyDiscountCode(
    code: string,
    tenantId: string,
    orderAmount: string,
    actorId: string,
    context: {
      planId?: string;
      subscriptionChange?: BillingDiscountSubscriptionChange;
      subscriptionId?: string;
      invoiceId?: string;
    },
  ): Promise<BillingAdminApplyDiscountCodeResult> {
    const result = await this.sendBillingCommand<
      BillingAdminApplyDiscountCodeCommand,
      BillingAdminApplyDiscountCodeResult
    >(BILLING_ADMIN_COMMAND_SUBJECTS.APPLY_DISCOUNT_CODE, {
      code,
      tenantId,
      orderAmount,
      planId: context.planId,
      subscriptionChange: context.subscriptionChange,
      subscriptionId: context.subscriptionId,
      invoiceId: context.invoiceId,
      actorId,
    }, `apply-discount:${code}:${tenantId}`);
    if (!result.success) throw this.mapBillingError(result.errorCode, result.error);
    return result;
  }

  private unwrapDiscountCode(
    result: BillingAdminDiscountCodeCommandResult,
  ): BillingDiscountCodeSnapshot {
    if (result.success && result.discountCode) return result.discountCode;
    throw this.mapBillingError(result.errorCode, result.error);
  }

  // ── Module price sheet + quotes (ADR-0013) ─────────────────────────────
  //
  // billing owns `billing.module_prices` AND the arithmetic that turns a
  // module selection into a price. admin-api authors the sheet through these
  // commands, reads the rows back through a read-only mapping, and ASKS for
  // the quote instead of recomputing it.

  async setModulePrice(
    input: BillingModulePriceInput,
    actorId: string,
  ): Promise<BillingModulePriceSnapshot> {
    const result = await this.sendBillingCommand<
      BillingAdminSetModulePriceCommand,
      BillingAdminModulePriceCommandResult
    >(BILLING_ADMIN_COMMAND_SUBJECTS.SET_MODULE_PRICE, { input, actorId }, `set-module-price:${input.moduleCode}`);
    return this.unwrapModulePrice(result);
  }

  async deactivateModulePrice(
    modulePriceId: string,
    actorId: string,
  ): Promise<BillingModulePriceSnapshot> {
    const result = await this.sendBillingCommand<
      BillingAdminDeactivateModulePriceCommand,
      BillingAdminModulePriceCommandResult
    >(BILLING_ADMIN_COMMAND_SUBJECTS.DEACTIVATE_MODULE_PRICE, { modulePriceId, actorId }, `deactivate-module-price:${modulePriceId}`);
    return this.unwrapModulePrice(result);
  }

  async seedModulePrices(
    moduleIds: Array<{ moduleCode: string; moduleId: string }>,
    actorId: string,
  ): Promise<number> {
    const result = await this.sendBillingCommand<
      BillingAdminSeedModulePricesCommand,
      BillingAdminSeedModulePricesResult
    >(BILLING_ADMIN_COMMAND_SUBJECTS.SEED_MODULE_PRICES, { moduleIds, actorId }, `seed-module-prices:${moduleIds.length}`);
    if (result.success && result.seeded !== undefined) return result.seeded;
    throw this.mapBillingError(result.errorCode, result.error);
  }

  async quoteModuleSelection(
    request: {
      modules: BillingModuleQuoteSelection[];
      tier: BillingPlanTier;
      billingCycle: BillingCycle;
      tenantId?: string;
      discountCode?: string;
      subscriptionChange?: BillingDiscountSubscriptionChange;
      taxRate?: string;
      negotiatedDiscountPercent?: string;
      negotiatedDiscountAmount?: string;
    },
    actorId: string,
  ): Promise<BillingModuleQuote> {
    const result = await this.sendBillingCommand<
      BillingAdminQuoteModuleSelectionCommand,
      BillingAdminQuoteModuleSelectionResult
    >(BILLING_ADMIN_COMMAND_SUBJECTS.QUOTE_MODULE_SELECTION, { ...request, actorId }, `quote-modules:${request.tier}:${request.billingCycle}`);
    if (result.success && result.quote) return result.quote;
    throw this.mapBillingError(result.errorCode, result.error);
  }

  private unwrapModulePrice(
    result: BillingAdminModulePriceCommandResult,
  ): BillingModulePriceSnapshot {
    if (result.success && result.modulePrice) return result.modulePrice;
    throw this.mapBillingError(result.errorCode, result.error);
  }

  // ── Plan catalogue (ADR-0013) ──────────────────────────────────────────
  //
  // `billing.plans` is the ONLY catalogue. admin-panel remains the authoring
  // UI; admin-api forwards the authored plan here and maps the reply back
  // through the same read shape a GET returns, so an operator sees exactly the
  // row every runtime path will resolve.

  async createPlan(input: BillingPlanInput, actorId: string): Promise<BillingPlanSnapshot> {
    const result = await this.sendBillingCommand<
      BillingAdminCreatePlanCommand,
      BillingAdminPlanCommandResult
    >(BILLING_ADMIN_COMMAND_SUBJECTS.CREATE_PLAN, { input, actorId }, `create-plan:${input.tier}:${input.code ?? input.name}`);
    return this.unwrapPlan(result);
  }

  async updatePlan(
    planId: string,
    input: BillingPlanUpdateInput,
    actorId: string,
  ): Promise<BillingPlanSnapshot> {
    const result = await this.sendBillingCommand<
      BillingAdminUpdatePlanCommand,
      BillingAdminPlanCommandResult
    >(BILLING_ADMIN_COMMAND_SUBJECTS.UPDATE_PLAN, { planId, input, actorId }, `update-plan:${planId}`);
    return this.unwrapPlan(result);
  }

  async deprecatePlan(planId: string, actorId: string): Promise<BillingPlanSnapshot> {
    const result = await this.sendBillingCommand<
      BillingAdminDeprecatePlanCommand,
      BillingAdminPlanCommandResult
    >(BILLING_ADMIN_COMMAND_SUBJECTS.DEPRECATE_PLAN, { planId, actorId }, `deprecate-plan:${planId}`);
    return this.unwrapPlan(result);
  }

  private unwrapPlan(result: BillingAdminPlanCommandResult): BillingPlanSnapshot {
    if (result.success && result.plan) return result.plan;
    throw this.mapBillingError(result.errorCode, result.error);
  }

  // ── Custom plans (ADR-0013) ────────────────────────────────────────────
  //
  // A negotiated per-tenant price lives with the prices. admin-panel keeps the
  // builder; admin-api forwards the selection and billing prices it with the
  // same code that will price its invoice — admin multiplies nothing, and the
  // lifecycle guard lives with the row rather than in the caller.

  async createCustomPlan(
    input: BillingCustomPlanInput,
    actorId: string,
  ): Promise<BillingCustomPlanSnapshot> {
    const result = await this.sendBillingCommand<
      BillingAdminCreateCustomPlanCommand,
      BillingAdminCustomPlanCommandResult
    >(BILLING_ADMIN_COMMAND_SUBJECTS.CREATE_CUSTOM_PLAN, { input, actorId }, `create-custom-plan:${input.tenantId}`);
    return this.unwrapCustomPlan(result);
  }

  async updateCustomPlan(
    customPlanId: string,
    input: BillingCustomPlanUpdateInput,
    actorId: string,
  ): Promise<BillingCustomPlanSnapshot> {
    const result = await this.sendBillingCommand<
      BillingAdminUpdateCustomPlanCommand,
      BillingAdminCustomPlanCommandResult
    >(BILLING_ADMIN_COMMAND_SUBJECTS.UPDATE_CUSTOM_PLAN, { customPlanId, input, actorId }, `update-custom-plan:${customPlanId}`);
    return this.unwrapCustomPlan(result);
  }

  async submitCustomPlan(
    customPlanId: string,
    actorId: string,
  ): Promise<BillingCustomPlanSnapshot> {
    return this.transitionCustomPlan(
      BILLING_ADMIN_COMMAND_SUBJECTS.SUBMIT_CUSTOM_PLAN,
      customPlanId,
      actorId,
      `submit-custom-plan:${customPlanId}`,
    );
  }

  async approveCustomPlan(
    customPlanId: string,
    actorId: string,
  ): Promise<BillingCustomPlanSnapshot> {
    return this.transitionCustomPlan(
      BILLING_ADMIN_COMMAND_SUBJECTS.APPROVE_CUSTOM_PLAN,
      customPlanId,
      actorId,
      `approve-custom-plan:${customPlanId}`,
    );
  }

  async rejectCustomPlan(
    customPlanId: string,
    reason: string,
    actorId: string,
  ): Promise<BillingCustomPlanSnapshot> {
    const result = await this.sendBillingCommand<
      BillingAdminRejectCustomPlanCommand,
      BillingAdminCustomPlanCommandResult
    >(BILLING_ADMIN_COMMAND_SUBJECTS.REJECT_CUSTOM_PLAN, { customPlanId, reason, actorId }, `reject-custom-plan:${customPlanId}`);
    return this.unwrapCustomPlan(result);
  }

  /** Records the subscription the plan was provisioned into and closes it. */
  async activateCustomPlan(
    customPlanId: string,
    subscriptionId: string,
    actorId: string,
  ): Promise<BillingCustomPlanSnapshot> {
    const result = await this.sendBillingCommand<
      BillingAdminCustomPlanTransitionCommand & { subscriptionId: string },
      BillingAdminCustomPlanCommandResult
    >(BILLING_ADMIN_COMMAND_SUBJECTS.ACTIVATE_CUSTOM_PLAN, {
      customPlanId,
      subscriptionId,
      actorId,
    }, `activate-custom-plan:${customPlanId}`);
    return this.unwrapCustomPlan(result);
  }

  async cloneCustomPlan(
    customPlanId: string,
    targetTenantId: string,
    actorId: string,
  ): Promise<BillingCustomPlanSnapshot> {
    const result = await this.sendBillingCommand<
      BillingAdminCloneCustomPlanCommand,
      BillingAdminCustomPlanCommandResult
    >(BILLING_ADMIN_COMMAND_SUBJECTS.CLONE_CUSTOM_PLAN, {
      customPlanId,
      targetTenantId,
      actorId,
    }, `clone-custom-plan:${customPlanId}:${targetTenantId}`);
    return this.unwrapCustomPlan(result);
  }

  async deleteCustomPlan(customPlanId: string, actorId: string): Promise<void> {
    const result = await this.sendBillingCommand<
      BillingAdminCustomPlanTransitionCommand,
      BillingAdminDeleteCustomPlanResult
    >(BILLING_ADMIN_COMMAND_SUBJECTS.DELETE_CUSTOM_PLAN, { customPlanId, actorId }, `delete-custom-plan:${customPlanId}`);
    if (!result.success) throw this.mapBillingError(result.errorCode, result.error);
  }

  private async transitionCustomPlan(
    subject: string,
    customPlanId: string,
    actorId: string,
    operationScope: string,
  ): Promise<BillingCustomPlanSnapshot> {
    const result = await this.sendBillingCommand<
      BillingAdminCustomPlanTransitionCommand,
      BillingAdminCustomPlanCommandResult
    >(subject, { customPlanId, actorId }, operationScope);
    return this.unwrapCustomPlan(result);
  }

  private unwrapCustomPlan(
    result: BillingAdminCustomPlanCommandResult,
  ): BillingCustomPlanSnapshot {
    if (result.success && result.customPlan) return result.customPlan;
    throw this.mapBillingError(result.errorCode, result.error);
  }

  /**
   * Compose the ADR-0014 meta for one command.
   *
   * The idempotency key is the operator's `Idempotency-Key` header composed
   * with a scope that names the operation. Both halves are load-bearing:
   *
   *  - the HEADER is what stays stable across retries. admin-panel's
   *    `apiFetch` mints it once per call and re-sends it on each of its own
   *    502/503/504 retries, so a refund whose reply was lost in a gateway
   *    timeout arrives at billing under the key it already used.
   *  - the SCOPE keeps two different commands raised by ONE request apart
   *    (activating a custom plan provisions and then activates). Without it
   *    the second would look like the first replayed under a changed payload
   *    and be refused.
   *
   * There is deliberately no fallback: minting a key here would produce a
   * fresh value per attempt, which is no key at all.
   */
  private billingCommandMeta(operationScope: string): {
    idempotencyKey: string;
    correlationId: string;
  } {
    const context = getRequestContext();
    const requestKey = context.idempotencyKey;
    if (!requestKey) {
      throw new BadRequestException(
        'This billing operation must carry an `Idempotency-Key` header naming the operation. ' +
          'Send the SAME key on every retry of one action and a fresh key for a new action, ' +
          'so a retry cannot charge, refund or provision twice (ADR-0014).',
      );
    }
    const idempotencyKey = `${requestKey}:${operationScope}`;
    if (idempotencyKey.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
      throw new BadRequestException(
        `\`Idempotency-Key\` is too long: the composed key exceeds ${MAX_IDEMPOTENCY_KEY_LENGTH} characters.`,
      );
    }
    return {
      idempotencyKey,
      // Diagnostic, not the idempotency anchor: it joins the receipt to this
      // request's audit row and log lines.
      correlationId: context.correlationId ?? randomUUID(),
    };
  }

  private async sendBillingCommand<TCommand extends BillingAdminCommandMeta, TResult>(
    subject: string,
    command: Omit<TCommand, 'idempotencyKey' | 'correlationId'>,
    operationScope: string,
  ): Promise<TResult> {
    return this.dispatch<TResult>(subject, { ...command, ...this.billingCommandMeta(operationScope) });
  }

  private async dispatch<TResult>(subject: string, command: object): Promise<TResult> {
    try {
      return await firstValueFrom(
        this.billingNatsClient.send<TResult, object>(subject, command).pipe(
          timeout(this.timeoutMs),
          catchError((err: Error) => {
            this.logger.error(
              `NATS request failed: subject=${subject}, error=${err.message}`,
            );
            return throwError(() => err);
          }),
        ),
      );
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('Timeout')) {
        throw new BadGatewayException(
          `Billing service did not respond within ${this.timeoutMs}ms`,
        );
      }
      if (message.includes('not connected') || message.includes('CONN_CLOSED')) {
        throw new ServiceUnavailableException(
          'Billing service is currently unavailable',
        );
      }
      if (err instanceof HttpException) throw err;
      throw new BadGatewayException(`Billing service error: ${message}`);
    }
  }

  private unwrapInvoiceResult(
    result: BillingAdminInvoiceCommandResult,
  ): BillingAdminInvoiceResult {
    if (result.success && result.invoice) {
      return result.invoice;
    }
    throw this.mapBillingError(result.errorCode, result.error);
  }

  private unwrapPaymentResult(
    result: BillingAdminPaymentCommandResult,
  ): BillingAdminPaymentResult {
    if (result.success && result.payment) {
      return result.payment;
    }
    throw this.mapBillingError(result.errorCode, result.error);
  }

  private unwrapSubscriptionResult(
    result: BillingAdminSubscriptionCommandResult,
  ): BillingAdminSubscriptionCommandResult {
    if (result.success) {
      return result;
    }
    throw this.mapBillingError(result.errorCode, result.error);
  }

  private mapBillingError(
    errorCode: BillingAdminInvoiceCommandResult['errorCode'] | 'CATALOG_MISSING',
    error?: string,
  ): HttpException {
    const message = error ?? 'Billing command failed';
    switch (errorCode) {
      case 'CATALOG_MISSING':
      case 'NOT_FOUND':
        return new NotFoundException(message);
      case 'VALIDATION_ERROR':
      case 'CONFLICT':
        return new BadRequestException(message);
      case 'INTERNAL_ERROR':
      default:
        return new BadGatewayException(message);
    }
  }
}
