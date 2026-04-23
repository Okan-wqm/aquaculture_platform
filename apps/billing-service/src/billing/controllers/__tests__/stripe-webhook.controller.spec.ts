import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { createHmac } from 'crypto';
import { RedisService } from '@aquaculture/backend-common/redis';
import { StripeWebhookController } from '../stripe-webhook.controller';
import { StripeWebhookService } from '../stripe-webhook.service';

/**
 * Build a valid Stripe signature header for testing.
 */
function buildSignatureHeader(payload: string, secret: string, timestamp?: number): string {
  const ts = timestamp ?? Math.floor(Date.now() / 1000);
  const signedPayload = `${ts}.${payload}`;
  const signature = createHmac('sha256', secret).update(signedPayload, 'utf8').digest('hex');
  return `t=${ts},v1=${signature}`;
}

function createMockRequest(body: Record<string, any>, secret: string, options?: { timestamp?: number; signature?: string }) {
  const rawBody = Buffer.from(JSON.stringify(body), 'utf8');
  const sig = options?.signature ?? buildSignatureHeader(rawBody.toString('utf8'), secret, options?.timestamp);
  return {
    rawBody,
    headers: { 'stripe-signature': sig },
  };
}

function createMockResponse() {
  const res: any = {
    statusCode: 200,
    body: null,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(data: any) {
      res.body = data;
      return res;
    },
  };
  return res;
}

describe('StripeWebhookController', () => {
  let controller: StripeWebhookController;
  let webhookService: jest.Mocked<StripeWebhookService>;
  let mockRedisService: any;
  const WEBHOOK_SECRET = 'whsec_test_secret_key_12345';

  beforeEach(async () => {
    mockRedisService = {
      setNx: jest.fn().mockResolvedValue(true), // Default: not a duplicate
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [StripeWebhookController],
      providers: [
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string, defaultValue?: string) => {
              if (key === 'STRIPE_WEBHOOK_SECRET') return WEBHOOK_SECRET;
              return defaultValue;
            }),
          },
        },
        {
          provide: StripeWebhookService,
          useValue: {
            handlePaymentIntentSucceeded: jest.fn().mockResolvedValue(undefined),
            handlePaymentIntentFailed: jest.fn().mockResolvedValue(undefined),
            handleInvoicePaymentFailed: jest.fn().mockResolvedValue(undefined),
            handleSubscriptionDeleted: jest.fn().mockResolvedValue(undefined),
            handleChargeRefunded: jest.fn().mockResolvedValue(undefined),
          },
        },
        {
          provide: RedisService,
          useValue: mockRedisService,
        },
      ],
    }).compile();

    controller = module.get<StripeWebhookController>(StripeWebhookController);
    webhookService = module.get(StripeWebhookService);
  });

  describe('Signature Verification', () => {
    it('should accept a valid signature', async () => {
      const event = {
        id: 'evt_test_valid_sig',
        type: 'payment_intent.succeeded',
        data: { object: { id: 'pi_123', metadata: { tenantId: 'tid', invoiceId: 'iid' } } },
      };

      const req = createMockRequest(event, WEBHOOK_SECRET);
      const res = createMockResponse();

      await controller.handleStripeWebhook(req as any, res);

      expect(res.statusCode).toBe(200);
      expect(res.body).toEqual({ received: true });
      expect(webhookService.handlePaymentIntentSucceeded).toHaveBeenCalled();
    });

    it('should reject an invalid signature', async () => {
      const event = {
        id: 'evt_test_invalid_sig',
        type: 'payment_intent.succeeded',
        data: { object: {} },
      };

      const req = createMockRequest(event, WEBHOOK_SECRET, {
        signature: 't=123456,v1=invalid_signature_hex',
      });
      const res = createMockResponse();

      await controller.handleStripeWebhook(req as any, res);

      expect(res.statusCode).toBe(400);
      expect(res.body.error).toBe('Invalid signature');
      expect(webhookService.handlePaymentIntentSucceeded).not.toHaveBeenCalled();
    });

    it('should reject a request with missing stripe-signature header', async () => {
      const req = {
        rawBody: Buffer.from('{}', 'utf8'),
        headers: {},
      };
      const res = createMockResponse();

      await controller.handleStripeWebhook(req as any, res);

      expect(res.statusCode).toBe(400);
      expect(res.body.error).toBe('Missing stripe-signature header');
    });

    it('should reject a replayed request with stale timestamp', async () => {
      const staleTimestamp = Math.floor(Date.now() / 1000) - 600; // 10 minutes ago
      const event = {
        id: 'evt_test_stale',
        type: 'payment_intent.succeeded',
        data: { object: {} },
      };

      const req = createMockRequest(event, WEBHOOK_SECRET, { timestamp: staleTimestamp });
      const res = createMockResponse();

      await controller.handleStripeWebhook(req as any, res);

      expect(res.statusCode).toBe(400);
      expect(res.body.error).toBe('Invalid signature');
    });

    it('should reject a request with no raw body', async () => {
      const req = {
        rawBody: undefined,
        headers: { 'stripe-signature': 't=123,v1=abc' },
      };
      const res = createMockResponse();

      await controller.handleStripeWebhook(req as any, res);

      expect(res.statusCode).toBe(400);
      expect(res.body.error).toBe('Missing request body');
    });
  });

  describe('Idempotency', () => {
    it('should skip duplicate events', async () => {
      mockRedisService.setNx.mockResolvedValue(false); // Duplicate

      const event = {
        id: 'evt_duplicate',
        type: 'payment_intent.succeeded',
        data: { object: { id: 'pi_123', metadata: { tenantId: 'tid', invoiceId: 'iid' } } },
      };

      const req = createMockRequest(event, WEBHOOK_SECRET);
      const res = createMockResponse();

      await controller.handleStripeWebhook(req as any, res);

      expect(res.statusCode).toBe(200);
      expect(res.body).toEqual({ received: true, duplicate: true });
      expect(webhookService.handlePaymentIntentSucceeded).not.toHaveBeenCalled();
    });

    it('should process new events and set idempotency key', async () => {
      mockRedisService.setNx.mockResolvedValue(true);

      const event = {
        id: 'evt_new',
        type: 'payment_intent.succeeded',
        data: { object: { id: 'pi_456', metadata: { tenantId: 'tid', invoiceId: 'iid' } } },
      };

      const req = createMockRequest(event, WEBHOOK_SECRET);
      const res = createMockResponse();

      await controller.handleStripeWebhook(req as any, res);

      expect(mockRedisService.setNx).toHaveBeenCalledWith(
        'webhook:stripe:evt_new',
        expect.any(String),
        259200, // 72 hours
      );
      expect(webhookService.handlePaymentIntentSucceeded).toHaveBeenCalled();
    });
  });

  describe('Event Routing', () => {
    const makeEvent = (type: string, id = 'evt_route_test') => ({
      id,
      type,
      data: { object: { id: 'obj_123', metadata: { tenantId: 'tid', invoiceId: 'iid' } } },
    });

    it('should route payment_intent.succeeded to handlePaymentIntentSucceeded', async () => {
      const event = makeEvent('payment_intent.succeeded');
      const req = createMockRequest(event, WEBHOOK_SECRET);
      const res = createMockResponse();

      await controller.handleStripeWebhook(req as any, res);

      expect(webhookService.handlePaymentIntentSucceeded).toHaveBeenCalledWith(event);
    });

    it('should route payment_intent.payment_failed to handlePaymentIntentFailed', async () => {
      const event = makeEvent('payment_intent.payment_failed');
      const req = createMockRequest(event, WEBHOOK_SECRET);
      const res = createMockResponse();

      await controller.handleStripeWebhook(req as any, res);

      expect(webhookService.handlePaymentIntentFailed).toHaveBeenCalledWith(event);
    });

    it('should route invoice.payment_failed to handleInvoicePaymentFailed', async () => {
      const event = makeEvent('invoice.payment_failed');
      const req = createMockRequest(event, WEBHOOK_SECRET);
      const res = createMockResponse();

      await controller.handleStripeWebhook(req as any, res);

      expect(webhookService.handleInvoicePaymentFailed).toHaveBeenCalledWith(event);
    });

    it('should route customer.subscription.deleted to handleSubscriptionDeleted', async () => {
      const event = makeEvent('customer.subscription.deleted');
      const req = createMockRequest(event, WEBHOOK_SECRET);
      const res = createMockResponse();

      await controller.handleStripeWebhook(req as any, res);

      expect(webhookService.handleSubscriptionDeleted).toHaveBeenCalledWith(event);
    });

    it('should route charge.refunded to handleChargeRefunded', async () => {
      const event = makeEvent('charge.refunded');
      const req = createMockRequest(event, WEBHOOK_SECRET);
      const res = createMockResponse();

      await controller.handleStripeWebhook(req as any, res);

      expect(webhookService.handleChargeRefunded).toHaveBeenCalledWith(event);
    });

    it('should ignore unsupported event types and return 200', async () => {
      const event = makeEvent('checkout.session.completed');
      const req = createMockRequest(event, WEBHOOK_SECRET);
      const res = createMockResponse();

      await controller.handleStripeWebhook(req as any, res);

      expect(res.statusCode).toBe(200);
      expect(webhookService.handlePaymentIntentSucceeded).not.toHaveBeenCalled();
    });
  });

  describe('Error Handling', () => {
    it('should return 200 even when handler throws', async () => {
      webhookService.handlePaymentIntentSucceeded.mockRejectedValue(
        new Error('DB connection lost'),
      );

      const event = {
        id: 'evt_error_test',
        type: 'payment_intent.succeeded',
        data: { object: { id: 'pi_err', metadata: { tenantId: 'tid', invoiceId: 'iid' } } },
      };

      const req = createMockRequest(event, WEBHOOK_SECRET);
      const res = createMockResponse();

      await controller.handleStripeWebhook(req as any, res);

      // Must still return 200 to prevent Stripe retry storms
      expect(res.statusCode).toBe(200);
      expect(res.body).toEqual({ received: true });
    });

    it('should return 400 for malformed JSON body', async () => {
      const rawBody = Buffer.from('not-json', 'utf8');
      const ts = Math.floor(Date.now() / 1000);
      const sig = createHmac('sha256', WEBHOOK_SECRET)
        .update(`${ts}.not-json`, 'utf8')
        .digest('hex');

      const req = {
        rawBody,
        headers: { 'stripe-signature': `t=${ts},v1=${sig}` },
      };
      const res = createMockResponse();

      await controller.handleStripeWebhook(req as any, res);

      expect(res.statusCode).toBe(400);
      expect(res.body.error).toBe('Invalid JSON payload');
    });
  });
});
