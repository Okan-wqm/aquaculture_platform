import { AuditLogService } from '@aquaculture/backend-common/audit';
import {
  StripeApiModule,
  STRIPE_API_CLIENT,
  STRIPE_AUDIT_RECORDER,
  DynamicStripeClient,
  DynamicStripeClientProvider,
} from '@aquaculture/backend-common/billing';
import { ConfigClientModule } from '@aquaculture/backend-common/config-client';
import { SecurityEventService } from '@aquaculture/backend-common/security';
import { Module } from '@nestjs/common';
import { CqrsModule } from '@nestjs/cqrs';
import { ScheduleModule } from '@nestjs/schedule';
import { TypeOrmModule } from '@nestjs/typeorm';

import { BillingDecimalResolvers } from './billing-decimal.resolver';
import { BillingSchedulerService } from './billing-scheduler.service';
import { BillingResolver } from './billing.resolver';
import { StripeWebhookController } from './controllers/stripe-webhook.controller';
import { StripeWebhookService } from './controllers/stripe-webhook.service';
import { DiscountCode, DiscountRedemption } from './entities/discount-code.entity';
import { Invoice } from './entities/invoice.entity';
import { Payment } from './entities/payment.entity';
import { Plan } from './entities/plan.entity';
import { ScheduledPlanChange } from './entities/scheduled-plan-change.entity';
import { StripeWebhookEventEntity } from './entities/stripe-webhook-event.entity';
import { SubscriptionModuleItem } from './entities/subscription-module-item.entity';
import { Subscription } from './entities/subscription.entity';
import { ConfigurationChangedHandler } from './event-handlers/configuration-changed.handler';
import { BillingAdminNatsHandler } from './handlers/billing-admin-nats.handler';
import { BillingDiscountNatsHandler } from './handlers/billing-discount-nats.handler';
import { CancelSubscriptionHandler } from './handlers/cancel-subscription.handler';
import { ChangeSubscriptionPlanHandler } from './handlers/change-subscription-plan.handler';
import { CreateInvoiceHandler } from './handlers/create-invoice.handler';
import { CreatePlanHandler } from './handlers/create-plan.handler';
import { CreateSubscriptionHandler } from './handlers/create-subscription.handler';
import { DeactivatePlanHandler } from './handlers/deactivate-plan.handler';
import { FinalizeInvoiceHandler } from './handlers/finalize-invoice.handler';
import { RecordPaymentHandler } from './handlers/record-payment.handler';
import { RefundPaymentHandler } from './handlers/refund-payment.handler';
import { UpdatePlanHandler } from './handlers/update-plan.handler';
import { VoidInvoiceHandler } from './handlers/void-invoice.handler';
import { GetInvoicesHandler } from './query-handlers/get-invoices.handler';
import { GetPaymentsHandler } from './query-handlers/get-payments.handler';
import { GetPlanByIdHandler } from './query-handlers/get-plan-by-id.handler';
import { GetPlansHandler } from './query-handlers/get-plans.handler';
import { GetSubscriptionHandler } from './query-handlers/get-subscription.handler';
import { GetTenantBillingHandler } from './query-handlers/get-tenant-billing.handler';
import { PlanSeedService } from './seed/plan-seed.service';
import { DiscountCodeService } from './services/discount-code.service';
import { MeteringModule } from '../modules/metering/metering.module';

const CommandHandlers = [
  CreateSubscriptionHandler,
  CancelSubscriptionHandler,
  CreateInvoiceHandler,
  FinalizeInvoiceHandler,
  VoidInvoiceHandler,
  RecordPaymentHandler,
  RefundPaymentHandler,
  CreatePlanHandler,
  UpdatePlanHandler,
  DeactivatePlanHandler,
  ChangeSubscriptionPlanHandler,
];

const QueryHandlers = [
  GetSubscriptionHandler,
  GetInvoicesHandler,
  GetPaymentsHandler,
  GetPlansHandler,
  GetPlanByIdHandler,
  GetTenantBillingHandler,
];

const EventHandlers: never[] = [];

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Subscription,
      Invoice,
      Payment,
      SubscriptionModuleItem,
      Plan,
      ScheduledPlanChange,
      StripeWebhookEventEntity,
      DiscountCode,
      DiscountRedemption,
    ]),
    CqrsModule,
    ScheduleModule,
    // A6 / DB-IDENT-MEDIUM-002: GetTenantBillingHandler reads tenant usage
    // from the metering SSoT (usage_aggregations via UsageAggregatorService)
    // and included quantities from MeteredBillingService's pricing model —
    // the retired billing.tenant_usage_metrics parallel model is gone.
    MeteringModule,
    // Faz C (D6, ADR-016 / BILLING-CRITICAL-001): bind the canonical Stripe
    // client behind the DynamicStripeClient delegator so operator-entered keys
    // (config-service `platform/billing.*`) take effect at runtime WITHOUT a
    // redeploy and WITHOUT the enabled-but-keyless boot crash (2026-06 Suderra
    // outage). Precedence: config-enabled+secret → Real; config-enabled+no-secret
    // → fail-closed-at-request (boots); config-disabled/unreachable → env fallback
    // (mock on the droplet). The DynamicStripeClientProvider owns the TTL snapshot
    // + secret-in-memory; ConfigClientModule provides the trusted ConfigRuntimeClient.
    StripeApiModule.forRoot({
      imports: [ConfigClientModule.forRoot({ consumerService: 'billing-service' })],
      providers: [DynamicStripeClientProvider, SecurityEventService],
      clientProvider: {
        provide: STRIPE_API_CLIENT,
        useFactory: (provider: DynamicStripeClientProvider): DynamicStripeClient =>
          new DynamicStripeClient(provider),
        inject: [DynamicStripeClientProvider],
      },
      auditProvider: { provide: STRIPE_AUDIT_RECORDER, useExisting: AuditLogService },
      // Export the provider so the ConfigurationChanged handler (billing.module
      // providers) can inject it to invalidate the snapshot on a key change.
      exports: [DynamicStripeClientProvider],
    }),
  ],
  // BillingAdminNatsHandler must be a controller so Nest microservice
  // transport registers its @MessagePattern subscribers.
  controllers: [StripeWebhookController, BillingAdminNatsHandler, BillingDiscountNatsHandler],
  providers: [
    BillingResolver,
    ...BillingDecimalResolvers,
    BillingSchedulerService,
    StripeWebhookService,
    PlanSeedService,
    DiscountCodeService,
    // Faz C: invalidates the DynamicStripeClientProvider snapshot when an
    // operator saves a platform/billing.* config row (subscribes in onModuleInit).
    ConfigurationChangedHandler,
    ...CommandHandlers,
    ...QueryHandlers,
    ...EventHandlers,
  ],
  exports: [TypeOrmModule],
})
export class BillingModule {}
