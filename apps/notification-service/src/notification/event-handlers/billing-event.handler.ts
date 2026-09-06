import { Injectable, Logger, OnModuleInit, Inject } from '@nestjs/common';
import { IEventBus, IEventHandler, HandlerOutcome, outcomeForError } from '@platform/event-bus';
import type {
  InvoiceOverdueEvent,
  PaymentFailedEvent,
  SubscriptionCreatedEvent,
} from '@platform/event-contracts';
import { EmailService } from '../services/email.service';

// UUID v4 regex for tenant ID validation
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type BillingNotificationEvent = InvoiceOverdueEvent | PaymentFailedEvent | SubscriptionCreatedEvent;

/**
 * Billing Event Handler
 * Listens to billing-related events and dispatches email notifications.
 *
 * Subscribed events:
 * - InvoiceOverdue: Notify tenant about overdue invoice
 * - PaymentFailed: Notify tenant about failed payment
 * - SubscriptionCreated: Send welcome/confirmation email
 */
@Injectable()
export class BillingEventHandler implements IEventHandler<BillingNotificationEvent>, OnModuleInit {
  private readonly logger = new Logger(BillingEventHandler.name);

  constructor(
    private readonly emailService: EmailService,
    @Inject('EVENT_BUS')
    private readonly eventBus: IEventBus,
  ) {}

  async onModuleInit(): Promise<void> {
    // WHAT — `subscribeWildcard` builds `events.*.{eventType}` for each
    // billing event, matching the publisher's `events.{tenantId}.{eventType}`
    // for every tenant.
    // WHY explicit wildcard — notification dispatch is cross-tenant by design
    // (one notification-service instance handles every tenant's billing
    // notifications). The explicit helper makes the cross-tenant intent
    // unambiguous and pins the publisher↔subscriber subject contract.
    await this.eventBus.subscribeWildcard('InvoiceOverdue', this);
    await this.eventBus.subscribeWildcard('PaymentFailed', this);
    await this.eventBus.subscribeWildcard('SubscriptionCreated', this);
    this.logger.log(
      'Subscribed to InvoiceOverdue, PaymentFailed, and SubscriptionCreated events (cross-tenant wildcard)',
    );
  }

  getEventType(): string {
    return 'BillingEvent';
  }

  async handle(event: BillingNotificationEvent): Promise<HandlerOutcome> {
    // SECURITY: Validate tenantId format to ensure data isolation
    if (!event.tenantId || !UUID_REGEX.test(event.tenantId)) {
      this.logger.error(
        `Billing event has invalid or missing tenantId. ` +
          'Skipping to prevent cross-tenant notification leakage.',
      );
      return HandlerOutcome.terminate('Billing event: missing or invalid tenantId');
    }

    const eventType = event.eventType;
    this.logger.log(`Processing ${eventType} for tenant ${event.tenantId.substring(0, 8)}...`);

    try {
      switch (eventType) {
        case 'InvoiceOverdue':
          await this.handleInvoiceOverdue(event as InvoiceOverdueEvent);
          break;
        case 'PaymentFailed':
          await this.handlePaymentFailed(event as PaymentFailedEvent);
          break;
        case 'SubscriptionCreated':
          await this.handleSubscriptionCreated(event as SubscriptionCreatedEvent);
          break;
        default:
          this.logger.warn(`Unknown billing event type: ${eventType}`);
          return HandlerOutcome.terminate(`Unknown billing event type: ${eventType}`);
      }
      return HandlerOutcome.ack();
    } catch (error) {
      this.logger.error(
        `Error processing ${eventType} event: ${(error as Error).message}`,
        (error as Error).stack,
      );
      return outcomeForError(`${eventType} billing notification`, error);
    }
  }

  /**
   * Handle InvoiceOverdue — notify tenant billing contact
   */
  private async handleInvoiceOverdue(event: InvoiceOverdueEvent): Promise<void> {
    // InvoiceOverdueEvent does not carry an email — log only in this
    // handler. In production, the handler would look up the tenant's
    // billing email from a local cache or via a query to admin-api;
    // that wiring is tracked under the notification-service backlog
    // (no finding ID yet — separate from this PR).
    this.logger.warn(
      `InvoiceOverdue: invoice ${event.invoiceNumber} for tenant ${event.tenantId.substring(0, 8)}... ` +
        `is ${event.daysOverdue} days overdue (${event.currency} ${event.amount}). ` +
        `Email dispatch requires billing contact lookup — skipping until tenant registry is available.`,
    );
  }

  /**
   * Handle PaymentFailed — notify tenant about failed payment
   */
  private async handlePaymentFailed(event: PaymentFailedEvent): Promise<void> {
    this.logger.warn(
      `PaymentFailed: payment ${event.paymentId} for tenant ${event.tenantId.substring(0, 8)}... ` +
        `failed (${event.failureReason}). Retry ${event.retryCount}, will retry: ${event.willRetry}. ` +
        `Email dispatch requires billing contact lookup — skipping until tenant registry is available.`,
    );
  }

  /**
   * Handle SubscriptionCreated — send confirmation
   */
  private async handleSubscriptionCreated(event: SubscriptionCreatedEvent): Promise<void> {
    this.logger.log(
      `SubscriptionCreated: subscription ${event.subscriptionId} for tenant ${event.tenantId.substring(0, 8)}... ` +
        `tier=${event.tier}, price=${event.currency} ${event.monthlyPrice}/mo. ` +
        `Email dispatch requires billing contact lookup — skipping until tenant registry is available.`,
    );
  }
}
