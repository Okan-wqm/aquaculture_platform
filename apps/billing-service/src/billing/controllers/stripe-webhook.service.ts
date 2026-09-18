import { Injectable, Logger, Optional, Inject } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { NatsEventBus } from '@platform/event-bus';
import { toEventIso,
  createBaseEvent,
  PaymentReceivedEvent,
  PaymentFailedEvent,
  SubscriptionCancelledEvent,
} from '@platform/event-contracts';
import { Money } from '@aquaculture/backend-common/monetary';
import { RedisService } from '@aquaculture/backend-common/redis';
import { maskAndTruncatePii } from '@aquaculture/backend-common/utils';
import { readStripeTenantHint } from '@aquaculture/backend-common/billing';
import Decimal from 'decimal.js';
import { Payment, PaymentStatus, PaymentMethod } from '../entities/payment.entity';
import { Invoice, InvoiceStatus } from '../entities/invoice.entity';
import { Subscription, SubscriptionStatus } from '../entities/subscription.entity';
import { randomUUID } from 'crypto';

/**
 * Stripe emits a linked object either as a bare id string or, where the
 * endpoint has expansion configured, as the expanded object. Both shapes
 * carry the same id; anything else is "no reference".
 */
function stripeRefId(value: unknown): string | undefined {
  if (typeof value === 'string') {
    return value.length > 0 ? value : undefined;
  }
  if (typeof value === 'object' && value !== null) {
    const id = (value as { id?: unknown }).id;
    return typeof id === 'string' && id.length > 0 ? id : undefined;
  }
  return undefined;
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
 *
 * # Tenant resolution (SECREV-CRITICAL-001)
 *
 * Every handler resolves the tenant from the LOCAL row that owns the
 * inbound Stripe object — a payment by its payment-intent id, an invoice
 * by its Stripe invoice id, a subscription by its Stripe subscription id.
 * The payload's own metadata is never the tenant: it is writable by anyone
 * who can reach the Stripe account, so a tenant id read out of it is an
 * association hint at best. `confirmTenantHint` compares the hint against
 * the resolved owner and logs a disagreement at ERROR without letting it
 * change the outcome.
 *
 * Each resolution key carries a partial unique index
 * (`IDX_payment_stripe_pi`, `IDX_payment_stripe_charge`,
 * `IDX_subscription_stripe_sub`, `IDX_invoice_stripe_invoice`), so a
 * single-row `findOne` on it cannot silently pick another tenant's row.
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
   * Cross-checks the payload's tenant hint against the tenant resolved from
   * the owning local row. A disagreement means either a Stripe object whose
   * metadata was edited outside this platform, or genuine ledger corruption
   * — both are operator-actionable, so it logs at ERROR. It never changes
   * the outcome: the local row stays authoritative.
   */
  private confirmTenantHint(
    context: string,
    stripeObjectId: string,
    resolvedTenantId: string,
    metadata: unknown,
  ): void {
    const hint = readStripeTenantHint(metadata);
    if (hint && hint !== resolvedTenantId) {
      this.logger.error(
        `${context}: Stripe metadata claims tenant ${hint}, but ${stripeObjectId} is owned by tenant ${resolvedTenantId} in the local ledger — honouring the local row and ignoring the claim`,
      );
    }
  }

  /**
   * Resolves which tenant and invoice own an inbound payment intent.
   *
   * Preference order is strongest-anchor-first: an existing payment row
   * carrying this payment-intent id is the payment itself, so it settles both
   * the tenant and the invoice. Otherwise the intent's Stripe invoice locates
   * the mirrored local invoice. Both keys are partially unique, so each
   * lookup returns at most one row.
   */
  private async resolvePaymentIntentOwner(
    manager: EntityManager,
    paymentIntent: Record<string, any>,
  ): Promise<{ tenantId: string; invoiceId: string; payment?: Payment } | undefined> {
    const stripePaymentIntentId = stripeRefId(paymentIntent.id);
    if (stripePaymentIntentId) {
      const payment = await manager.findOne(Payment, { where: { stripePaymentIntentId } });
      if (payment) {
        return { tenantId: payment.tenantId, invoiceId: payment.invoiceId, payment };
      }
    }

    const stripeInvoiceId = stripeRefId(paymentIntent.invoice);
    if (stripeInvoiceId) {
      const invoice = await manager.findOne(Invoice, { where: { stripeInvoiceId } });
      if (invoice) {
        return { tenantId: invoice.tenantId, invoiceId: invoice.id };
      }
    }

    return undefined;
  }

  /**
   * Resolves the payment row that owns an inbound charge, locked for update.
   * The charge id is the direct key; a payment recorded before its charge id
   * was known is still reachable through the payment intent the charge
   * belongs to.
   */
  private async resolveChargeOwner(
    manager: EntityManager,
    charge: Record<string, any>,
  ): Promise<Payment | null> {
    const stripeChargeId = stripeRefId(charge.id);
    if (stripeChargeId) {
      const byCharge = await manager.findOne(Payment, {
        where: { stripeChargeId },
        lock: { mode: 'pessimistic_write' },
      });
      if (byCharge) {
        return byCharge;
      }
    }

    const stripePaymentIntentId = stripeRefId(charge.payment_intent);
    if (stripePaymentIntentId) {
      return manager.findOne(Payment, {
        where: { stripePaymentIntentId },
        lock: { mode: 'pessimistic_write' },
      });
    }

    return null;
  }

  /**
   * Handle payment_intent.succeeded
   * Finds the invoice by stripePaymentIntentId, records a payment,
   * and transitions the invoice to PAID / PARTIALLY_PAID.
   */
  async handlePaymentIntentSucceeded(event: Record<string, any>): Promise<void> {
    const paymentIntent = event['data']?.object;
    if (!paymentIntent) {
      this.logger.warn('payment_intent.succeeded: missing data.object');
      return;
    }

    const stripePaymentIntentId: string = paymentIntent.id;
    const currency: string = (paymentIntent.currency ?? 'usd').toUpperCase();
    const amountReceivedMoney: Money = Money.fromMinorUnits(
      paymentIntent.amount_received ?? paymentIntent.amount ?? 0,
      currency,
    );
    const amountReceived: number = amountReceivedMoney.toDecimal().toNumber();
    const stripeChargeId: string | undefined = paymentIntent.latest_charge ?? undefined;

    await this.dataSource.transaction(async (manager) => {
      const owner = await this.resolvePaymentIntentOwner(manager, paymentIntent);

      if (!owner) {
        this.logger.warn(
          `payment_intent.succeeded: no local payment or invoice owns ${stripePaymentIntentId} — nothing to record`,
        );
        return;
      }

      const { tenantId, invoiceId } = owner;
      this.confirmTenantHint(
        'payment_intent.succeeded',
        stripePaymentIntentId,
        tenantId,
        paymentIntent.metadata,
      );

      // The owner lookup already resolved the payment row carrying this
      // payment-intent id, and stripe_payment_intent_id is partially unique,
      // so this doubles as the DB-level idempotency check.
      const existingPayment = owner.payment;

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
        existingPayment.amount = amountReceivedMoney.toDecimal();
        existingPayment.processedAt = new Date();
        existingPayment.stripeChargeId = stripeChargeId;
        existingPayment.updatedBy = 'stripe-webhook';
        payment = await manager.save(Payment, existingPayment);
      } else {
        payment = manager.create(Payment, {
          tenantId,
          transactionId,
          invoiceId,
          amount: amountReceivedMoney.toDecimal(),
          currency,
          status: PaymentStatus.SUCCEEDED,
          paymentMethod: PaymentMethod.CREDIT_CARD,
          paymentDate: new Date(),
          processedAt: new Date(),
          stripePaymentIntentId,
          stripeChargeId,
          refundedAmount: new Decimal(0),
          notes: `Stripe webhook: payment_intent.succeeded`,
          createdBy: 'stripe-webhook',
          updatedBy: 'stripe-webhook',
        });
        payment = await manager.save(Payment, payment);
      }

      // Update invoice totals using Money-based precision arithmetic
      const currentPaidMoney = Money.of(invoice.amountPaid, invoice.currency);
      const newAmountPaidMoney = currentPaidMoney.add(amountReceivedMoney);
      const totalMoney = Money.of(invoice.total, invoice.currency);
      const newAmountDueMoney = totalMoney.subtract(newAmountPaidMoney);

      invoice.amountPaid = newAmountPaidMoney.toDecimal();
      invoice.amountDue = newAmountDueMoney.isNegative()
        ? new Decimal(0)
        : newAmountDueMoney.toDecimal();

      if (newAmountDueMoney.isZero() || newAmountDueMoney.isNegative()) {
        invoice.status = InvoiceStatus.PAID;
        invoice.paidAt = new Date();
        invoice.amountDue = new Decimal(0);
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
          paidAt: toEventIso(payment.paymentDate),
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
    const paymentIntent = event['data']?.object;
    if (!paymentIntent) {
      this.logger.warn('payment_intent.payment_failed: missing data.object');
      return;
    }

    const stripePaymentIntentId: string = paymentIntent.id;
    const currency: string = (paymentIntent.currency ?? 'usd').toUpperCase();
    const failedAmountMoney = Money.fromMinorUnits(paymentIntent.amount ?? 0, currency);
    const failureMessage: string =
      paymentIntent.last_payment_error?.message ?? 'Payment failed';
    const failureCode: string =
      paymentIntent.last_payment_error?.code ?? 'unknown';

    await this.dataSource.transaction(async (manager) => {
      const owner = await this.resolvePaymentIntentOwner(manager, paymentIntent);

      if (!owner) {
        this.logger.warn(
          `payment_intent.payment_failed: no local payment or invoice owns ${stripePaymentIntentId} — nothing to record`,
        );
        return;
      }

      const { tenantId, invoiceId } = owner;
      this.confirmTenantHint(
        'payment_intent.payment_failed',
        stripePaymentIntentId,
        tenantId,
        paymentIntent.metadata,
      );

      // Idempotency guard: Stripe retries webhooks on failure; Redis may be unavailable
      // (@Optional injection). Without this check, each retry re-writes the same
      // failure, inflating metrics and confusing reconciliation.
      if (owner.payment?.status === PaymentStatus.FAILED) {
        this.logger.debug(
          `payment_intent.payment_failed already recorded for ${stripePaymentIntentId} — skipping duplicate`,
        );
        return;
      }

      const transactionId = `TXN-STRIPE-FAIL-${Date.now()}-${randomUUID().substring(0, 8).toUpperCase()}`;

      // COMPLIANCE-HIGH-005 + BILLING-MEDIUM-003 cures:
      //
      // * COMPLIANCE-HIGH-005: maskPii on the upstream failureMessage
      //   before it lands in operational storage. Stripe's failure
      //   messages routinely include card last-4, billing email,
      //   customer name — PII that has no place in long-term
      //   operational rows. The audit log keeps the raw form via a
      //   separate path (immutable + 7y retention; tenant erasure
      //   clears with the rest of the audit trail). Operational
      //   tables get the redacted form, indefinitely queryable
      //   without leaking PII into ad-hoc reports.
      //
      // * BILLING-MEDIUM-003: cap at 500 chars via maskAndTruncatePii.
      //   Stripe error messages are theoretically unbounded; storing
      //   them un-capped on a postgres `text` column exposes the
      //   platform to storage exhaustion + display-layer DoS. The
      //   `${failureCode}: ` prefix is at most ~40 chars (Stripe's
      //   error codes are kebab-case identifiers), so the
      //   500-char cap on the masked reason gives a 540-char hard
      //   ceiling on the persisted string — well within the
      //   downstream display surfaces' tolerances.
      const maskedFailureReason =
        `${failureCode}: ${maskAndTruncatePii(failureMessage, 500) ?? ''}`;

      const failureFields = {
        amount: failedAmountMoney.toDecimal(),
        currency,
        status: PaymentStatus.FAILED,
        paymentMethod: PaymentMethod.CREDIT_CARD,
        paymentDate: new Date(),
        processedAt: new Date(),
        stripePaymentIntentId,
        failureReason: maskedFailureReason,
        notes: 'Stripe webhook: payment_intent.payment_failed',
        updatedBy: 'stripe-webhook',
      };

      // stripe_payment_intent_id is partially unique: a row already carrying
      // this intent id IS this payment attempt (typically left PENDING by
      // record-payment), so transition it rather than inserting a second row
      // the index would reject.
      const payment = owner.payment
        ? manager.merge(Payment, owner.payment, failureFields)
        : manager.create(Payment, {
            ...failureFields,
            tenantId,
            transactionId,
            invoiceId,
            refundedAmount: new Decimal(0),
            createdBy: 'stripe-webhook',
          });

      const savedPayment = await manager.save(Payment, payment);

      this.logger.log(
        `payment_intent.payment_failed: recorded failed payment ${savedPayment.id} for invoice ${invoiceId}`,
      );

      // Publish NATS event for notification service. Same masked form on
      // the wire — downstream consumers (notification-service) get the
      // redacted version; the raw is preserved in audit only.
      try {
        const natsEvent: PaymentFailedEvent = {
          ...createBaseEvent<PaymentFailedEvent>('PaymentFailed', tenantId),
          paymentId: savedPayment.id,
          invoiceId,
          amount: failedAmountMoney.toDecimal().toNumber(),
          currency,
          paymentMethod: PaymentMethod.CREDIT_CARD,
          failureReason: maskedFailureReason,
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
    const stripeInvoice = event['data']?.object;
    if (!stripeInvoice) {
      this.logger.warn('invoice.payment_failed: missing data.object');
      return;
    }

    const stripeSubscriptionId = stripeRefId(stripeInvoice.subscription);

    if (!stripeSubscriptionId) {
      this.logger.warn('invoice.payment_failed: no subscription associated');
      return;
    }

    await this.dataSource.transaction(async (manager) => {
      // The local subscription row owning this Stripe subscription id is the
      // authority on which tenant the event belongs to.
      const subscription = await manager.findOne(Subscription, {
        where: { stripeSubscriptionId },
        lock: { mode: 'pessimistic_write' },
      });

      if (!subscription) {
        this.logger.warn(
          `invoice.payment_failed: no local subscription owns ${stripeSubscriptionId}`,
        );
        return;
      }

      const tenantId = subscription.tenantId;
      this.confirmTenantHint(
        'invoice.payment_failed',
        stripeSubscriptionId,
        tenantId,
        stripeInvoice.metadata,
      );

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
        await this.redisService.del(`subscription:${tenantId}`).catch(() => { /* non-fatal: stale cache self-heals on next read via TTL; DB is SSoT */ });
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
    const stripeSubscription = event['data']?.object;
    if (!stripeSubscription) {
      this.logger.warn('customer.subscription.deleted: missing data.object');
      return;
    }

    const stripeSubscriptionId = stripeRefId(stripeSubscription.id);

    if (!stripeSubscriptionId) {
      this.logger.warn('customer.subscription.deleted: missing subscription id');
      return;
    }

    await this.dataSource.transaction(async (manager) => {
      // The local subscription row owning this Stripe subscription id is the
      // authority on which tenant the event belongs to.
      const subscription = await manager.findOne(Subscription, {
        where: { stripeSubscriptionId },
        lock: { mode: 'pessimistic_write' },
      });

      if (!subscription) {
        this.logger.warn(
          `customer.subscription.deleted: no local subscription owns ${stripeSubscriptionId}`,
        );
        return;
      }

      const tenantId = subscription.tenantId;
      this.confirmTenantHint(
        'customer.subscription.deleted',
        stripeSubscriptionId,
        tenantId,
        stripeSubscription.metadata,
      );

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
        await this.redisService.del(`subscription:${tenantId}`).catch(() => { /* non-fatal: stale cache self-heals on next read via TTL; DB is SSoT */ });
      }

      this.logger.log(
        `customer.subscription.deleted: subscription ${subscription.id} cancelled`,
      );

      // Publish NATS event
      try {
        const natsEvent: SubscriptionCancelledEvent = {
          ...createBaseEvent<SubscriptionCancelledEvent>('SubscriptionCancelled', tenantId),
          subscriptionId: subscription.id,
          cancellationDate: toEventIso(subscription.cancelledAt!),
          effectiveEndDate: toEventIso(subscription.endDate!),
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
    const charge = event['data']?.object;
    if (!charge) {
      this.logger.warn('charge.refunded: missing data.object');
      return;
    }

    const stripeChargeId: string = charge.id;
    const currency: string = (charge.currency ?? 'usd').toUpperCase();
    const amountRefundedMoney = Money.fromMinorUnits(charge.amount_refunded ?? 0, currency);
    const amountTotalMoney = Money.fromMinorUnits(charge.amount ?? 0, currency);
    const isFullRefund = !amountRefundedMoney.lessThan(amountTotalMoney);

    await this.dataSource.transaction(async (manager) => {
      const payment = await this.resolveChargeOwner(manager, charge);

      if (!payment) {
        this.logger.warn(`charge.refunded: no local payment owns charge ${stripeChargeId}`);
        return;
      }

      const tenantId = payment.tenantId;
      this.confirmTenantHint('charge.refunded', stripeChargeId, tenantId, charge.metadata);

      // Resolved through the payment intent: record the charge id we just
      // learned so the row becomes directly addressable next time.
      if (!payment.stripeChargeId) {
        payment.stripeChargeId = stripeChargeId;
      }

      // Update payment status based on refund amount
      payment.status = isFullRefund ? PaymentStatus.REFUNDED : PaymentStatus.PARTIALLY_REFUNDED;
      payment.refundedAmount = amountRefundedMoney.toDecimal();
      payment.updatedBy = 'stripe-webhook';

      // Append refund info
      const refundInfo = {
        amount: amountRefundedMoney.toDecimal().toNumber(),
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
        `Amount: ${amountRefundedMoney} ${currency}`,
      );
    });
  }
}
