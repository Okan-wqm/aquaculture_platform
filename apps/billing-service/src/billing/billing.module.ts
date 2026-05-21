import { Module } from '@nestjs/common';
import { CqrsModule } from '@nestjs/cqrs';
import { ScheduleModule } from '@nestjs/schedule';
import { TypeOrmModule } from '@nestjs/typeorm';

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
import { TenantSubscriptionRequestedHandler } from './event-handlers/tenant-subscription-requested.handler';
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

const EventHandlers = [
  TenantSubscriptionRequestedHandler,
];

@Module({
  imports: [
    TypeOrmModule.forFeature([Subscription, Invoice, Payment, SubscriptionModuleItem, TenantUsageMetrics, Plan, ScheduledPlanChange, StripeWebhookEventEntity]),
    CqrsModule,
    ScheduleModule,
  ],
  // BillingAdminNatsHandler must be a controller so Nest microservice
  // transport registers its @MessagePattern subscribers.
  controllers: [StripeWebhookController, BillingAdminNatsHandler],
  providers: [
    BillingResolver,
    BillingSchedulerService,
    StripeWebhookService,
    PlanSeedService,
    ...CommandHandlers,
    ...QueryHandlers,
    ...EventHandlers,
  ],
  exports: [TypeOrmModule],
})
// eslint-disable-next-line @typescript-eslint/no-extraneous-class
export class BillingModule {}
