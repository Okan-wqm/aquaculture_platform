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
import { Public } from '@aquaculture/backend-common/decorators';
import { RedisService } from '@aquaculture/backend-common/redis';
import { AuditLogService, AuditSeverity } from '@aquaculture/backend-common/audit';
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
    // AUDITTRAIL-CRITICAL-005 closure: every webhook outcome (signature
    // failure, dedup, parse failure, success, handler error) writes a
    // transactional audit row via recordAwait. Optional injection
    // because the audit-log infrastructure may not be wired during
    // local-dev-without-db scenarios; production registers it via
    // AuditLogModule.forRoot() in app.module.ts.
    @Optional() private readonly auditLog?: AuditLogService,
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
    const sourceIp = (req.ip ?? (req.headers['x-forwarded-for'] as string | undefined) ?? 'unknown')
      .toString()
      .substring(0, 45);
    if (!rawBody || rawBody.length === 0) {
      this.logger.warn('Webhook request missing raw body');
      await this.audit('stripe.webhook.rejected.missing_body', {
        ip: sourceIp,
        severity: AuditSeverity.WARNING,
        metadata: { reason: 'missing-raw-body' },
      });
      res.status(400).json({ error: 'Missing request body' });
      return;
    }

    // 2. Verify signature
    const signatureHeader = req.headers['stripe-signature'] as string | undefined;
    if (!signatureHeader) {
      this.logger.warn('Webhook request missing stripe-signature header');
      await this.audit('stripe.webhook.rejected.missing_signature', {
        ip: sourceIp,
        severity: AuditSeverity.WARNING,
        metadata: { reason: 'missing-stripe-signature-header' },
      });
      res.status(400).json({ error: 'Missing stripe-signature header' });
      return;
    }

    if (!this.webhookSecret) {
      this.logger.error('STRIPE_WEBHOOK_SECRET not configured, rejecting webhook');
      await this.audit('stripe.webhook.rejected.secret_missing', {
        ip: sourceIp,
        severity: AuditSeverity.CRITICAL,
        metadata: { reason: 'STRIPE_WEBHOOK_SECRET-env-missing' },
      });
      res.status(500).json({ error: 'Webhook secret not configured' });
      return;
    }

    const verificationResult = this.verifySignature(rawBody, signatureHeader, this.webhookSecret);
    if (!verificationResult.valid) {
      // BILLING-HIGH-004 closure (paired with this audit row): signature
      // failure is a security-relevant event — rate-spike on this audit
      // row triggers the SecurityAlertRaised alert path (W1.4).
      this.logger.warn(`Webhook signature verification failed: ${verificationResult.reason}`);
      await this.audit('stripe.webhook.rejected.invalid_signature', {
        ip: sourceIp,
        severity: AuditSeverity.CRITICAL,
        metadata: { reason: verificationResult.reason ?? 'unknown' },
      });
      res.status(400).json({ error: 'Invalid signature' });
      return;
    }

    // 3. Parse event
    let event: Record<string, any>;
    try {
      event = JSON.parse(rawBody.toString('utf8'));
    } catch {
      this.logger.warn('Failed to parse webhook payload as JSON');
      await this.audit('stripe.webhook.rejected.parse_failure', {
        ip: sourceIp,
        severity: AuditSeverity.WARNING,
        metadata: { reason: 'invalid-json-payload' },
      });
      res.status(400).json({ error: 'Invalid JSON payload' });
      return;
    }

    const eventId: string | undefined = event['id'];
    const eventType: string | undefined = event['type'];

    if (!eventId || !eventType) {
      this.logger.warn('Webhook payload missing id or type');
      await this.audit('stripe.webhook.rejected.missing_event_fields', {
        ip: sourceIp,
        severity: AuditSeverity.WARNING,
        metadata: {
          reason: 'event-missing-id-or-type',
          hasId: !!eventId,
          hasType: !!eventType,
        },
      });
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
        await this.audit('stripe.webhook.duplicate', {
          resourceId: eventId,
          ip: sourceIp,
          severity: AuditSeverity.INFO,
          metadata: { eventType, reason: 'redis-dedup-hit' },
        });
        res.status(200).json({ received: true, duplicate: true });
        return;
      }
    }

    // 5. Route to handler
    this.logger.log(`Processing webhook event: ${eventType} (${eventId})`);
    // Pre-handler audit row — captures every webhook the platform agreed
    // to process. The post-handler row records success/failure outcome
    // so a triage operator can pair them and see the lifecycle.
    await this.audit('stripe.webhook.received', {
      resourceId: eventId,
      ip: sourceIp,
      severity: AuditSeverity.INFO,
      metadata: { eventType, supported: this.isSupportedEvent(eventType) },
    });

    if (this.isSupportedEvent(eventType)) {
      try {
        await this.routeEvent(eventType, event);
        await this.audit('stripe.webhook.processed', {
          resourceId: eventId,
          ip: sourceIp,
          severity: AuditSeverity.INFO,
          metadata: { eventType, outcome: 'success' },
        });
      } catch (err) {
        // CRITICAL: Always return 200 to Stripe. Log the error for investigation.
        // Returning non-200 causes Stripe to retry, which can amplify failures.
        const errorMessage = err instanceof Error ? err.message : 'Unknown error';
        this.logger.error(
          `Error processing webhook event ${eventType} (${eventId}): ${errorMessage}`,
          err instanceof Error ? err.stack : undefined,
        );
        await this.audit('stripe.webhook.handler_error', {
          resourceId: eventId,
          ip: sourceIp,
          severity: AuditSeverity.CRITICAL,
          metadata: {
            eventType,
            outcome: 'handler-error',
            errorMessage: errorMessage.substring(0, 500),
          },
        });
      }
    } else {
      this.logger.log(`Ignoring unsupported event type: ${eventType}`);
      await this.audit('stripe.webhook.unsupported_event', {
        resourceId: eventId,
        ip: sourceIp,
        severity: AuditSeverity.INFO,
        metadata: { eventType, reason: 'event-type-not-in-SUPPORTED_EVENTS' },
      });
    }

    // 6. Always acknowledge
    res.status(200).json({ received: true });
  }

  /**
   * Audit-row helper — wraps recordAwait with the resource constant
   * ('stripe-webhook') and a defensive try/catch so an audit-log
   * outage cannot block webhook acknowledgement (which would force
   * Stripe to retry and storm the system). The catch is justified
   * here because the controller MUST always return 200; the alternative
   * would be a silent retry storm.
   */
  private async audit(
    action: string,
    args: {
      resourceId?: string;
      ip: string;
      severity: AuditSeverity;
      metadata: Record<string, unknown>;
    },
  ): Promise<void> {
    if (!this.auditLog) return;
    try {
      await this.auditLog.recordAwait({
        action,
        resource: 'stripe-webhook',
        resourceId: args.resourceId,
        severity: args.severity,
        ip: args.ip,
        metadata: args.metadata,
      });
    } catch (err) {
      // Audit-log outage MUST NOT block the webhook ack — Stripe's retry
      // storm would amplify the failure. We log loud and move on.
      this.logger.error(
        `Failed to write Stripe webhook audit row (${action}): ${
          err instanceof Error ? err.message : 'unknown'
        }`,
      );
    }
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
