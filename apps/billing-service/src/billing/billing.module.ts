import { AuditLogService } from '@aquaculture/backend-common/audit';
import {
  StripeApiModule,
  STRIPE_API_CLIENT,
  STRIPE_AUDIT_RECORDER,
  stripeClientFactory,
} from '@aquaculture/backend-common/billing';
import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CqrsModule } from '@nestjs/cqrs';
import { ScheduleModule } from '@nestjs/schedule';
import { TypeOrmModule } from '@nestjs/typeorm';

import { BillingDecimalResolvers } from './billing-decimal.resolver';
import { BillingSchedulerService } from './billing-scheduler.service';
import { BillingResolver } from './billing.resolver';
import { StripeWebhookController } from './controllers/stripe-webhook.controller';
import { StripeWebhookService } from './controllers/stripe-webhook.service';
import { Invoice } from './entities/invoice.entity';
import { Payment } from './entities/payment.entity';
import { Plan } from './entities/plan.entity';
import { ScheduledPlanChange } from './entities/scheduled-plan-change.entity';
import { StripeWebhookEventEntity } from './entities/stripe-webhook-event.entity';
import { SubscriptionModuleItem } from './entities/subscription-module-item.entity';
import { Subscription } from './entities/subscription.entity';
import { TenantUsageMetrics } from './entities/tenant-usage-metrics.entity';
import { BillingAdminNatsHandler } from './handlers/billing-admin-nats.handler';
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
    TypeOrmModule.forFeature([Subscription, Invoice, Payment, SubscriptionModuleItem, TenantUsageMetrics, Plan, ScheduledPlanChange, StripeWebhookEventEntity]),
    CqrsModule,
    ScheduleModule,
    // W1.1 (ADR-016 / BILLING-CRITICAL-001): bind the canonical Stripe client so
    // money handlers get a REAL outbound StripeApiService when billing is on.
    // The factory is gated by the STRIPE_BILLING_ENABLED SSoT flag (default
    // off) and reconciles graceful-boot with fail-closed: disabled (any env,
    // incl. production) → boots with a fail-closed-at-request sentinel client;
    // enabled + STRIPE_SECRET_KEY → the real adapter; enabled + no key → throws
    // at boot. NODE_ENV no longer gates boot. Audit rows are written via the
    // @Global AuditLogService (IAuditRecorder-compatible).
    StripeApiModule.forRoot({
      clientProvider: {
        provide: STRIPE_API_CLIENT,
        useFactory: stripeClientFactory,
        inject: [ConfigService],
      },
      auditProvider: { provide: STRIPE_AUDIT_RECORDER, useExisting: AuditLogService },
    }),
  ],
  // BillingAdminNatsHandler must be a controller so Nest microservice
  // transport registers its @MessagePattern subscribers.
  controllers: [StripeWebhookController, BillingAdminNatsHandler],
  providers: [
    BillingResolver,
    ...BillingDecimalResolvers,
    BillingSchedulerService,
    StripeWebhookService,
    PlanSeedService,
    ...CommandHandlers,
    ...QueryHandlers,
    ...EventHandlers,
  ],
  exports: [TypeOrmModule],
})
export class BillingModule {}
