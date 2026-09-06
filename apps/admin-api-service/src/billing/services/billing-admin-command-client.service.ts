import { parseNatsRequestTimeout } from '@aquaculture/backend-common/nats';
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
import {
  BILLING_ADMIN_COMMAND_SUBJECTS,
  type BillingAdminCreateInvoiceCommand,
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
import { catchError, firstValueFrom, throwError, timeout } from 'rxjs';

const DEFAULT_BILLING_NATS_TIMEOUT_MS = 15_000;

@Injectable()
export class BillingAdminCommandClientService {
  private readonly logger = new Logger(BillingAdminCommandClientService.name);

  private readonly timeoutMs: number;

  constructor(
    @Inject('BILLING_NATS_CLIENT')
    private readonly billingNatsClient: ClientProxy,
  ) {
    this.timeoutMs = parseNatsRequestTimeout(
      process.env['BILLING_NATS_TIMEOUT_MS'],
      DEFAULT_BILLING_NATS_TIMEOUT_MS,
      'BILLING_NATS_TIMEOUT_MS',
    );
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
    });
    return this.unwrapInvoiceResult(result);
  }

  async provisionTenantSubscription(
    command: BillingTenantProvisioningCommand,
  ): Promise<BillingTenantProvisioningResult> {
    const result = await this.sendBillingCommand<
      BillingTenantProvisioningCommand,
      BillingTenantProvisioningResult
    >(BILLING_ADMIN_COMMAND_SUBJECTS.PROVISION_TENANT_SUBSCRIPTION, command);
    if (result.success) return result;
    throw this.mapBillingError(result.errorCode, result.error);
  }

  async markInvoicePaid(
    invoiceId: string,
    amount: number,
    actorId: string,
  ): Promise<BillingAdminInvoiceResult> {
    const result = await this.sendBillingCommand<
      { invoiceId: string; amount: number; actorId: string },
      BillingAdminInvoiceCommandResult
    >(BILLING_ADMIN_COMMAND_SUBJECTS.MARK_INVOICE_PAID, {
      invoiceId,
      amount,
      actorId,
    });
    return this.unwrapInvoiceResult(result);
  }

  async voidInvoice(
    invoiceId: string,
    reason: string,
    actorId: string,
  ): Promise<BillingAdminInvoiceResult> {
    const result = await this.sendBillingCommand<
      { invoiceId: string; reason: string; actorId: string },
      BillingAdminInvoiceCommandResult
    >(BILLING_ADMIN_COMMAND_SUBJECTS.VOID_INVOICE, {
      invoiceId,
      reason,
      actorId,
    });
    return this.unwrapInvoiceResult(result);
  }

  async recordPayment(
    input: BillingAdminRecordPaymentInput,
    actorId: string,
  ): Promise<BillingAdminPaymentResult> {
    const result = await this.sendBillingCommand<
      { input: BillingAdminRecordPaymentInput; actorId: string },
      BillingAdminPaymentCommandResult
    >(BILLING_ADMIN_COMMAND_SUBJECTS.RECORD_PAYMENT, {
      input,
      actorId,
    });
    return this.unwrapPaymentResult(result);
  }

  async refundPayment(
    input: BillingAdminRefundPaymentInput,
    actorId: string,
  ): Promise<BillingAdminPaymentResult> {
    const result = await this.sendBillingCommand<
      { input: BillingAdminRefundPaymentInput; actorId: string },
      BillingAdminPaymentCommandResult
    >(BILLING_ADMIN_COMMAND_SUBJECTS.REFUND_PAYMENT, {
      input,
      actorId,
    });
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
      {
        tenantId: string;
        currentPlanId?: string;
        newPlanId: string;
        immediate?: boolean;
        actorId: string;
      },
      BillingAdminSubscriptionCommandResult
    >(BILLING_ADMIN_COMMAND_SUBJECTS.CHANGE_SUBSCRIPTION_PLAN, {
      tenantId: input.tenantId,
      currentPlanId: input.currentPlanId,
      newPlanId: input.newPlanId,
      immediate: input.effectiveImmediately,
      actorId,
    });
    return this.unwrapSubscriptionResult(result);
  }

  async cancelSubscription(
    tenantId: string,
    reason: string,
    cancelImmediately: boolean | undefined,
    actorId: string,
  ): Promise<BillingAdminSubscriptionCommandResult> {
    const result = await this.sendBillingCommand<
      { tenantId: string; reason: string; cancelImmediately?: boolean; actorId: string },
      BillingAdminSubscriptionCommandResult
    >(BILLING_ADMIN_COMMAND_SUBJECTS.CANCEL_SUBSCRIPTION, {
      tenantId,
      reason,
      cancelImmediately,
      actorId,
    });
    return this.unwrapSubscriptionResult(result);
  }

  async reactivateSubscription(
    tenantId: string,
    actorId: string,
  ): Promise<BillingAdminSubscriptionCommandResult> {
    const result = await this.sendBillingCommand<
      { tenantId: string; actorId: string },
      BillingAdminSubscriptionCommandResult
    >(BILLING_ADMIN_COMMAND_SUBJECTS.REACTIVATE_SUBSCRIPTION, {
      tenantId,
      actorId,
    });
    return this.unwrapSubscriptionResult(result);
  }

  async extendSubscriptionTrial(
    tenantId: string,
    additionalDays: number,
    actorId: string,
  ): Promise<BillingAdminSubscriptionCommandResult> {
    const result = await this.sendBillingCommand<
      { tenantId: string; additionalDays: number; actorId: string },
      BillingAdminSubscriptionCommandResult
    >(BILLING_ADMIN_COMMAND_SUBJECTS.EXTEND_SUBSCRIPTION_TRIAL, {
      tenantId,
      additionalDays,
      actorId,
    });
    return this.unwrapSubscriptionResult(result);
  }

  private async sendBillingCommand<TCommand, TResult>(
    subject: string,
    command: TCommand,
  ): Promise<TResult> {
    try {
      return await firstValueFrom(
        this.billingNatsClient.send<TResult, TCommand>(subject, command).pipe(
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
