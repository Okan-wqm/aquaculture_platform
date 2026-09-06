import * as crypto from 'crypto';

import {
  BadRequestException,
  ConflictException,
  Controller,
  Logger,
  NotFoundException,
  UseInterceptors,
} from '@nestjs/common';
import { CommandBus } from '@nestjs/cqrs';
import { MessagePattern, Payload } from '@nestjs/microservices';
import {
  BILLING_ADMIN_COMMAND_SUBJECTS,
  type BillingTenantProvisioningCommand,
  type BillingTenantProvisioningResult,
  type BillingAdminCreateInvoiceCommand,
  type BillingAdminChangeSubscriptionPlanCommand,
  type BillingAdminCancelSubscriptionCommand,
  type BillingAdminExtendSubscriptionTrialCommand,
  type BillingAdminInvoiceCommandResult,
  type BillingAdminInvoiceResult,
  type BillingAdminMarkInvoicePaidCommand,
  type BillingAdminPaymentCommandResult,
  type BillingAdminPaymentResult,
  type BillingAdminReactivateSubscriptionCommand,
  type BillingAdminRecordPaymentCommand,
  type BillingAdminRefundPaymentCommand,
  type BillingAdminSubscriptionCommandResult,
  type BillingAdminVoidInvoiceCommand,
} from '@platform/event-contracts';
import { BypassRlsService } from '@aquaculture/backend-common/database';
import Decimal from 'decimal.js';
import { DataSource, EntityManager } from 'typeorm';

import {
  BillingCommandReceiptInterceptor,
  OwnsBillingCommandReceipt,
} from '../interceptors/billing-command-receipt.interceptor';
import { stableStringify } from '../services/billing-command-receipt.service';
import { CancelSubscriptionCommand } from '../commands/cancel-subscription.command';
import { ChangeSubscriptionPlanCommand } from '../commands/change-subscription-plan.command';
import {
  SubscriptionWriterService,
  type StripeSubscriptionRefs,
} from '../services/subscription-writer.service';
import { CreateInvoiceCommand } from '../commands/create-invoice.command';
import { ExtendSubscriptionTrialCommand } from '../commands/extend-subscription-trial.command';
import { ReactivateSubscriptionCommand } from '../commands/reactivate-subscription.command';
import { RecordPaymentCommand } from '../commands/record-payment.command';
import { RefundPaymentCommand } from '../commands/refund-payment.command';
import { VoidInvoiceCommand } from '../commands/void-invoice.command';
import { ChangeSubscriptionPlanInput } from '../dto/change-subscription-plan.input';
import { CreateInvoiceInput } from '../dto/create-invoice.input';
import { RecordPaymentInput } from '../dto/record-payment.input';
import { RefundPaymentInput } from '../dto/refund-payment.input';
import { Invoice } from '../entities/invoice.entity';
import { Payment, PaymentMethod } from '../entities/payment.entity';
import { Plan } from '../entities/plan.entity';
import {
  BillingCycle,
  PlanTier,
  Subscription,
  SubscriptionStatus,
} from '../entities/subscription.entity';

interface TenantLookupRow {
  tenantId: string;
}

interface SubscriptionLookupRow {
  id: string;
  status: SubscriptionStatus;
  currentPeriodEnd: Date | string;
  trialEndDate?: Date | string | null;
}

interface InvoiceSnapshotRow {
  id: string;
  invoiceNumber: string;
  tenantId: string;
  subscriptionId?: string | null;
  amount: string | number;
  amountPaid: string | number;
  amountDue: string | number;
  status: string;
  currency: string;
  dueDate: Date | string;
  paidAt?: Date | string | null;
  issueDate: Date | string;
  periodStart: Date | string;
  periodEnd: Date | string;
  createdAt: Date | string;
  updatedAt: Date | string;
}

interface BillingCommandReceiptRow {
  id: string;
  payloadHash: string;
  status: 'STARTED' | 'SUCCEEDED' | 'FAILED';
  resultSummary?: Record<string, unknown> | null;
  updatedAt: Date | string;
}

interface ActiveSubscriptionRow {
  id: string;
  status: string;
  planId?: string | null;
}

/**
 * NATS request-reply surface for platform-admin billing writes.
 *
 * admin-api-service must not update billing.* directly. This controller is
 * registered as a microservice controller so billing-service remains the
 * single writer and all writes go through the existing CQRS handlers.
 */
@Controller()
@UseInterceptors(BillingCommandReceiptInterceptor)
export class BillingAdminNatsHandler {
  private readonly logger = new Logger(BillingAdminNatsHandler.name);

  constructor(
    private readonly commandBus: CommandBus,
    private readonly dataSource: DataSource,
    private readonly subscriptionWriter: SubscriptionWriterService,
    private readonly bypassRls: BypassRlsService,
  ) {}

  /**
   * Run a trusted platform-admin billing command under an AUDITED RLS bypass.
   *
   * WHY: every method on this controller is a cert-CN-authenticated,
   * cross-tenant admin NATS command issued by admin-api-service. It arrives with
   * NO HTTP request context — `TenantContextMiddleware` (which sets
   * `app.current_tenant` from the JWT) only runs on the HTTP surface, so on the
   * NATS path the RLS GUCs default to `app.current_tenant = ''` and
   * `app.bypass_rls = 'off'`. billing's `tenant_isolation_policy`
   * (`bypass OR "tenantId" = current_setting('app.current_tenant')`) then
   * evaluates deny-by-default and rejects every write/read against the
   * RLS-protected billing tables (command_receipts, subscriptions,
   * subscription_module_items, invoices, payments). For provisioning that
   * surfaced as `new row violates row-level security policy for table
   * "command_receipts"`, aborting the whole SERIALIZABLE transaction and leaving
   * billing.subscriptions at 0 rows despite active tenants (the 2nd half of the
   * 0-subscriptions root cause).
   *
   * WHAT: `withBypass` sets `app.bypass_rls = 'on'` for the entire command via an
   * AsyncLocalStorage frame that `RlsConnectionBootstrap` reads on every pool
   * checkout — so a single grant covers the receipt AND every subsequent
   * tenant-scoped write in the same transaction, PLUS the out-of-transaction
   * failure-receipt write in the catch block. Each grant logs RLS BYPASS
   * GRANTED/RELEASED [billing-admin:<op>] so the cross-tenant access stays
   * auditable, mirroring how admin-api-service wraps its own reconcile endpoint.
   *
   * WHY bypass and NOT `app.current_tenant = command.tenantId`: plan resolution
   * reads `billing.plans`, a cross-tenant CATALOG table with no tenantId column
   * (and therefore no tenant RLS policy). A tenant GUC would not help that read
   * and would still deny the RLS-bearing writes for any tenant the pooled
   * connection did not happen to carry. Bypass is the correct primitive: every
   * write here still sets `tenantId = command.tenantId` EXPLICITLY, so rows land
   * in the correct tenant — the bypass only lets the write THROUGH, it never
   * misroutes it.
   */
  private async runAsTrustedAdminBypass<T>(operation: string, work: () => Promise<T>): Promise<T> {
    return this.bypassRls.withBypass(`billing-admin:${operation}`, work);
  }

  // Provisioning writes its OWN receipt INSIDE the SERIALIZABLE transaction that
  // creates the subscription, so the receipt and the work commit or roll back
  // together — strictly stronger than the interceptor's before/after pair.
  @OwnsBillingCommandReceipt()
  @MessagePattern(BILLING_ADMIN_COMMAND_SUBJECTS.PROVISION_TENANT_SUBSCRIPTION)
  async provisionTenantSubscription(
    @Payload() command: BillingTenantProvisioningCommand,
  ): Promise<BillingTenantProvisioningResult> {
    const commandType = 'ProvisionTenantSubscription';
    const payloadHash = this.hashBillingPayload({
      tenantId: command.tenantId,
      tenantName: command.tenantName,
      tier: command.tier,
      billingCycle: command.billingCycle,
      moduleIds: command.moduleIds,
      moduleQuantities: command.moduleQuantities,
      moduleItems: command.moduleItems,
      trialDays: command.trialDays,
      catalogVersionId: command.catalogVersionId,
      quoteId: command.quoteId,
      customPlanId: command.customPlanId,
    });

    // Trusted cross-tenant admin command with no HTTP tenant context — the
    // whole command (receipt + subscription writes AND the catch-block failure
    // receipt) runs under one audited RLS bypass. See runAsTrustedAdminBypass.
    return this.runAsTrustedAdminBypass('provision-tenant-subscription', async () => {
      try {
        // Boundary validation (ORPHAN-CRITICAL-393): admin-api resolves each
        // module's code/name/price and passes priced `moduleItems`. If a command
        // selects modules but carries no resolved items, reject at the boundary
        // (VALIDATION_ERROR) — before the transaction opens, never mid-transaction
        // after a subscription row is written (the silent-rollback class removed).
        this.assertProvisioningModuleItems(command);

        // ADR-0014: mint the Stripe objects BEFORE the SERIALIZABLE receipt
        // transaction opens — a network call inside it would hold a pool
        // connection for its whole duration (SSOT-C-12). The keys are
        // deterministic, so the receipt's own replay-on-retry reuses the same
        // Stripe customer and subscription rather than creating a second pair.
        const provisioningPlan = await this.resolveProvisioningPlan(
          this.dataSource.manager,
          command,
        );
        const stripeRefs = await this.subscriptionWriter.ensureStripeObjects({
          tenantId: command.tenantId,
          plan: provisioningPlan,
          billingCycle: provisioningPlan.billingCycle,
        });

        return await this.dataSource.transaction('SERIALIZABLE', async (manager) => {
          const receipt = await this.prepareBillingReceipt(
            manager,
            command,
            commandType,
            payloadHash,
          );
          if (receipt.status === 'SUCCEEDED') {
            return this.replayProvisioningResult(manager, command, receipt);
          }

          const plan = await this.resolveProvisioningPlan(manager, command);
          const existing = await this.findActiveSubscription(manager, command.tenantId, true);
          if (existing) {
            await this.assertActiveSubscriptionReplayMatches(manager, command, existing, plan);
            return this.markBillingReceiptSucceeded(manager, command, receipt.id, {
              subscriptionId: existing.id,
              status: existing.status,
              moduleItemCount: await this.countSubscriptionModuleItems(manager, existing.id),
              replayed: true,
            });
          }

          // The subscription's recurring price is the sum of its priced module
          // items (the scheduler bills solely off pricing.basePrice), so compute
          // it from the command's real module totals — never the catalog base
          // alone, which ignored the selected modules (ORPHAN-HIGH-394).
          const moduleItemsMonthlyTotal = this.sumModuleItemsTotal(command.moduleItems);
          const subscription = await this.createProvisioningSubscription(
            manager,
            command,
            plan,
            moduleItemsMonthlyTotal,
            stripeRefs,
          );
          const moduleItemCount = await this.reconcileSubscriptionModuleItems(
            manager,
            subscription.id,
            command.moduleItems,
            plan.currency,
            plan.tier === PlanTier.FREE,
          );

          return this.markBillingReceiptSucceeded(manager, command, receipt.id, {
            subscriptionId: subscription.id,
            status: subscription.status,
            moduleItemCount,
            replayed: false,
          });
        });
      } catch (err) {
        await this.markBillingReceiptFailed(command, commandType, payloadHash, err);
        return this.toProvisioningError(command, err);
      }
    });
  }

  @MessagePattern(BILLING_ADMIN_COMMAND_SUBJECTS.CREATE_INVOICE)
  async createInvoice(
    @Payload() command: BillingAdminCreateInvoiceCommand,
  ): Promise<BillingAdminInvoiceCommandResult> {
    return this.runAsTrustedAdminBypass('create-invoice', async () => {
      try {
        const input: CreateInvoiceInput = {
          ...command.input,
        };
        const invoice = await this.commandBus.execute<CreateInvoiceCommand, Invoice>(
          new CreateInvoiceCommand(command.tenantId, input, command.actorId),
        );
        return { success: true, invoice: this.mapInvoice(invoice) };
      } catch (err) {
        return this.toInvoiceError('createInvoice', err);
      }
    });
  }

  @MessagePattern(BILLING_ADMIN_COMMAND_SUBJECTS.MARK_INVOICE_PAID)
  async markInvoicePaid(
    @Payload() command: BillingAdminMarkInvoicePaidCommand,
  ): Promise<BillingAdminInvoiceCommandResult> {
    return this.runAsTrustedAdminBypass('mark-invoice-paid', async () => {
      try {
        const tenantId = await this.getInvoiceTenantId(command.invoiceId);
        const input: RecordPaymentInput = {
          invoiceId: command.invoiceId,
          amount: command.amount,
          paymentMethod: PaymentMethod.OTHER,
          notes: 'Recorded by platform admin',
        };
        await this.commandBus.execute<RecordPaymentCommand, Payment>(
          new RecordPaymentCommand(tenantId, input, command.actorId),
        );
        const invoice = await this.getInvoiceSnapshot(command.invoiceId, tenantId);
        return { success: true, invoice };
      } catch (err) {
        return this.toInvoiceError('markInvoicePaid', err);
      }
    });
  }

  @MessagePattern(BILLING_ADMIN_COMMAND_SUBJECTS.VOID_INVOICE)
  async voidInvoice(
    @Payload() command: BillingAdminVoidInvoiceCommand,
  ): Promise<BillingAdminInvoiceCommandResult> {
    return this.runAsTrustedAdminBypass('void-invoice', async () => {
      try {
        const tenantId = await this.getInvoiceTenantId(command.invoiceId);
        const invoice = await this.commandBus.execute<VoidInvoiceCommand, Invoice>(
          new VoidInvoiceCommand(tenantId, command.invoiceId, command.reason, command.actorId),
        );
        return { success: true, invoice: this.mapInvoice(invoice) };
      } catch (err) {
        return this.toInvoiceError('voidInvoice', err);
      }
    });
  }

  @MessagePattern(BILLING_ADMIN_COMMAND_SUBJECTS.RECORD_PAYMENT)
  async recordPayment(
    @Payload() command: BillingAdminRecordPaymentCommand,
  ): Promise<BillingAdminPaymentCommandResult> {
    return this.runAsTrustedAdminBypass('record-payment', async () => {
      try {
        const tenantId = await this.getInvoiceTenantId(command.input.invoiceId);
        const paymentMethod = this.parsePaymentMethod(command.input.paymentMethod);
        const input: RecordPaymentInput = {
          ...command.input,
          paymentMethod,
        };
        const payment = await this.commandBus.execute<RecordPaymentCommand, Payment>(
          new RecordPaymentCommand(tenantId, input, command.actorId),
        );
        return { success: true, payment: this.mapPayment(payment) };
      } catch (err) {
        return this.toPaymentError('recordPayment', err);
      }
    });
  }

  @MessagePattern(BILLING_ADMIN_COMMAND_SUBJECTS.REFUND_PAYMENT)
  async refundPayment(
    @Payload() command: BillingAdminRefundPaymentCommand,
  ): Promise<BillingAdminPaymentCommandResult> {
    return this.runAsTrustedAdminBypass('refund-payment', async () => {
      try {
        const tenantId = await this.getPaymentTenantId(command.input.paymentId);
        const input: RefundPaymentInput = {
          ...command.input,
        };
        const payment = await this.commandBus.execute<RefundPaymentCommand, Payment>(
          new RefundPaymentCommand(tenantId, input, command.actorId),
        );
        return { success: true, payment: this.mapPayment(payment) };
      } catch (err) {
        return this.toPaymentError('refundPayment', err);
      }
    });
  }

  @MessagePattern(BILLING_ADMIN_COMMAND_SUBJECTS.CHANGE_SUBSCRIPTION_PLAN)
  async changeSubscriptionPlan(
    @Payload() command: BillingAdminChangeSubscriptionPlanCommand,
  ): Promise<BillingAdminSubscriptionCommandResult> {
    return this.runAsTrustedAdminBypass('change-subscription-plan', async () => {
      try {
        const input: ChangeSubscriptionPlanInput = {
          newPlanId: command.newPlanId,
          immediate: command.immediate,
          reason: command.reason,
        };
        await this.commandBus.execute<ChangeSubscriptionPlanCommand, Subscription>(
          new ChangeSubscriptionPlanCommand(command.tenantId, input, command.actorId),
        );
        return { success: true, message: 'Subscription plan change applied' };
      } catch (err) {
        return this.toSubscriptionError('changeSubscriptionPlan', err);
      }
    });
  }

  /**
   * ADR-0014: the three subscription lifecycle commands below dispatch the
   * CQRS handlers instead of running raw `UPDATE billing.subscriptions`.
   *
   * The raw statements told Stripe nothing, wrote no outbox event, projected
   * nothing onto `auth.tenants` and validated no state transition — and each
   * one's `WHERE tenant_id = $n AND is_deleted = false` named no subscription
   * id, so a tenant with more than one row had all of them written. The
   * handlers they replaced already existed, unused.
   */
  @MessagePattern(BILLING_ADMIN_COMMAND_SUBJECTS.CANCEL_SUBSCRIPTION)
  async cancelSubscription(
    @Payload() command: BillingAdminCancelSubscriptionCommand,
  ): Promise<BillingAdminSubscriptionCommandResult> {
    return this.runAsTrustedAdminBypass('cancel-subscription', async () => {
      try {
        const subscription = await this.getSubscription(command.tenantId);
        const cancelled = await this.commandBus.execute<CancelSubscriptionCommand, Subscription>(
          new CancelSubscriptionCommand(
            command.tenantId,
            subscription.id,
            command.reason,
            command.actorId,
            command.cancelImmediately ?? false,
          ),
        );
        const effectiveDate = cancelled.endDate ?? new Date();

        return {
          success: true,
          effectiveDate: effectiveDate.toISOString(),
          message: command.cancelImmediately
            ? 'Subscription cancelled immediately'
            : `Subscription will be cancelled on ${effectiveDate.toISOString()}`,
        };
      } catch (err) {
        return this.toSubscriptionError('cancelSubscription', err);
      }
    });
  }

  @MessagePattern(BILLING_ADMIN_COMMAND_SUBJECTS.REACTIVATE_SUBSCRIPTION)
  async reactivateSubscription(
    @Payload() command: BillingAdminReactivateSubscriptionCommand,
  ): Promise<BillingAdminSubscriptionCommandResult> {
    return this.runAsTrustedAdminBypass('reactivate-subscription', async () => {
      try {
        const subscription = await this.getSubscription(command.tenantId);
        // The status guard lives in the handler now, under the row lock — here
        // it raced any concurrent write between the read and the UPDATE.
        await this.commandBus.execute<ReactivateSubscriptionCommand, Subscription>(
          new ReactivateSubscriptionCommand(command.tenantId, subscription.id, command.actorId),
        );

        return { success: true, message: 'Subscription reactivated successfully' };
      } catch (err) {
        return this.toSubscriptionError('reactivateSubscription', err);
      }
    });
  }

  @MessagePattern(BILLING_ADMIN_COMMAND_SUBJECTS.EXTEND_SUBSCRIPTION_TRIAL)
  async extendSubscriptionTrial(
    @Payload() command: BillingAdminExtendSubscriptionTrialCommand,
  ): Promise<BillingAdminSubscriptionCommandResult> {
    return this.runAsTrustedAdminBypass('extend-subscription-trial', async () => {
      try {
        const subscription = await this.getSubscription(command.tenantId);
        const extended = await this.commandBus.execute<
          ExtendSubscriptionTrialCommand,
          Subscription
        >(
          new ExtendSubscriptionTrialCommand(
            command.tenantId,
            subscription.id,
            command.additionalDays,
            command.actorId,
          ),
        );

        return { success: true, newTrialEnd: extended.trialEndDate?.toISOString() };
      } catch (err) {
        return this.toSubscriptionError('extendSubscriptionTrial', err);
      }
    });
  }

  private async prepareBillingReceipt(
    manager: EntityManager,
    command: BillingTenantProvisioningCommand,
    commandType: string,
    payloadHash: string,
  ): Promise<BillingCommandReceiptRow> {
    // ADR-0014: the receipt identity is (tenantId, commandType, idempotencyKey).
    // `operationId` is recorded as evidence but is NOT part of the key — the
    // provisioning workflow mints a fresh one on retry, and while it led the
    // unique index that retry inserted a second receipt and provisioned twice.
    const rows = await manager.query<BillingCommandReceiptRow[]>(
      `SELECT id, "payloadHash", status, "resultSummary", "updatedAt"
         FROM billing.command_receipts
        WHERE "tenantId" IS NOT DISTINCT FROM $1
          AND "commandType" = $2
          AND "idempotencyKey" = $3
          AND "supersededAt" IS NULL
        FOR UPDATE`,
      [command.tenantId, commandType, command.idempotencyKey],
    );
    const existing = rows[0];
    if (existing) {
      if (existing.payloadHash !== payloadHash) {
        throw new ConflictException('Billing idempotency key was reused with a different payload');
      }
      if (existing.status === 'FAILED') {
        await manager.query(
          `UPDATE billing.command_receipts
              SET status = 'STARTED',
                  "resultHash" = NULL,
                  "resultSummary" = NULL,
                  "errorCode" = NULL,
                  error = NULL,
                  "completedAt" = NULL,
                  "updatedAt" = NOW()
            WHERE id = $1`,
          [existing.id],
        );
        return { ...existing, status: 'STARTED', resultSummary: null, updatedAt: new Date() };
      }
      return existing;
    }

    const inserted = await manager.query<BillingCommandReceiptRow[]>(
      `INSERT INTO billing.command_receipts (
         "operationId",
         "tenantId",
         "commandType",
         "idempotencyKey",
         "payloadHash",
         status,
         "actorId",
         "correlationId",
         "createdAt",
         "updatedAt"
       ) VALUES ($1, $2, $3, $4, $5, 'STARTED', $6, $7, NOW(), NOW())
       RETURNING id, "payloadHash", status, "resultSummary", "updatedAt"`,
      [
        command.operationId,
        command.tenantId,
        commandType,
        command.idempotencyKey,
        payloadHash,
        command.actorId,
        command.correlationId,
      ],
    );
    const receipt = inserted[0];
    if (!receipt) {
      throw new Error('billing.command_receipts insert did not return a receipt row');
    }
    return receipt;
  }

  private async replayProvisioningResult(
    manager: EntityManager,
    command: BillingTenantProvisioningCommand,
    receipt: BillingCommandReceiptRow,
  ): Promise<BillingTenantProvisioningResult> {
    const summary = receipt.resultSummary;
    if (summary && typeof summary['subscriptionId'] === 'string') {
      return {
        success: true,
        operationId: command.operationId,
        tenantId: command.tenantId,
        subscriptionId: summary['subscriptionId'],
        status: typeof summary['status'] === 'string' ? summary['status'] : undefined,
        moduleItemCount:
          typeof summary['moduleItemCount'] === 'number' ? summary['moduleItemCount'] : undefined,
        receiptId: receipt.id,
        resultHash: this.hashBillingPayload(summary),
        replayed: true,
      };
    }

    const existing = await this.findActiveSubscription(manager, command.tenantId, true);
    if (!existing) {
      throw new ConflictException(
        'Billing receipt is marked successful but subscription evidence is missing',
      );
    }
    return this.markBillingReceiptSucceeded(manager, command, receipt.id, {
      subscriptionId: existing.id,
      status: existing.status,
      moduleItemCount: await this.countSubscriptionModuleItems(manager, existing.id),
      replayed: true,
    });
  }

  private async resolveProvisioningPlan(
    manager: EntityManager,
    command: BillingTenantProvisioningCommand,
  ): Promise<Plan> {
    const tier = this.parsePlanTier(command.tier);
    const billingCycle = this.parseBillingCycle(command.billingCycle);
    if (tier === PlanTier.ENTERPRISE && !command.quoteId && !command.customPlanId) {
      throw new BadRequestException(
        'Enterprise provisioning requires an approved billing quote or custom plan',
      );
    }
    if (command.quoteId && !command.customPlanId) {
      throw new BadRequestException('Billing quote resolution requires a customPlanId');
    }

    // eslint-disable-next-line no-restricted-syntax -- Billing Plan is a cross-tenant catalog table with no tenantId; tenantManagerRepo would invent tenant scope where the schema intentionally has none.
    const planRepository = manager.getRepository(Plan);
    const plan = command.customPlanId
      ? await planRepository.findOne({
          where: {
            id: command.customPlanId,
            billingCycle,
            isActive: true,
            isDeleted: false,
          },
        })
      : await planRepository.findOne({
          where: {
            tier,
            billingCycle,
            isActive: true,
            isDeleted: false,
          },
          order: { version: 'DESC', sortOrder: 'ASC' },
        });
    if (!plan) {
      throw new NotFoundException(
        `No active billing catalog plan for tier=${command.tier} billingCycle=${command.billingCycle}`,
      );
    }
    if (
      command.catalogVersionId &&
      command.catalogVersionId !== plan.id &&
      command.catalogVersionId !== String(plan.version)
    ) {
      throw new ConflictException(
        `Billing catalog version mismatch for tier=${command.tier} billingCycle=${command.billingCycle}`,
      );
    }
    return plan;
  }

  /**
   * Provision the tenant's subscription through the SAME writer the GraphQL
   * path uses (ADR-0014).
   *
   * This replaced a raw `INSERT INTO billing.subscriptions` that left
   * `stripe_customer_id` and `stripe_subscription_id` NULL — so every tenant
   * an operator provisioned had a subscription this platform believed in and
   * Stripe had never heard of. Nothing charged them, no Stripe webhook could
   * resolve to them, and the divergence was invisible until someone
   * reconciled by hand.
   *
   * `stripe` is minted BEFORE the receipt transaction opens (SSOT-C-12) and
   * passed in, so no pool connection is held across the network call.
   */
  private async createProvisioningSubscription(
    manager: EntityManager,
    command: BillingTenantProvisioningCommand,
    plan: Plan,
    moduleItemsMonthlyTotal: number,
    stripe: StripeSubscriptionRefs,
  ): Promise<{ id: string; status: SubscriptionStatus }> {
    if (command.trialDays && command.trialDays > 30) {
      throw new ConflictException('Trial period cannot exceed 30 days');
    }

    const subscription = await this.subscriptionWriter.createWithin(manager, {
      tenantId: command.tenantId,
      plan,
      billingCycle: plan.billingCycle,
      limits: plan.limits,
      // basePrice is the recurring monthly charge the invoice scheduler bills
      // off (billing-scheduler.service.ts) — the real sum of the priced module
      // items (ORPHAN-HIGH-394), not the catalog plan base, which ignored the
      // selected modules. The per-unit rates stay as catalog reference; the
      // writer clamps every price to 0 for FREE.
      pricing: {
        basePrice: moduleItemsMonthlyTotal,
        perFarmPrice: plan.pricing.perFarmPrice ?? 0,
        perSensorPrice: plan.pricing.perSensorPrice ?? 0,
        perUserPrice: plan.pricing.perUserPrice ?? 0,
        currency: plan.currency,
      },
      startDate: new Date(),
      trialDays: command.trialDays,
      actorId: command.actorId,
      stripe,
    });

    return { id: subscription.id, status: subscription.status };
  }

  private async assertActiveSubscriptionReplayMatches(
    manager: EntityManager,
    command: BillingTenantProvisioningCommand,
    existing: ActiveSubscriptionRow,
    plan: Plan,
  ): Promise<void> {
    if (existing.planId !== plan.id) {
      throw new ConflictException(
        'Active billing subscription exists but its catalog plan does not match the provisioning command',
      );
    }
    const rows = await manager.query<
      Array<{ moduleId: string; quantities: Record<string, unknown> }>
    >(
      `SELECT module_id as "moduleId", quantities
         FROM billing.subscription_module_items
        WHERE subscription_id = $1
          AND status = 'active'
        ORDER BY module_id`,
      [existing.id],
    );
    const existingDigest = this.hashBillingPayload(
      rows.map((row) => ({
        moduleId: row.moduleId,
        quantities: row.quantities ?? { moduleId: row.moduleId },
      })),
    );
    const commandDigest = this.hashBillingPayload(
      [...new Set(command.moduleIds)].sort().map((moduleId) => ({
        moduleId,
        quantities: command.moduleQuantities?.find((item) => item.moduleId === moduleId) ?? {
          moduleId,
        },
      })),
    );
    if (existingDigest !== commandDigest) {
      throw new ConflictException(
        'Active billing subscription exists but its module digest does not match the provisioning command',
      );
    }
  }

  private parsePlanTier(value: string): PlanTier {
    const validTiers: readonly string[] = Object.values(PlanTier);
    if (!validTiers.includes(value)) {
      throw new BadRequestException(`Unsupported billing plan tier: ${value}`);
    }
    return value as PlanTier;
  }

  private parseBillingCycle(value: string): BillingCycle {
    const validCycles: readonly string[] = Object.values(BillingCycle);
    if (!validCycles.includes(value)) {
      throw new BadRequestException(`Unsupported billing cycle: ${value}`);
    }
    return value as BillingCycle;
  }

  private calculatePeriodEnd(startDate: Date, billingCycle: BillingCycle): Date {
    return this.addMonthsClamped(startDate, this.cycleToMonths(billingCycle));
  }

  private cycleToMonths(billingCycle: BillingCycle): number {
    switch (billingCycle) {
      case BillingCycle.MONTHLY:
        return 1;
      case BillingCycle.QUARTERLY:
        return 3;
      case BillingCycle.SEMI_ANNUAL:
        return 6;
      case BillingCycle.ANNUAL:
        return 12;
    }
  }

  private addMonthsClamped(date: Date, months: number): Date {
    const targetYear = date.getFullYear();
    const targetMonth = date.getMonth() + months;
    const lastDay = new Date(targetYear, targetMonth + 1, 0).getDate();
    const result = new Date(date);
    result.setFullYear(targetYear, targetMonth, Math.min(date.getDate(), lastDay));
    return result;
  }

  private addDays(date: Date, days: number): Date {
    const result = new Date(date);
    result.setDate(result.getDate() + days);
    return result;
  }

  private async findActiveSubscription(
    manager: EntityManager,
    tenantId: string,
    forUpdate = false,
  ): Promise<ActiveSubscriptionRow | null> {
    const rows = await manager.query<ActiveSubscriptionRow[]>(
      `SELECT id, status, plan_id as "planId"
         FROM billing.subscriptions
        WHERE tenant_id = $1
          AND is_deleted = false
          AND status IN ('trial', 'active', 'past_due', 'suspended')
        ORDER BY "createdAt" DESC
        LIMIT 1
        ${forUpdate ? 'FOR UPDATE' : ''}`,
      [tenantId],
    );
    return rows[0] ?? null;
  }

  /**
   * Write one billing.subscription_module_items row per resolved module item.
   *
   * ORPHAN-CRITICAL-393 / ORPHAN-HIGH-394: the module code/name AND real prices
   * come straight from `command.moduleItems` (resolved by admin-api, the schema
   * owner of auth.modules + admin.module_pricing). There is NO cross-schema
   * `SELECT ... FROM modules` here — billing has no grant on auth.modules, and
   * the failed query used to abort the whole SERIALIZABLE transaction, silently
   * discarding the just-created subscription. Prices are the command's real
   * values (subtotal/discountAmount/total), never hardcoded 0.
   */
  private async reconcileSubscriptionModuleItems(
    manager: EntityManager,
    subscriptionId: string,
    moduleItems: BillingTenantProvisioningCommand['moduleItems'],
    currency: string,
    isFree = false,
  ): Promise<number> {
    if (!moduleItems || moduleItems.length === 0) return 0;

    for (const item of moduleItems) {
      const quantities = item.quantities ?? { moduleId: item.moduleId };
      // FREE tenants keep the module (quantities/line record) but every price is
      // clamped to 0 — billing is the SSoT and must not depend on the caller
      // having zeroed the item (Billing Revival Faz B).
      const lineItems = isFree ? [] : (item.lineItems ?? []);
      // Exact decimal strings straight into `numeric` columns: Postgres parses
      // them losslessly, so nothing here widens a price through a double.
      const subtotal = isFree ? '0' : item.subtotal;
      const discountAmount = isFree ? '0' : item.discountAmount;
      const total = isFree ? '0' : item.total;
      await manager.query(
        `INSERT INTO billing.subscription_module_items (
           subscription_id,
           module_id,
           module_code,
           module_name,
           quantities,
           line_items,
           subtotal,
           discount_amount,
           total,
           currency,
           status,
           activated_at,
           "createdAt",
           "updatedAt"
         ) VALUES (
           $1,
           $2,
           $3,
           $4,
           $5::jsonb,
           $6::jsonb,
           $7,
           $8,
           $9,
           $10,
           'active',
           NOW(),
           NOW(),
           NOW()
         )
         ON CONFLICT (subscription_id, module_id) DO UPDATE SET
           quantities = EXCLUDED.quantities,
           module_code = EXCLUDED.module_code,
           module_name = EXCLUDED.module_name,
           line_items = EXCLUDED.line_items,
           subtotal = EXCLUDED.subtotal,
           discount_amount = EXCLUDED.discount_amount,
           total = EXCLUDED.total,
           currency = EXCLUDED.currency,
           status = 'active',
           "updatedAt" = NOW()`,
        [
          subscriptionId,
          item.moduleId,
          item.code,
          item.name,
          JSON.stringify(quantities),
          JSON.stringify(lineItems),
          subtotal,
          discountAmount,
          total,
          currency,
        ],
      );
    }

    return this.countSubscriptionModuleItems(manager, subscriptionId);
  }

  /**
   * Reject a provisioning command that selects modules but carries no resolved
   * priced items (ORPHAN-CRITICAL-393). Validated at the boundary before the
   * transaction opens so a malformed command can never create a subscription and
   * then fail mid-transaction. admin-api always populates moduleItems.
   */
  private assertProvisioningModuleItems(command: BillingTenantProvisioningCommand): void {
    const hasModules = (command.moduleIds?.length ?? 0) > 0;
    const hasItems = (command.moduleItems?.length ?? 0) > 0;
    if (hasModules && !hasItems) {
      throw new BadRequestException(
        'Provisioning command selects modules but carries no resolved moduleItems',
      );
    }
  }

  /**
   * Sum the priced items exactly, then widen ONCE.
   *
   * The sum lands in `billing.subscriptions.pricing.basePrice`, which is still
   * a `number` inside a jsonb column — the last money-in-jsonb site on the
   * subscription, governed by `.claude/allowlists/money-in-jsonb.yaml` until
   * BILLING-CRITICAL-003 normalises it. Summing in `Decimal` first means the
   * single rounding happens at that boundary instead of accumulating across
   * every module line.
   */
  private sumModuleItemsTotal(
    moduleItems: BillingTenantProvisioningCommand['moduleItems'],
  ): number {
    if (!moduleItems || moduleItems.length === 0) return 0;
    const exact = moduleItems.reduce(
      (sum, item) => sum.plus(new Decimal(item.total ?? '0')),
      new Decimal(0),
    );
    return exact.toNumber();
  }

  private async countSubscriptionModuleItems(
    manager: EntityManager,
    subscriptionId: string,
  ): Promise<number> {
    const rows = await manager.query<Array<{ count: string }>>(
      `SELECT COUNT(*)::text AS count
         FROM billing.subscription_module_items
        WHERE subscription_id = $1
          AND status = 'active'`,
      [subscriptionId],
    );
    return Number.parseInt(rows[0]?.count ?? '0', 10);
  }

  private async markBillingReceiptSucceeded(
    manager: EntityManager,
    command: BillingTenantProvisioningCommand,
    receiptId: string,
    summary: {
      subscriptionId: string;
      status: string;
      moduleItemCount: number;
      replayed: boolean;
    },
  ): Promise<BillingTenantProvisioningResult> {
    const resultSummary = {
      subscriptionId: summary.subscriptionId,
      status: summary.status,
      moduleItemCount: summary.moduleItemCount,
    };
    const resultHash = this.hashBillingPayload(resultSummary);
    await manager.query(
      `UPDATE billing.command_receipts
          SET status = 'SUCCEEDED',
              "entityId" = $2,
              "resultHash" = $3,
              "resultSummary" = $4::jsonb,
              "errorCode" = NULL,
              error = NULL,
              "completedAt" = NOW(),
              "updatedAt" = NOW()
        WHERE id = $1`,
      [receiptId, summary.subscriptionId, resultHash, JSON.stringify(resultSummary)],
    );
    return {
      success: true,
      operationId: command.operationId,
      tenantId: command.tenantId,
      subscriptionId: summary.subscriptionId,
      status: summary.status,
      moduleItemCount: summary.moduleItemCount,
      receiptId,
      resultHash,
      replayed: summary.replayed,
    };
  }

  private async markBillingReceiptFailed(
    command: BillingTenantProvisioningCommand,
    commandType: string,
    payloadHash: string,
    err: unknown,
  ): Promise<void> {
    const errorCode = this.toBillingProvisioningErrorCode(err);
    const error = err instanceof Error ? err.message : String(err);
    await this.dataSource.query(
      `INSERT INTO billing.command_receipts (
         "operationId",
         "tenantId",
         "commandType",
         "idempotencyKey",
         "payloadHash",
         status,
         "actorId",
         "correlationId",
         "errorCode",
         error,
         "completedAt",
         "createdAt",
         "updatedAt"
       ) VALUES ($1, $2, $3, $4, $5, 'FAILED', $6, $7, $8, $9, NOW(), NOW(), NOW())
       ON CONFLICT ("tenantId", "commandType", "idempotencyKey")
         WHERE "supersededAt" IS NULL
         DO UPDATE SET
           status = 'FAILED',
           "errorCode" = EXCLUDED."errorCode",
           error = EXCLUDED.error,
           "completedAt" = NOW(),
           "updatedAt" = NOW()
         WHERE billing.command_receipts."payloadHash" = EXCLUDED."payloadHash"`,
      [
        command.operationId,
        command.tenantId,
        commandType,
        command.idempotencyKey,
        payloadHash,
        command.actorId,
        command.correlationId,
        errorCode,
        error,
      ],
    );
  }

  private toProvisioningError(
    command: BillingTenantProvisioningCommand,
    err: unknown,
  ): BillingTenantProvisioningResult {
    return {
      success: false,
      operationId: command.operationId,
      tenantId: command.tenantId,
      errorCode: this.toBillingProvisioningErrorCode(err),
      error: err instanceof Error ? err.message : String(err),
    };
  }

  private toBillingProvisioningErrorCode(
    err: unknown,
  ): BillingTenantProvisioningResult['errorCode'] {
    if (err instanceof NotFoundException) return 'CATALOG_MISSING';
    if (err instanceof BadRequestException) return 'VALIDATION_ERROR';
    if (err instanceof ConflictException) return 'CONFLICT';
    return 'INTERNAL_ERROR';
  }

  private hashBillingPayload(value: unknown): string {
    return crypto.createHash('sha256').update(stableStringify(value)).digest('hex');
  }

  private async getInvoiceTenantId(invoiceId: string): Promise<string> {
    const rows = await this.dataSource.query<TenantLookupRow[]>(
      `SELECT tenant_id as "tenantId" FROM billing.invoices WHERE id = $1 AND is_deleted = false`,
      [invoiceId],
    );
    const tenantId = rows[0]?.tenantId;
    if (!tenantId) {
      throw new NotFoundException(`Invoice not found: ${invoiceId}`);
    }
    return tenantId;
  }

  private async getPaymentTenantId(paymentId: string): Promise<string> {
    const rows = await this.dataSource.query<TenantLookupRow[]>(
      `SELECT tenant_id as "tenantId" FROM billing.payments WHERE id = $1 AND is_deleted = false`,
      [paymentId],
    );
    const tenantId = rows[0]?.tenantId;
    if (!tenantId) {
      throw new NotFoundException(`Payment not found: ${paymentId}`);
    }
    return tenantId;
  }

  private async getSubscription(tenantId: string): Promise<SubscriptionLookupRow> {
    const rows = await this.dataSource.query<SubscriptionLookupRow[]>(
      `
      SELECT
        id,
        status,
        current_period_end as "currentPeriodEnd",
        trial_end_date as "trialEndDate"
      FROM billing.subscriptions
      WHERE tenant_id = $1 AND is_deleted = false
      ORDER BY "createdAt" DESC
      LIMIT 1
      `,
      [tenantId],
    );
    const subscription = rows[0];
    if (!subscription) {
      throw new NotFoundException(`No subscription found for tenant ${tenantId}`);
    }
    return subscription;
  }

  private async getInvoiceSnapshot(
    invoiceId: string,
    tenantId: string,
  ): Promise<BillingAdminInvoiceResult> {
    const rows = await this.dataSource.query<InvoiceSnapshotRow[]>(
      `
      SELECT
        id,
        invoice_number as "invoiceNumber",
        tenant_id as "tenantId",
        subscription_id as "subscriptionId",
        total as amount,
        amount_paid as "amountPaid",
        amount_due as "amountDue",
        status,
        currency,
        due_date as "dueDate",
        paid_at as "paidAt",
        issue_date as "issueDate",
        period_start as "periodStart",
        period_end as "periodEnd",
        "createdAt",
        "updatedAt"
      FROM billing.invoices
      WHERE id = $1 AND tenant_id = $2 AND is_deleted = false
      `,
      [invoiceId, tenantId],
    );
    const invoice = rows[0];
    if (!invoice) {
      throw new NotFoundException(`Invoice not found: ${invoiceId}`);
    }
    return {
      id: invoice.id,
      invoiceNumber: invoice.invoiceNumber,
      tenantId: invoice.tenantId,
      subscriptionId: invoice.subscriptionId ?? null,
      amount: this.toNumber(invoice.amount),
      amountPaid: this.toNumber(invoice.amountPaid),
      amountDue: this.toNumber(invoice.amountDue),
      status: invoice.status,
      currency: invoice.currency,
      dueDate: this.toIso(invoice.dueDate),
      paidAt: invoice.paidAt ? this.toIso(invoice.paidAt) : null,
      issueDate: this.toIso(invoice.issueDate),
      periodStart: this.toIso(invoice.periodStart),
      periodEnd: this.toIso(invoice.periodEnd),
      createdAt: this.toIso(invoice.createdAt),
      updatedAt: this.toIso(invoice.updatedAt),
    };
  }

  private parsePaymentMethod(value: string): PaymentMethod {
    const methods = Object.values(PaymentMethod);
    if (!methods.includes(value as PaymentMethod)) {
      throw new BadRequestException(`Unsupported payment method: ${value}`);
    }
    return value as PaymentMethod;
  }

  private mapInvoice(invoice: Invoice): BillingAdminInvoiceResult {
    return {
      id: invoice.id,
      invoiceNumber: invoice.invoiceNumber,
      tenantId: invoice.tenantId,
      subscriptionId: invoice.subscriptionId ?? null,
      amount: this.toNumber(invoice.total),
      amountPaid: this.toNumber(invoice.amountPaid),
      amountDue: this.toNumber(invoice.amountDue),
      status: invoice.status,
      currency: invoice.currency,
      dueDate: this.toIso(invoice.dueDate),
      paidAt: invoice.paidAt ? this.toIso(invoice.paidAt) : null,
      issueDate: this.toIso(invoice.issueDate),
      periodStart: this.toIso(invoice.periodStart),
      periodEnd: this.toIso(invoice.periodEnd),
      createdAt: this.toIso(invoice.createdAt),
      updatedAt: this.toIso(invoice.updatedAt),
    };
  }

  private mapPayment(payment: Payment): BillingAdminPaymentResult {
    return {
      id: payment.id,
      tenantId: payment.tenantId,
      transactionId: payment.transactionId,
      invoiceId: payment.invoiceId,
      amount: this.toNumber(payment.amount),
      currency: payment.currency,
      status: payment.status,
      paymentMethod: payment.paymentMethod,
      paymentDate: this.toIso(payment.paymentDate),
      processedAt: payment.processedAt ? this.toIso(payment.processedAt) : null,
      failureReason: payment.failureReason ?? null,
      refundedAmount: this.toNumber(payment.refundedAmount),
      notes: payment.notes ?? null,
      createdAt: this.toIso(payment.createdAt),
      updatedAt: this.toIso(payment.updatedAt),
      createdBy: payment.createdBy ?? null,
    };
  }

  private toNumber(value: { toNumber: () => number } | number | string | null | undefined): number {
    if (typeof value === 'number') return value;
    if (typeof value === 'string') return Number(value);
    if (value && typeof value.toNumber === 'function') return value.toNumber();
    return 0;
  }

  private toIso(value: Date | string): string {
    return value instanceof Date ? value.toISOString() : value;
  }

  private toInvoiceError(operation: string, err: unknown): BillingAdminInvoiceCommandResult {
    const { errorCode, message } = this.mapError(err);
    this.logger.warn(`${operation} failed: code=${errorCode}, reason=${message}`);
    return { success: false, errorCode, error: message };
  }

  private toPaymentError(operation: string, err: unknown): BillingAdminPaymentCommandResult {
    const { errorCode, message } = this.mapError(err);
    this.logger.warn(`${operation} failed: code=${errorCode}, reason=${message}`);
    return { success: false, errorCode, error: message };
  }

  private toSubscriptionError(
    operation: string,
    err: unknown,
  ): BillingAdminSubscriptionCommandResult {
    const { errorCode, message } = this.mapError(err);
    this.logger.warn(`${operation} failed: code=${errorCode}, reason=${message}`);
    return { success: false, errorCode, error: message };
  }

  private mapError(err: unknown): {
    errorCode: NonNullable<BillingAdminInvoiceCommandResult['errorCode']>;
    message: string;
  } {
    const message = err instanceof Error ? err.message : String(err);
    if (err instanceof NotFoundException) {
      return { errorCode: 'NOT_FOUND', message };
    }
    if (err instanceof BadRequestException) {
      return { errorCode: 'VALIDATION_ERROR', message };
    }
    return { errorCode: 'INTERNAL_ERROR', message };
  }
}
