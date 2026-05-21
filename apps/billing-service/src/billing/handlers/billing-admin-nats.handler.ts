import { BadRequestException, Controller, Logger, NotFoundException } from '@nestjs/common';
import { CommandBus } from '@nestjs/cqrs';
import { MessagePattern, Payload } from '@nestjs/microservices';
import {
  BILLING_ADMIN_COMMAND_SUBJECTS,
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
import { DataSource } from 'typeorm';

import { ChangeSubscriptionPlanCommand } from '../commands/change-subscription-plan.command';
import { CreateInvoiceCommand } from '../commands/create-invoice.command';
import { RecordPaymentCommand } from '../commands/record-payment.command';
import { RefundPaymentCommand } from '../commands/refund-payment.command';
import { VoidInvoiceCommand } from '../commands/void-invoice.command';
import { ChangeSubscriptionPlanInput } from '../dto/change-subscription-plan.input';
import { CreateInvoiceInput } from '../dto/create-invoice.input';
import { RecordPaymentInput } from '../dto/record-payment.input';
import { RefundPaymentInput } from '../dto/refund-payment.input';
import { Invoice } from '../entities/invoice.entity';
import { Payment, PaymentMethod } from '../entities/payment.entity';
import { Subscription, SubscriptionStatus } from '../entities/subscription.entity';

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

/**
 * NATS request-reply surface for platform-admin billing writes.
 *
 * admin-api-service must not update billing.* directly. This controller is
 * registered as a microservice controller so billing-service remains the
 * single writer and all writes go through the existing CQRS handlers.
 */
@Controller()
export class BillingAdminNatsHandler {
  private readonly logger = new Logger(BillingAdminNatsHandler.name);

  constructor(
    private readonly commandBus: CommandBus,
    private readonly dataSource: DataSource,
  ) {}

  @MessagePattern(BILLING_ADMIN_COMMAND_SUBJECTS.CREATE_INVOICE)
  async createInvoice(
    @Payload() command: BillingAdminCreateInvoiceCommand,
  ): Promise<BillingAdminInvoiceCommandResult> {
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
  }

  @MessagePattern(BILLING_ADMIN_COMMAND_SUBJECTS.MARK_INVOICE_PAID)
  async markInvoicePaid(
    @Payload() command: BillingAdminMarkInvoicePaidCommand,
  ): Promise<BillingAdminInvoiceCommandResult> {
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
  }

  @MessagePattern(BILLING_ADMIN_COMMAND_SUBJECTS.VOID_INVOICE)
  async voidInvoice(
    @Payload() command: BillingAdminVoidInvoiceCommand,
  ): Promise<BillingAdminInvoiceCommandResult> {
    try {
      const tenantId = await this.getInvoiceTenantId(command.invoiceId);
      const invoice = await this.commandBus.execute<VoidInvoiceCommand, Invoice>(
        new VoidInvoiceCommand(tenantId, command.invoiceId, command.reason, command.actorId),
      );
      return { success: true, invoice: this.mapInvoice(invoice) };
    } catch (err) {
      return this.toInvoiceError('voidInvoice', err);
    }
  }

  @MessagePattern(BILLING_ADMIN_COMMAND_SUBJECTS.RECORD_PAYMENT)
  async recordPayment(
    @Payload() command: BillingAdminRecordPaymentCommand,
  ): Promise<BillingAdminPaymentCommandResult> {
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
  }

  @MessagePattern(BILLING_ADMIN_COMMAND_SUBJECTS.REFUND_PAYMENT)
  async refundPayment(
    @Payload() command: BillingAdminRefundPaymentCommand,
  ): Promise<BillingAdminPaymentCommandResult> {
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
  }

  @MessagePattern(BILLING_ADMIN_COMMAND_SUBJECTS.CHANGE_SUBSCRIPTION_PLAN)
  async changeSubscriptionPlan(
    @Payload() command: BillingAdminChangeSubscriptionPlanCommand,
  ): Promise<BillingAdminSubscriptionCommandResult> {
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
  }

  @MessagePattern(BILLING_ADMIN_COMMAND_SUBJECTS.CANCEL_SUBSCRIPTION)
  async cancelSubscription(
    @Payload() command: BillingAdminCancelSubscriptionCommand,
  ): Promise<BillingAdminSubscriptionCommandResult> {
    try {
      const subscription = await this.getSubscription(command.tenantId);
      const effectiveDate = command.cancelImmediately
        ? new Date()
        : new Date(subscription.currentPeriodEnd);

      await this.dataSource.query(
        `
        UPDATE billing.subscriptions SET
          status = $1,
          cancelled_at = NOW(),
          cancellation_reason = $2,
          auto_renew = false,
          end_date = $3,
          "updatedAt" = NOW(),
          updated_by = $4
        WHERE tenant_id = $5 AND is_deleted = false
        `,
        [
          command.cancelImmediately ? SubscriptionStatus.CANCELLED : subscription.status,
          command.reason,
          effectiveDate,
          command.actorId,
          command.tenantId,
        ],
      );

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
  }

  @MessagePattern(BILLING_ADMIN_COMMAND_SUBJECTS.REACTIVATE_SUBSCRIPTION)
  async reactivateSubscription(
    @Payload() command: BillingAdminReactivateSubscriptionCommand,
  ): Promise<BillingAdminSubscriptionCommandResult> {
    try {
      const subscription = await this.getSubscription(command.tenantId);
      if (subscription.status !== SubscriptionStatus.CANCELLED) {
        throw new BadRequestException('Can only reactivate cancelled subscriptions');
      }

      await this.dataSource.query(
        `
        UPDATE billing.subscriptions SET
          status = 'active',
          cancelled_at = NULL,
          cancellation_reason = NULL,
          auto_renew = true,
          end_date = NULL,
          "updatedAt" = NOW(),
          updated_by = $1
        WHERE tenant_id = $2 AND is_deleted = false
        `,
        [command.actorId, command.tenantId],
      );

      return { success: true, message: 'Subscription reactivated successfully' };
    } catch (err) {
      return this.toSubscriptionError('reactivateSubscription', err);
    }
  }

  @MessagePattern(BILLING_ADMIN_COMMAND_SUBJECTS.EXTEND_SUBSCRIPTION_TRIAL)
  async extendSubscriptionTrial(
    @Payload() command: BillingAdminExtendSubscriptionTrialCommand,
  ): Promise<BillingAdminSubscriptionCommandResult> {
    try {
      const subscription = await this.getSubscription(command.tenantId);
      if (subscription.status !== SubscriptionStatus.TRIAL) {
        throw new BadRequestException('Can only extend trial period for trial subscriptions');
      }

      const currentTrialEnd = subscription.trialEndDate
        ? new Date(subscription.trialEndDate)
        : new Date();
      const newTrialEnd = new Date(currentTrialEnd);
      newTrialEnd.setDate(newTrialEnd.getDate() + command.additionalDays);

      await this.dataSource.query(
        `
        UPDATE billing.subscriptions SET
          trial_end_date = $1,
          current_period_end = $1,
          "updatedAt" = NOW(),
          updated_by = $2
        WHERE tenant_id = $3 AND is_deleted = false
        `,
        [newTrialEnd, command.actorId, command.tenantId],
      );

      return { success: true, newTrialEnd: newTrialEnd.toISOString() };
    } catch (err) {
      return this.toSubscriptionError('extendSubscriptionTrial', err);
    }
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

  private toInvoiceError(
    operation: string,
    err: unknown,
  ): BillingAdminInvoiceCommandResult {
    const { errorCode, message } = this.mapError(err);
    this.logger.warn(`${operation} failed: code=${errorCode}, reason=${message}`);
    return { success: false, errorCode, error: message };
  }

  private toPaymentError(
    operation: string,
    err: unknown,
  ): BillingAdminPaymentCommandResult {
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
