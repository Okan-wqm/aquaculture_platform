import {
  Controller,
  Post,
  Req,
  Res,
  HttpCode,
  Logger,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Request, Response } from 'express';
import { createHmac, timingSafeEqual } from 'crypto';
import { Public } from '@aquaculture/backend-common';
import { RedisService } from '@aquaculture/backend-common';
import { StripeWebhookService } from './stripe-webhook.service';

/**
 * Represents a raw-body Express request.
 * NestJS RawBodyRequest attaches rawBody when bodyParser is configured.
 */
interface RawBodyRequest extends Request {
  rawBody?: Buffer;
}

/**
 * Supported Stripe webhook event types.
 * New event types should be added here and in the handler switch.
 */
const SUPPORTED_EVENTS = [
  'payment_intent.succeeded',
  'payment_intent.payment_failed',
  'invoice.payment_failed',
  'customer.subscription.deleted',
  'charge.refunded',
] as const;

type SupportedEventType = (typeof SUPPORTED_EVENTS)[number];

/**
 * Stripe Webhook Controller
 *
 * Receives Stripe webhook events via POST /webhooks/stripe.
 * Performs:
 *   1. HMAC-SHA256 signature verification (no Stripe SDK dependency)
 *   2. Redis-based idempotency check (event ID dedup)
 *   3. Event routing to StripeWebhookService handlers
 *
 * SECURITY:
 * - @Public() bypasses JWT auth and tenant guards (Stripe-originated requests)
 * - Signature verification replaces authentication
 * - Raw body required for correct signature computation
 * - Always returns 200 to prevent Stripe retry storms on processing errors
 *
 * IDEMPOTENCY:
 * - Stripe event IDs are stored in Redis with 72h TTL
 * - Duplicate events are acknowledged (200) but not reprocessed
 */
@Controller('webhooks')
export class StripeWebhookController {
  private readonly logger = new Logger(StripeWebhookController.name);
  private readonly webhookSecret: string;

  /** Redis TTL for processed event IDs (72 hours in seconds) */
  private static readonly IDEMPOTENCY_TTL_SECONDS = 72 * 60 * 60;

  /** Maximum allowed timestamp skew for signature verification (5 minutes) */
  private static readonly MAX_TIMESTAMP_SKEW_SECONDS = 300;

  constructor(
    private readonly configService: ConfigService,
    private readonly webhookService: StripeWebhookService,
    @Optional() private readonly redisService?: RedisService,
  ) {
    this.webhookSecret = this.configService.get<string>('STRIPE_WEBHOOK_SECRET', '');
    if (!this.webhookSecret) {
      this.logger.warn(
        'STRIPE_WEBHOOK_SECRET is not configured. Webhook signature verification will reject all requests.',
      );
    }
  }

  @Post('stripe')
  @Public()
  @HttpCode(200)
  async handleStripeWebhook(
    @Req() req: RawBodyRequest,
    @Res() res: Response,
  ): Promise<void> {
    // 1. Extract raw body
    const rawBody = req.rawBody;
    if (!rawBody || rawBody.length === 0) {
      this.logger.warn('Webhook request missing raw body');
      res.status(400).json({ error: 'Missing request body' });
      return;
    }

    // 2. Verify signature
    const signatureHeader = req.headers['stripe-signature'] as string | undefined;
    if (!signatureHeader) {
      this.logger.warn('Webhook request missing stripe-signature header');
      res.status(400).json({ error: 'Missing stripe-signature header' });
      return;
    }

    if (!this.webhookSecret) {
      this.logger.error('STRIPE_WEBHOOK_SECRET not configured, rejecting webhook');
      res.status(500).json({ error: 'Webhook secret not configured' });
      return;
    }

    const verificationResult = this.verifySignature(rawBody, signatureHeader, this.webhookSecret);
    if (!verificationResult.valid) {
      this.logger.warn(`Webhook signature verification failed: ${verificationResult.reason}`);
      res.status(400).json({ error: 'Invalid signature' });
      return;
    }

    // 3. Parse event
    let event: Record<string, any>;
    try {
      event = JSON.parse(rawBody.toString('utf8'));
    } catch {
      this.logger.warn('Failed to parse webhook payload as JSON');
      res.status(400).json({ error: 'Invalid JSON payload' });
      return;
    }

    const eventId: string | undefined = event.id;
    const eventType: string | undefined = event.type;

    if (!eventId || !eventType) {
      this.logger.warn('Webhook payload missing id or type');
      res.status(400).json({ error: 'Invalid event structure' });
      return;
    }

    // 4. Idempotency check (Redis)
    if (this.redisService) {
      const idempotencyKey = `webhook:stripe:${eventId}`;
      const isNew = await this.redisService.setNx(
        idempotencyKey,
        new Date().toISOString(),
        StripeWebhookController.IDEMPOTENCY_TTL_SECONDS,
      );

      if (!isNew) {
        this.logger.log(`Duplicate webhook event ${eventId} (${eventType}), skipping`);
        res.status(200).json({ received: true, duplicate: true });
        return;
      }
    }

    // 5. Route to handler
    this.logger.log(`Processing webhook event: ${eventType} (${eventId})`);

    if (this.isSupportedEvent(eventType)) {
      try {
        await this.routeEvent(eventType, event);
      } catch (err) {
        // CRITICAL: Always return 200 to Stripe. Log the error for investigation.
        // Returning non-200 causes Stripe to retry, which can amplify failures.
        this.logger.error(
          `Error processing webhook event ${eventType} (${eventId}): ${
            err instanceof Error ? err.message : 'Unknown error'
          }`,
          err instanceof Error ? err.stack : undefined,
        );
      }
    } else {
      this.logger.log(`Ignoring unsupported event type: ${eventType}`);
    }

    // 6. Always acknowledge
    res.status(200).json({ received: true });
  }

  /**
   * Verify Stripe webhook signature using HMAC-SHA256.
   *
   * Stripe signature header format: t=<timestamp>,v1=<signature>[,v0=<legacy>]
   *
   * Verification steps:
   *   1. Parse timestamp and v1 signature from header
   *   2. Check timestamp is within acceptable skew (replay attack prevention)
   *   3. Compute expected signature: HMAC-SHA256(secret, "<timestamp>.<rawBody>")
   *   4. Timing-safe comparison of expected vs received signature
   */
  private verifySignature(
    rawBody: Buffer,
    signatureHeader: string,
    secret: string,
  ): { valid: boolean; reason?: string } {
    // Parse header components
    const elements = signatureHeader.split(',');
    let timestamp: string | undefined;
    let signature: string | undefined;

    for (const element of elements) {
      const [key, value] = element.split('=');
      if (key === 't') {
        timestamp = value;
      } else if (key === 'v1') {
        signature = value;
      }
    }

    if (!timestamp || !signature) {
      return { valid: false, reason: 'Missing timestamp or v1 signature in header' };
    }

    // Check timestamp freshness (prevent replay attacks)
    const timestampSeconds = parseInt(timestamp, 10);
    if (isNaN(timestampSeconds)) {
      return { valid: false, reason: 'Invalid timestamp format' };
    }

    const currentSeconds = Math.floor(Date.now() / 1000);
    const skew = Math.abs(currentSeconds - timestampSeconds);
    if (skew > StripeWebhookController.MAX_TIMESTAMP_SKEW_SECONDS) {
      return {
        valid: false,
        reason: `Timestamp skew ${skew}s exceeds maximum ${StripeWebhookController.MAX_TIMESTAMP_SKEW_SECONDS}s`,
      };
    }

    // Compute expected signature
    const signedPayload = `${timestamp}.${rawBody.toString('utf8')}`;
    const expectedSignature = createHmac('sha256', secret)
      .update(signedPayload, 'utf8')
      .digest('hex');

    // Timing-safe comparison
    const expectedBuffer = Buffer.from(expectedSignature, 'utf8');
    const receivedBuffer = Buffer.from(signature, 'utf8');

    if (expectedBuffer.length !== receivedBuffer.length) {
      return { valid: false, reason: 'Signature length mismatch' };
    }

    const isValid = timingSafeEqual(expectedBuffer, receivedBuffer);
    if (!isValid) {
      return { valid: false, reason: 'Signature mismatch' };
    }

    return { valid: true };
  }

  /**
   * Type guard for supported event types
   */
  private isSupportedEvent(eventType: string): eventType is SupportedEventType {
    return (SUPPORTED_EVENTS as readonly string[]).includes(eventType);
  }

  /**
   * Route verified events to the appropriate handler.
   * Each handler is wrapped in its own error boundary by the caller.
   */
  private async routeEvent(eventType: SupportedEventType, event: Record<string, any>): Promise<void> {
    switch (eventType) {
      case 'payment_intent.succeeded':
        await this.webhookService.handlePaymentIntentSucceeded(event);
        break;

      case 'payment_intent.payment_failed':
        await this.webhookService.handlePaymentIntentFailed(event);
        break;

      case 'invoice.payment_failed':
        await this.webhookService.handleInvoicePaymentFailed(event);
        break;

      case 'customer.subscription.deleted':
        await this.webhookService.handleSubscriptionDeleted(event);
        break;

      case 'charge.refunded':
        await this.webhookService.handleChargeRefunded(event);
        break;
    }
  }
}
