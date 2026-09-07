import { Test, TestingModule } from '@nestjs/testing';
import { Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import Decimal from 'decimal.js';
import { RedisService } from '@aquaculture/backend-common/redis';
import { STRIPE_TENANT_METADATA_KEY } from '@aquaculture/backend-common/billing';
import { StripeWebhookService } from '../stripe-webhook.service';
import { Payment, PaymentStatus, PaymentMethod } from '../../entities/payment.entity';
import { Invoice, InvoiceStatus } from '../../entities/invoice.entity';
import { Subscription, SubscriptionStatus } from '../../entities/subscription.entity';

/**
 * SECREV-CRITICAL-001 regression suite.
 *
 * Every case here drives a handler with a payload whose metadata does NOT
 * carry the key the handlers used to read (`metadata.tenantId`). Before the
 * fix each handler warned and returned, so every one of these assertions
 * failed on an empty ledger: no payment recorded, no subscription moved to
 * PAST_DUE or CANCELLED, no refund reaching a payment row.
 *
 * The metadata that IS present uses the canonical producer key so the suite
 * also pins the cross-check path — a hint that disagrees with the owning row
 * must be logged and ignored, never honoured.
 */

const TENANT = '11111111-1111-4111-8111-111111111111';
const OTHER_TENANT = '22222222-2222-4222-8222-222222222222';

interface FakeStore {
  payments: Partial<Payment>[];
  invoices: Partial<Invoice>[];
  subscriptions: Partial<Subscription>[];
}

function matches(row: Record<string, unknown>, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([key, value]) => row[key] === value);
}

function createMockManager(store: FakeStore) {
  const collectionFor = (entity: unknown): Record<string, unknown>[] | undefined => {
    if (entity === Payment) return store.payments as Record<string, unknown>[];
    if (entity === Invoice) return store.invoices as Record<string, unknown>[];
    if (entity === Subscription) return store.subscriptions as Record<string, unknown>[];
    return undefined;
  };

  return {
    findOne: jest.fn(
      (entity: unknown, options: { where: Record<string, unknown> }): Promise<unknown> => {
        const collection = collectionFor(entity);
        if (!collection) return Promise.resolve(null);
        return Promise.resolve(collection.find((row) => matches(row, options.where)) ?? null);
      },
    ),
    create: jest.fn((_entity: unknown, data: Record<string, unknown>) => ({ ...data })),
    merge: jest.fn(
      (_entity: unknown, target: Record<string, unknown>, source: Record<string, unknown>) =>
        Object.assign(target, source),
    ),
    save: jest.fn((entity: unknown, data: Record<string, unknown>) => {
      const collection = collectionFor(entity);
      if (collection && !collection.includes(data)) {
        collection.push(data);
      }
      if (!data['id']) {
        data['id'] = `generated-${collection?.length ?? 0}`;
      }
      return Promise.resolve(data);
    }),
  };
}

function buildInvoice(overrides: Partial<Invoice> = {}): Partial<Invoice> {
  return {
    id: 'invoice-local-1',
    tenantId: TENANT,
    stripeInvoiceId: 'in_stripe_1',
    status: InvoiceStatus.SENT,
    currency: 'USD',
    total: new Decimal(100),
    amountPaid: new Decimal(0),
    amountDue: new Decimal(100),
    ...overrides,
  };
}

function buildPayment(overrides: Partial<Payment> = {}): Partial<Payment> {
  return {
    id: 'payment-local-1',
    tenantId: TENANT,
    invoiceId: 'invoice-local-1',
    transactionId: 'TXN-EXISTING',
    amount: new Decimal(100),
    currency: 'USD',
    status: PaymentStatus.PENDING,
    paymentMethod: PaymentMethod.CREDIT_CARD,
    refundedAmount: new Decimal(0),
    ...overrides,
  };
}

function buildSubscription(overrides: Partial<Subscription> = {}): Partial<Subscription> {
  return {
    id: 'subscription-local-1',
    tenantId: TENANT,
    stripeSubscriptionId: 'sub_stripe_1',
    status: SubscriptionStatus.ACTIVE,
    autoRenew: true,
    ...overrides,
  };
}

function paymentIntentEvent(
  object: Record<string, unknown>,
  type = 'payment_intent.succeeded',
): Record<string, unknown> {
  return { type, data: { object } };
}

describe('StripeWebhookService — tenant resolution (SECREV-CRITICAL-001)', () => {
  let service: StripeWebhookService;
  let store: FakeStore;
  let manager: ReturnType<typeof createMockManager>;
  let publish: jest.Mock;
  let errorLog: jest.SpyInstance;

  beforeEach(async () => {
    store = { payments: [], invoices: [], subscriptions: [] };
    manager = createMockManager(store);
    publish = jest.fn().mockResolvedValue(undefined);
    errorLog = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        StripeWebhookService,
        {
          provide: DataSource,
          useValue: {
            transaction: jest.fn((cb: (mgr: typeof manager) => Promise<unknown>) => cb(manager)),
          },
        },
        { provide: 'EVENT_BUS', useValue: { publish } },
        { provide: RedisService, useValue: { del: jest.fn().mockResolvedValue(1) } },
      ],
    }).compile();

    service = module.get(StripeWebhookService);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('payment_intent.succeeded', () => {
    it('records the payment against the invoice that owns the intent, with no tenant in metadata', async () => {
      store.invoices.push(buildInvoice());

      await service.handlePaymentIntentSucceeded(
        paymentIntentEvent({
          id: 'pi_stripe_1',
          currency: 'usd',
          amount_received: 10000,
          invoice: 'in_stripe_1',
          metadata: {},
        }),
      );

      expect(store.payments).toHaveLength(1);
      expect(store.payments[0]).toMatchObject({
        tenantId: TENANT,
        invoiceId: 'invoice-local-1',
        status: PaymentStatus.SUCCEEDED,
        stripePaymentIntentId: 'pi_stripe_1',
      });
      expect(store.invoices[0]?.status).toBe(InvoiceStatus.PAID);
      expect(publish).toHaveBeenCalledTimes(1);
    });

    it('resolves through an existing payment row carrying the intent id', async () => {
      store.invoices.push(buildInvoice());
      const pending = buildPayment({ stripePaymentIntentId: 'pi_stripe_1' });
      store.payments.push(pending);

      await service.handlePaymentIntentSucceeded(
        paymentIntentEvent({
          id: 'pi_stripe_1',
          currency: 'usd',
          amount_received: 10000,
          latest_charge: 'ch_stripe_1',
          metadata: {},
        }),
      );

      expect(store.payments).toHaveLength(1);
      expect(pending.status).toBe(PaymentStatus.SUCCEEDED);
      expect(pending.stripeChargeId).toBe('ch_stripe_1');
    });

    it('honours the owning row and logs an ERROR when metadata claims a different tenant', async () => {
      store.invoices.push(buildInvoice());

      await service.handlePaymentIntentSucceeded(
        paymentIntentEvent({
          id: 'pi_stripe_1',
          currency: 'usd',
          amount_received: 10000,
          invoice: 'in_stripe_1',
          metadata: { [STRIPE_TENANT_METADATA_KEY]: OTHER_TENANT },
        }),
      );

      expect(store.payments[0]?.tenantId).toBe(TENANT);
      expect(errorLog).toHaveBeenCalledWith(expect.stringContaining(OTHER_TENANT));
    });

    it('writes nothing when no local payment or invoice owns the intent', async () => {
      await service.handlePaymentIntentSucceeded(
        paymentIntentEvent({
          id: 'pi_unknown',
          currency: 'usd',
          amount_received: 10000,
          invoice: 'in_unknown',
          metadata: { [STRIPE_TENANT_METADATA_KEY]: TENANT },
        }),
      );

      expect(store.payments).toHaveLength(0);
      expect(manager.save).not.toHaveBeenCalled();
    });
  });

  describe('payment_intent.payment_failed', () => {
    it('records a FAILED payment resolved through the mirrored invoice', async () => {
      store.invoices.push(buildInvoice());

      await service.handlePaymentIntentFailed(
        paymentIntentEvent(
          {
            id: 'pi_stripe_1',
            currency: 'usd',
            amount: 10000,
            invoice: 'in_stripe_1',
            status: 'requires_payment_method',
            last_payment_error: { message: 'Your card was declined.', code: 'card_declined' },
            metadata: {},
          },
          'payment_intent.payment_failed',
        ),
      );

      expect(store.payments).toHaveLength(1);
      expect(store.payments[0]).toMatchObject({
        tenantId: TENANT,
        invoiceId: 'invoice-local-1',
        status: PaymentStatus.FAILED,
      });
      expect(publish).toHaveBeenCalledTimes(1);
    });

    it('transitions the existing row instead of inserting a second row with the same intent id', async () => {
      store.invoices.push(buildInvoice());
      const pending = buildPayment({ stripePaymentIntentId: 'pi_stripe_1' });
      store.payments.push(pending);

      await service.handlePaymentIntentFailed(
        paymentIntentEvent(
          {
            id: 'pi_stripe_1',
            currency: 'usd',
            amount: 10000,
            last_payment_error: { message: 'Insufficient funds', code: 'card_declined' },
            metadata: {},
          },
          'payment_intent.payment_failed',
        ),
      );

      expect(store.payments).toHaveLength(1);
      expect(pending.status).toBe(PaymentStatus.FAILED);
      expect(manager.create).not.toHaveBeenCalled();
    });

    it('skips a duplicate delivery once the row is already FAILED', async () => {
      store.payments.push(
        buildPayment({ stripePaymentIntentId: 'pi_stripe_1', status: PaymentStatus.FAILED }),
      );

      await service.handlePaymentIntentFailed(
        paymentIntentEvent(
          {
            id: 'pi_stripe_1',
            currency: 'usd',
            amount: 10000,
            last_payment_error: { message: 'Insufficient funds', code: 'card_declined' },
            metadata: {},
          },
          'payment_intent.payment_failed',
        ),
      );

      expect(store.payments).toHaveLength(1);
      expect(manager.save).not.toHaveBeenCalled();
      expect(publish).not.toHaveBeenCalled();
    });
  });

  describe('invoice.payment_failed', () => {
    it('moves the owning subscription to PAST_DUE with no tenant in metadata', async () => {
      const subscription = buildSubscription();
      store.subscriptions.push(subscription);

      await service.handleInvoicePaymentFailed({
        type: 'invoice.payment_failed',
        data: { object: { id: 'in_stripe_1', subscription: 'sub_stripe_1', metadata: {} } },
      });

      expect(subscription.status).toBe(SubscriptionStatus.PAST_DUE);
    });

    it('does nothing when no local subscription owns the Stripe subscription id', async () => {
      await service.handleInvoicePaymentFailed({
        type: 'invoice.payment_failed',
        data: {
          object: {
            id: 'in_stripe_1',
            subscription: 'sub_unknown',
            metadata: { [STRIPE_TENANT_METADATA_KEY]: TENANT },
          },
        },
      });

      expect(manager.save).not.toHaveBeenCalled();
    });
  });

  describe('customer.subscription.deleted', () => {
    it('cancels the owning subscription with no tenant in metadata', async () => {
      const subscription = buildSubscription();
      store.subscriptions.push(subscription);

      await service.handleSubscriptionDeleted({
        type: 'customer.subscription.deleted',
        data: { object: { id: 'sub_stripe_1', metadata: {} } },
      });

      expect(subscription.status).toBe(SubscriptionStatus.CANCELLED);
      expect(subscription.autoRenew).toBe(false);
      expect(publish).toHaveBeenCalledTimes(1);
    });
  });

  describe('charge.refunded', () => {
    it('marks the payment REFUNDED when the charge id is recorded on the row', async () => {
      store.invoices.push(buildInvoice());
      const payment = buildPayment({
        status: PaymentStatus.SUCCEEDED,
        stripeChargeId: 'ch_stripe_1',
      });
      store.payments.push(payment);

      await service.handleChargeRefunded({
        type: 'charge.refunded',
        data: {
          object: {
            id: 'ch_stripe_1',
            currency: 'usd',
            amount: 10000,
            amount_refunded: 10000,
            metadata: {},
          },
        },
      });

      expect(payment.status).toBe(PaymentStatus.REFUNDED);
      expect(store.invoices[0]?.status).toBe(InvoiceStatus.REFUNDED);
    });

    it('falls back to the payment intent and backfills the charge id', async () => {
      store.invoices.push(buildInvoice());
      const payment = buildPayment({
        status: PaymentStatus.SUCCEEDED,
        stripePaymentIntentId: 'pi_stripe_1',
      });
      store.payments.push(payment);

      await service.handleChargeRefunded({
        type: 'charge.refunded',
        data: {
          object: {
            id: 'ch_stripe_1',
            payment_intent: 'pi_stripe_1',
            currency: 'usd',
            amount: 10000,
            amount_refunded: 4000,
            metadata: {},
          },
        },
      });

      expect(payment.status).toBe(PaymentStatus.PARTIALLY_REFUNDED);
      expect(payment.stripeChargeId).toBe('ch_stripe_1');
    });

    it('honours the owning row and logs an ERROR when metadata claims a different tenant', async () => {
      const payment = buildPayment({
        status: PaymentStatus.SUCCEEDED,
        stripeChargeId: 'ch_stripe_1',
      });
      store.payments.push(payment);

      await service.handleChargeRefunded({
        type: 'charge.refunded',
        data: {
          object: {
            id: 'ch_stripe_1',
            currency: 'usd',
            amount: 10000,
            amount_refunded: 4000,
            metadata: { [STRIPE_TENANT_METADATA_KEY]: OTHER_TENANT },
          },
        },
      });

      expect(payment.tenantId).toBe(TENANT);
      expect(payment.status).toBe(PaymentStatus.PARTIALLY_REFUNDED);
      expect(errorLog).toHaveBeenCalledWith(expect.stringContaining(OTHER_TENANT));
    });
  });
});
