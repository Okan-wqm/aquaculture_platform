import { Injectable, Logger, Optional, Inject } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { NatsEventBus } from '@platform/event-bus';
import {
  createBaseEvent,
  PaymentReceivedEvent,
  PaymentFailedEvent,
  SubscriptionCancelledEvent,
} from '@platform/event-contracts';
import { RedisService } from '@aquaculture/backend-common';
import { Payment, PaymentStatus, PaymentMethod } from '../entities/payment.entity';
import { Invoice, InvoiceStatus } from '../entities/invoice.entity';
import { Subscription, SubscriptionStatus } from '../entities/subscription.entity';
import { randomUUID } from 'crypto';

/**
 * Safe decimal arithmetic helpers (cents-based to avoid floating point errors)
 */
function safeAdd(a: number, b: number): number {
  return (Math.round(a * 100) + Math.round(b * 100)) / 100;
}

function safeSubtract(a: number, b: number): number {
  return (Math.round(a * 100) - Math.round(b * 100)) / 100;
}

/**
 * Stripe Webhook Event Handler Service
 *
 * Processes verified Stripe webhook events and applies corresponding
 * state changes to billing entities. Each handler is isolated via
 * try/catch so one failure does not block other event processing.
 *
 * Coordinates with E2-RefundHandler: charge.refunded DB-level refund
 * logic is owned by E2-RefundHandler; this service updates the payment
 * status and publishes the NATS event.
 */
@Injectable()
export class StripeWebhookService {
  private readonly logger = new Logger(StripeWebhookService.name);

  constructor(
    private readonly dataSource: DataSource,
    @Optional() @Inject('EVENT_BUS') private readonly eventBus?: NatsEventBus,
    @Optional() private readonly redisService?: RedisService,
  ) {}

  /**
   * Handle payment_intent.succeeded
   * Finds the invoice by stripePaymentIntentId, records a payment,
   * and transitions the invoice to PAID / PARTIALLY_PAID.
   */
  async handlePaymentIntentSucceeded(event: Record<string, any>): Promise<void> {
    const paymentIntent = event.data?.object;
    if (!paymentIntent) {
      this.logger.warn('payment_intent.succeeded: missing data.object');
      return;
    }

    const stripePaymentIntentId: string = paymentIntent.id;
    const amountReceived: number = (paymentIntent.amount_received ?? paymentIntent.amount ?? 0) / 100;
    const currency: string = (paymentIntent.currency ?? 'usd').toUpperCase();
    const stripeChargeId: string | undefined = paymentIntent.latest_charge ?? undefined;

    // Metadata should carry our tenantId and invoiceId
    const tenantId: string | undefined = paymentIntent.metadata?.tenantId;
    const invoiceId: string | undefined = paymentIntent.metadata?.invoiceId;

    if (!tenantId || !invoiceId) {
      this.logger.warn(
        `payment_intent.succeeded: missing tenantId or invoiceId in metadata for ${stripePaymentIntentId}`,
      );
      return;
    }

    await this.dataSource.transaction(async (manager) => {
      // Check if a payment with this stripePaymentIntentId already exists (idempotency at DB level)
      const existingPayment = await manager.findOne(Payment, {
        where: { stripePaymentIntentId, tenantId },
      });

      if (existingPayment && existingPayment.status === PaymentStatus.SUCCEEDED) {
        this.logger.log(
          `payment_intent.succeeded: payment already recorded for ${stripePaymentIntentId}, skipping`,
        );
        return;
      }

      const invoice = await manager.findOne(Invoice, {
        where: { id: invoiceId, tenantId },
        lock: { mode: 'pessimistic_write' },
      });

      if (!invoice) {
        this.logger.warn(`payment_intent.succeeded: invoice ${invoiceId} not found for tenant ${tenantId}`);
        return;
      }

      const payableStatuses = [
        InvoiceStatus.PENDING,
        InvoiceStatus.SENT,
        InvoiceStatus.PARTIALLY_PAID,
        InvoiceStatus.OVERDUE,
      ];

      if (!payableStatuses.includes(invoice.status)) {
        this.logger.warn(
          `payment_intent.succeeded: invoice ${invoiceId} has non-payable status ${invoice.status}`,
        );
        return;
      }

      const transactionId = `TXN-STRIPE-${Date.now()}-${randomUUID().substring(0, 8).toUpperCase()}`;

      // If there's an existing PENDING payment, update it; otherwise create new
      let payment: Payment;
      if (existingPayment) {
        existingPayment.status = PaymentStatus.SUCCEEDED;
        existingPayment.amount = amountReceived;
        existingPayment.processedAt = new Date();
        existingPayment.stripeChargeId = stripeChargeId;
        existingPayment.updatedBy = 'stripe-webhook';
        payment = await manager.save(Payment, existingPayment);
      } else {
        payment = manager.create(Payment, {
          tenantId,
          transactionId,
          invoiceId,
          amount: amountReceived,
          currency,
          status: PaymentStatus.SUCCEEDED,
          paymentMethod: PaymentMethod.CREDIT_CARD,
          paymentDate: new Date(),
          processedAt: new Date(),
          stripePaymentIntentId,
          stripeChargeId,
          refundedAmount: 0,
          notes: `Stripe webhook: payment_intent.succeeded`,
          createdBy: 'stripe-webhook',
          updatedBy: 'stripe-webhook',
        });
        payment = await manager.save(Payment, payment);
      }

      // Update invoice totals
      const newAmountPaid = safeAdd(Number(invoice.amountPaid), amountReceived);
      const newAmountDue = safeSubtract(Number(invoice.total), newAmountPaid);

      invoice.amountPaid = newAmountPaid;
      invoice.amountDue = Math.max(0, newAmountDue);

      if (newAmountDue <= 0.01) {
        invoice.status = InvoiceStatus.PAID;
        invoice.paidAt = new Date();
        invoice.amountDue = 0;
      } else {
        invoice.status = InvoiceStatus.PARTIALLY_PAID;
      }

      invoice.updatedBy = 'stripe-webhook';
      await manager.save(Invoice, invoice);

      this.logger.log(
        `payment_intent.succeeded: recorded payment ${payment.id} for invoice ${invoiceId}, amount ${amountReceived} ${currency}`,
      );

      // Publish NATS event
      try {
        const natsEvent: PaymentReceivedEvent = {
          ...createBaseEvent<PaymentReceivedEvent>('PaymentReceived', tenantId),
          paymentId: payment.id,
          invoiceId,
          amount: amountReceived,
          currency,
          paymentMethod: PaymentMethod.CREDIT_CARD,
          transactionId: payment.transactionId,
          paidAt: payment.paymentDate,
        };
        await this.eventBus?.publish(natsEvent);
      } catch (err) {
        this.logger.warn(
          `Failed to publish PaymentReceived event: ${err instanceof Error ? err.message : 'Unknown'}`,
        );
      }
    });
  }

  /**
   * Handle payment_intent.payment_failed
   * Records a failed payment and publishes a PaymentFailed event.
   */
  async handlePaymentIntentFailed(event: Record<string, any>): Promise<void> {
    const paymentIntent = event.data?.object;
    if (!paymentIntent) {
      this.logger.warn('payment_intent.payment_failed: missing data.object');
      return;
    }

    const stripePaymentIntentId: string = paymentIntent.id;
    const amount: number = (paymentIntent.amount ?? 0) / 100;
    const currency: string = (paymentIntent.currency ?? 'usd').toUpperCase();
    const failureMessage: string =
      paymentIntent.last_payment_error?.message ?? 'Payment failed';
    const failureCode: string =
      paymentIntent.last_payment_error?.code ?? 'unknown';

    const tenantId: string | undefined = paymentIntent.metadata?.tenantId;
    const invoiceId: string | undefined = paymentIntent.metadata?.invoiceId;

    if (!tenantId || !invoiceId) {
      this.logger.warn(
        `payment_intent.payment_failed: missing tenantId or invoiceId in metadata for ${stripePaymentIntentId}`,
      );
      return;
    }

    await this.dataSource.transaction(async (manager) => {
      // Idempotency guard: Stripe retries webhooks on failure; Redis may be unavailable
      // (@Optional injection). Without this check, each retry inserts a duplicate FAILED
      // payment row, inflating metrics and confusing reconciliation.
      const existingFailed = await manager.findOne(Payment, {
        where: { stripePaymentIntentId, status: PaymentStatus.FAILED },
        select: ['id'],
      });
      if (existingFailed) {
        this.logger.debug(
          `payment_intent.payment_failed already recorded for ${stripePaymentIntentId} — skipping duplicate`,
        );
        return;
      }

      const transactionId = `TXN-STRIPE-FAIL-${Date.now()}-${randomUUID().substring(0, 8).toUpperCase()}`;

      const payment = manager.create(Payment, {
        tenantId,
        transactionId,
        invoiceId,
        amount,
        currency,
        status: PaymentStatus.FAILED,
        paymentMethod: PaymentMethod.CREDIT_CARD,
        paymentDate: new Date(),
        processedAt: new Date(),
        stripePaymentIntentId,
        failureReason: `${failureCode}: ${failureMessage}`,
        refundedAmount: 0,
        notes: 'Stripe webhook: payment_intent.payment_failed',
        createdBy: 'stripe-webhook',
        updatedBy: 'stripe-webhook',
      });

      const savedPayment = await manager.save(Payment, payment);

      this.logger.log(
        `payment_intent.payment_failed: recorded failed payment ${savedPayment.id} for invoice ${invoiceId}`,
      );

      // Publish NATS event for notification service
      try {
        const natsEvent: PaymentFailedEvent = {
          ...createBaseEvent<PaymentFailedEvent>('PaymentFailed', tenantId),
          paymentId: savedPayment.id,
          invoiceId,
          amount,
          currency,
          paymentMethod: PaymentMethod.CREDIT_CARD,
          failureReason: `${failureCode}: ${failureMessage}`,
          retryCount: 0,
          willRetry: paymentIntent.status === 'requires_payment_method',
        };
        await this.eventBus?.publish(natsEvent);
      } catch (err) {
        this.logger.warn(
          `Failed to publish PaymentFailed event: ${err instanceof Error ? err.message : 'Unknown'}`,
        );
      }
    });
  }

  /**
   * Handle invoice.payment_failed
   * Transitions the subscription to PAST_DUE status.
   */
  async handleInvoicePaymentFailed(event: Record<string, any>): Promise<void> {
    const stripeInvoice = event.data?.object;
    if (!stripeInvoice) {
      this.logger.warn('invoice.payment_failed: missing data.object');
      return;
    }

    const stripeSubscriptionId: string | undefined = stripeInvoice.subscription;
    const tenantId: string | undefined = stripeInvoice.metadata?.tenantId;

    if (!tenantId) {
      this.logger.warn('invoice.payment_failed: missing tenantId in metadata');
      return;
    }

    if (!stripeSubscriptionId) {
      this.logger.warn('invoice.payment_failed: no subscription associated');
      return;
    }

    await this.dataSource.transaction(async (manager) => {
      const subscription = await manager.findOne(Subscription, {
        where: { stripeSubscriptionId, tenantId },
        lock: { mode: 'pessimistic_write' },
      });

      if (!subscription) {
        this.logger.warn(
          `invoice.payment_failed: subscription ${stripeSubscriptionId} not found for tenant ${tenantId}`,
        );
        return;
      }

      if (subscription.status === SubscriptionStatus.PAST_DUE) {
        this.logger.log(
          `invoice.payment_failed: subscription ${subscription.id} already PAST_DUE, skipping`,
        );
        return;
      }

      const transitionableStatuses = [SubscriptionStatus.ACTIVE, SubscriptionStatus.TRIAL];
      if (!transitionableStatuses.includes(subscription.status)) {
        this.logger.warn(
          `invoice.payment_failed: subscription ${subscription.id} has status ${subscription.status}, cannot transition to PAST_DUE`,
        );
        return;
      }

      subscription.status = SubscriptionStatus.PAST_DUE;
      subscription.updatedBy = 'stripe-webhook';
      await manager.save(Subscription, subscription);

      // Invalidate Redis cache
      if (this.redisService) {
        await this.redisService.del(`subscription:${tenantId}`).catch(() => {});
      }

      this.logger.log(
        `invoice.payment_failed: subscription ${subscription.id} transitioned to PAST_DUE`,
      );
    });
  }

  /**
   * Handle customer.subscription.deleted
   * Cancels the subscription.
   */
  async handleSubscriptionDeleted(event: Record<string, any>): Promise<void> {
    const stripeSubscription = event.data?.object;
    if (!stripeSubscription) {
      this.logger.warn('customer.subscription.deleted: missing data.object');
      return;
    }

    const stripeSubscriptionId: string = stripeSubscription.id;
    const tenantId: string | undefined = stripeSubscription.metadata?.tenantId;

    if (!tenantId) {
      this.logger.warn(
        `customer.subscription.deleted: missing tenantId in metadata for ${stripeSubscriptionId}`,
      );
      return;
    }

    await this.dataSource.transaction(async (manager) => {
      const subscription = await manager.findOne(Subscription, {
        where: { stripeSubscriptionId, tenantId },
        lock: { mode: 'pessimistic_write' },
      });

      if (!subscription) {
        this.logger.warn(
          `customer.subscription.deleted: subscription ${stripeSubscriptionId} not found for tenant ${tenantId}`,
        );
        return;
      }

      if (subscription.status === SubscriptionStatus.CANCELLED) {
        this.logger.log(
          `customer.subscription.deleted: subscription ${subscription.id} already CANCELLED, skipping`,
        );
        return;
      }

      subscription.status = SubscriptionStatus.CANCELLED;
      subscription.cancelledAt = new Date();
      subscription.cancellationReason = 'Cancelled via Stripe';
      subscription.autoRenew = false;
      subscription.endDate = new Date();
      subscription.updatedBy = 'stripe-webhook';
      await manager.save(Subscription, subscription);

      // Invalidate Redis cache
      if (this.redisService) {
        await this.redisService.del(`subscription:${tenantId}`).catch(() => {});
      }

      this.logger.log(
        `customer.subscription.deleted: subscription ${subscription.id} cancelled`,
      );

      // Publish NATS event
      try {
        const natsEvent: SubscriptionCancelledEvent = {
          ...createBaseEvent<SubscriptionCancelledEvent>('SubscriptionCancelled', tenantId),
          subscriptionId: subscription.id,
          cancellationDate: subscription.cancelledAt!,
          effectiveEndDate: subscription.endDate!,
          reason: 'Cancelled via Stripe',
        };
        await this.eventBus?.publish(natsEvent);
      } catch (err) {
        this.logger.warn(
          `Failed to publish SubscriptionCancelled event: ${err instanceof Error ? err.message : 'Unknown'}`,
        );
      }
    });
  }

  /**
   * Handle charge.refunded
   *
   * Updates payment status to REFUNDED / PARTIALLY_REFUNDED.
   * NOTE: The actual DB-level refund accounting (refundedAmount, refund line items)
   * is owned by E2-RefundHandler. This handler updates payment status and
   * publishes the event for coordination.
   */
  async handleChargeRefunded(event: Record<string, any>): Promise<void> {
    const charge = event.data?.object;
    if (!charge) {
      this.logger.warn('charge.refunded: missing data.object');
      return;
    }

    const stripeChargeId: string = charge.id;
    const amountRefunded: number = (charge.amount_refunded ?? 0) / 100;
    const amountTotal: number = (charge.amount ?? 0) / 100;
    const isFullRefund = amountRefunded >= amountTotal;
    const currency: string = (charge.currency ?? 'usd').toUpperCase();

    const tenantId: string | undefined = charge.metadata?.tenantId;

    if (!tenantId) {
      this.logger.warn(`charge.refunded: missing tenantId in metadata for ${stripeChargeId}`);
      return;
    }

    await this.dataSource.transaction(async (manager) => {
      const payment = await manager.findOne(Payment, {
        where: { stripeChargeId, tenantId },
        lock: { mode: 'pessimistic_write' },
      });

      if (!payment) {
        this.logger.warn(
          `charge.refunded: payment not found for stripeChargeId ${stripeChargeId}, tenant ${tenantId}`,
        );
        return;
      }

      // Update payment status based on refund amount
      payment.status = isFullRefund ? PaymentStatus.REFUNDED : PaymentStatus.PARTIALLY_REFUNDED;
      payment.refundedAmount = amountRefunded;
      payment.updatedBy = 'stripe-webhook';

      // Append refund info
      const refundInfo = {
        amount: amountRefunded,
        reason: 'Refund via Stripe',
        refundedAt: new Date(),
        refundId: charge.refunds?.data?.[0]?.id,
      };

      if (!payment.refunds) {
        payment.refunds = [refundInfo];
      } else {
        payment.refunds = [...payment.refunds, refundInfo];
      }

      await manager.save(Payment, payment);

      // If fully refunded, update the invoice status
      if (isFullRefund) {
        const invoice = await manager.findOne(Invoice, {
          where: { id: payment.invoiceId, tenantId },
          lock: { mode: 'pessimistic_write' },
        });

        if (invoice) {
          invoice.status = InvoiceStatus.REFUNDED;
          invoice.updatedBy = 'stripe-webhook';
          await manager.save(Invoice, invoice);
        }
      }

      this.logger.log(
        `charge.refunded: payment ${payment.id} ${isFullRefund ? 'fully' : 'partially'} refunded. ` +
        `Amount: ${amountRefunded} ${currency}`,
      );
    });
  }
}
