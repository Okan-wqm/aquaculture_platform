/**
 * Stripe webhook handling — the tenant comes from OUR row (ADR-0014,
 * BILLING-CRITICAL-003).
 *
 * This service had no test at all, which is how the defect survived: the
 * producer wrote the tenant into Stripe metadata under `internalTenantId` and
 * all five handlers read `metadata.tenantId`, so every one of them
 * warn-and-returned on every event. No payment was ever recorded from Stripe,
 * no subscription was ever marked PAST_DUE or CANCELLED by Stripe, and no
 * refund ever reached a payment row — silently, because a warn-and-return
 * looks exactly like a webhook for someone else's object.
 *
 * What is pinned here is the fix AND the reason it is shaped this way: the
 * local row that owns the Stripe object decides the tenant, and the metadata
 * key is only a hint that gets cross-checked (SECREV-CRITICAL-001 — Stripe
 * metadata is writable by anyone who can reach the Stripe account).
 */
import { STRIPE_TENANT_METADATA_KEY } from '@aquaculture/backend-common/billing';
import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import Decimal from 'decimal.js';

import { Invoice, InvoiceStatus } from '../../entities/invoice.entity';
import { Payment, PaymentStatus } from '../../entities/payment.entity';
import { Subscription, SubscriptionStatus } from '../../entities/subscription.entity';
import { StripeWebhookService } from '../stripe-webhook.service';

const TENANT = '22222222-2222-4222-8222-222222222222';
const OTHER_TENANT = '33333333-3333-4333-8333-333333333333';

interface Rows {
  invoices: Invoice[];
  payments: Payment[];
  subscriptions: Subscription[];
}

interface Harness {
  service: StripeWebhookService;
  rows: Rows;
  saved: unknown[];
  errors: string[];
}

function invoiceRow(overrides: Partial<Invoice> = {}): Invoice {
  return Object.assign(new Invoice(), {
    id: 'inv-1',
    tenantId: TENANT,
    stripeInvoiceId: 'in_stripe_1',
    status: InvoiceStatus.SENT,
    total: new Decimal('100'),
    amountPaid: new Decimal('0'),
    amountDue: new Decimal('100'),
    currency: 'USD',
    ...overrides,
  });
}

function paymentRow(overrides: Partial<Payment> = {}): Payment {
  return Object.assign(new Payment(), {
    id: 'pay-1',
    tenantId: TENANT,
    invoiceId: 'inv-1',
    transactionId: 'TXN-1',
    amount: new Decimal('100'),
    currency: 'USD',
    status: PaymentStatus.SUCCEEDED,
    refundedAmount: new Decimal('0'),
    stripeChargeId: 'ch_stripe_1',
    stripePaymentIntentId: 'pi_stripe_1',
    ...overrides,
  });
}

function subscriptionRow(overrides: Partial<Subscription> = {}): Subscription {
  return Object.assign(new Subscription(), {
    id: 'sub-1',
    tenantId: TENANT,
    stripeSubscriptionId: 'sub_stripe_1',
    status: SubscriptionStatus.ACTIVE,
    autoRenew: true,
    ...overrides,
  });
}

/**
 * A manager whose `findOne` answers from in-memory rows by matching every key
 * of the `where` clause. That is the point of the test: a handler that scopes
 * its lookup by a tenant it read out of metadata finds nothing here, because
 * the metadata never carries that key.
 */
async function build(rows: Partial<Rows> = {}): Promise<Harness> {
  const all: Rows = {
    invoices: rows.invoices ?? [],
    payments: rows.payments ?? [],
    subscriptions: rows.subscriptions ?? [],
  };
  const saved: unknown[] = [];
  const errors: string[] = [];

  const pick = (entity: unknown): unknown[] => {
    if (entity === Invoice) return all.invoices;
    if (entity === Payment) return all.payments;
    if (entity === Subscription) return all.subscriptions;
    return [];
  };

  const manager = {
    findOne: (entity: unknown, options: { where?: Record<string, unknown> }) => {
      const where = options.where ?? {};
      const found = pick(entity).find((row) =>
        Object.entries(where).every(
          ([key, value]) => (row as Record<string, unknown>)[key] === value,
        ),
      );
      return Promise.resolve(found ?? null);
    },
    create: (_entity: unknown, value: unknown) => value,
    save: (_entity: unknown, value: unknown) => {
      saved.push(value);
      return Promise.resolve(Object.assign({ id: 'saved-1' }, value as object));
    },
  };

  const dataSource = {
    transaction: (work: (m: unknown) => Promise<unknown>) => work(manager),
  };

  const moduleRef = await Test.createTestingModule({
    providers: [StripeWebhookService, { provide: DataSource, useValue: dataSource }],
  }).compile();

  const service = moduleRef.get(StripeWebhookService);
  // The mismatch signal is the whole point of keeping the hint, so it is
  // asserted rather than silenced.
  jest
    .spyOn(service['logger'], 'error')
    .mockImplementation((message: unknown) => errors.push(String(message)));
  jest.spyOn(service['logger'], 'warn').mockImplementation(() => undefined);
  jest.spyOn(service['logger'], 'log').mockImplementation(() => undefined);
  jest.spyOn(service['logger'], 'debug').mockImplementation(() => undefined);

  return { service, rows: all, saved, errors };
}

describe('StripeWebhookService (ADR-0014): the owning row decides the tenant', () => {
  describe('payment_intent.succeeded', () => {
    const event = (metadata: Record<string, string> = {}) => ({
      data: {
        object: {
          id: 'pi_stripe_1',
          invoice: 'in_stripe_1',
          currency: 'usd',
          amount_received: 10_000,
          latest_charge: 'ch_stripe_1',
          metadata,
        },
      },
    });

    it('records the payment against the invoice that owns the intent, with NO metadata at all', async () => {
      const invoice = invoiceRow();
      const { service, saved } = await build({ invoices: [invoice] });

      await service.handlePaymentIntentSucceeded(event());

      // Before ADR-0014 this asserted nothing: the handler returned at the
      // first line because `metadata.tenantId` was absent — as it always was.
      const payment = saved.find(
        (row) => (row as Payment).stripePaymentIntentId === 'pi_stripe_1',
      ) as Payment | undefined;
      expect(payment).toBeDefined();
      expect(payment?.tenantId).toBe(TENANT);
      expect(payment?.invoiceId).toBe('inv-1');
      expect(payment?.status).toBe(PaymentStatus.SUCCEEDED);
      expect(invoice.status).toBe(InvoiceStatus.PAID);
      expect(invoice.amountDue.toString()).toBe('0');
    });

    it('ignores an intent no invoice of ours owns', async () => {
      const { service, saved } = await build({ invoices: [] });
      await service.handlePaymentIntentSucceeded(event());
      expect(saved).toHaveLength(0);
    });

    it('reaches the invoice through an existing payment row when Stripe names no invoice', async () => {
      const { service, saved } = await build({
        invoices: [invoiceRow()],
        payments: [paymentRow({ status: PaymentStatus.PENDING })],
      });

      await service.handlePaymentIntentSucceeded({
        data: {
          object: {
            id: 'pi_stripe_1',
            currency: 'usd',
            amount_received: 10_000,
            metadata: {},
          },
        },
      });

      expect((saved[0] as Payment).status).toBe(PaymentStatus.SUCCEEDED);
    });

    it('logs a metadata hint that disagrees with the row, and still uses the row', async () => {
      const { service, saved, errors } = await build({ invoices: [invoiceRow()] });

      await service.handlePaymentIntentSucceeded(
        event({ [STRIPE_TENANT_METADATA_KEY]: OTHER_TENANT }),
      );

      expect((saved[0] as Payment).tenantId).toBe(TENANT);
      expect(errors.join('\n')).toContain(OTHER_TENANT);
      expect(errors.join('\n')).toContain('The row wins');
    });

    it('is silent when the hint agrees', async () => {
      const { service, errors } = await build({ invoices: [invoiceRow()] });
      await service.handlePaymentIntentSucceeded(event({ [STRIPE_TENANT_METADATA_KEY]: TENANT }));
      expect(errors).toEqual([]);
    });
  });

  describe('payment_intent.payment_failed', () => {
    it('records the failure against the invoice that owns the intent', async () => {
      const { service, saved } = await build({ invoices: [invoiceRow()] });

      await service.handlePaymentIntentFailed({
        data: {
          object: {
            id: 'pi_stripe_2',
            invoice: 'in_stripe_1',
            currency: 'usd',
            amount: 10_000,
            status: 'requires_payment_method',
            last_payment_error: { message: 'card declined', code: 'card_declined' },
            metadata: {},
          },
        },
      });

      const payment = saved[0] as Payment;
      expect(payment.tenantId).toBe(TENANT);
      expect(payment.invoiceId).toBe('inv-1');
      expect(payment.status).toBe(PaymentStatus.FAILED);
      expect(payment.failureReason).toContain('card_declined');
    });
  });

  describe('invoice.payment_failed', () => {
    it('moves the subscription the Stripe subscription id resolves to into PAST_DUE', async () => {
      const subscription = subscriptionRow();
      const { service } = await build({ subscriptions: [subscription] });

      await service.handleInvoicePaymentFailed({
        data: { object: { subscription: 'sub_stripe_1', metadata: {} } },
      });

      expect(subscription.status).toBe(SubscriptionStatus.PAST_DUE);
    });

    it('ignores a Stripe subscription no row of ours owns', async () => {
      const { service, saved } = await build({ subscriptions: [] });
      await service.handleInvoicePaymentFailed({
        data: { object: { subscription: 'sub_stripe_unknown', metadata: {} } },
      });
      expect(saved).toHaveLength(0);
    });
  });

  describe('customer.subscription.deleted', () => {
    it('cancels the subscription the Stripe id resolves to', async () => {
      const subscription = subscriptionRow();
      const { service } = await build({ subscriptions: [subscription] });

      await service.handleSubscriptionDeleted({
        data: { object: { id: 'sub_stripe_1', metadata: {} } },
      });

      expect(subscription.status).toBe(SubscriptionStatus.CANCELLED);
      expect(subscription.autoRenew).toBe(false);
      expect(subscription.cancelledAt).toBeInstanceOf(Date);
    });

    it('logs a disagreeing hint and cancels the row it actually found', async () => {
      const subscription = subscriptionRow();
      const { service, errors } = await build({ subscriptions: [subscription] });

      await service.handleSubscriptionDeleted({
        data: {
          object: {
            id: 'sub_stripe_1',
            metadata: { [STRIPE_TENANT_METADATA_KEY]: OTHER_TENANT },
          },
        },
      });

      expect(subscription.status).toBe(SubscriptionStatus.CANCELLED);
      expect(errors.join('\n')).toContain('The row wins');
    });
  });

  describe('charge.refunded', () => {
    it('refunds the payment the charge id resolves to', async () => {
      const payment = paymentRow();
      const { service } = await build({
        payments: [payment],
        invoices: [invoiceRow({ status: InvoiceStatus.PAID })],
      });

      await service.handleChargeRefunded({
        data: {
          object: {
            id: 'ch_stripe_1',
            currency: 'usd',
            amount: 10_000,
            amount_refunded: 10_000,
            refunds: { data: [{ id: 're_1' }] },
            metadata: {},
          },
        },
      });

      expect(payment.status).toBe(PaymentStatus.REFUNDED);
      expect(payment.refundedAmount.toString()).toBe('100');
    });

    it('records a partial refund as PARTIALLY_REFUNDED', async () => {
      const payment = paymentRow();
      const { service } = await build({ payments: [payment] });

      await service.handleChargeRefunded({
        data: {
          object: {
            id: 'ch_stripe_1',
            currency: 'usd',
            amount: 10_000,
            amount_refunded: 4_000,
            refunds: { data: [{ id: 're_1' }] },
            metadata: {},
          },
        },
      });

      expect(payment.status).toBe(PaymentStatus.PARTIALLY_REFUNDED);
      expect(payment.refundedAmount.toString()).toBe('40');
    });

    it('ignores a charge no payment of ours owns', async () => {
      const { service, saved } = await build({ payments: [] });
      await service.handleChargeRefunded({
        data: {
          object: { id: 'ch_unknown', currency: 'usd', amount: 100, amount_refunded: 100 },
        },
      });
      expect(saved).toHaveLength(0);
    });
  });
});
