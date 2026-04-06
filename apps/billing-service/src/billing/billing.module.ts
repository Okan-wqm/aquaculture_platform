import { Module } from '@nestjs/common';
import { CqrsModule } from '@nestjs/cqrs';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ScheduleModule } from '@nestjs/schedule';
import { BillingResolver } from './billing.resolver';
import { BillingSchedulerService } from './billing-scheduler.service';

// Controllers
import { StripeWebhookController } from './controllers/stripe-webhook.controller';

// Services
import { StripeWebhookService } from './controllers/stripe-webhook.service';

// Entities
import { Subscription } from './entities/subscription.entity';
import { Invoice } from './entities/invoice.entity';
import { Payment } from './entities/payment.entity';
import { SubscriptionModuleItem } from './entities/subscription-module-item.entity';
import { TenantUsageMetrics } from './entities/tenant-usage-metrics.entity';
import { Plan } from './entities/plan.entity';
import { ScheduledPlanChange } from './entities/scheduled-plan-change.entity';

// Command Handlers
import { CreateSubscriptionHandler } from './handlers/create-subscription.handler';
import { CancelSubscriptionHandler } from './handlers/cancel-subscription.handler';
import { CreateInvoiceHandler } from './handlers/create-invoice.handler';
import { FinalizeInvoiceHandler } from './handlers/finalize-invoice.handler';
import { VoidInvoiceHandler } from './handlers/void-invoice.handler';
import { RecordPaymentHandler } from './handlers/record-payment.handler';
import { RefundPaymentHandler } from './handlers/refund-payment.handler';
import { CreatePlanHandler } from './handlers/create-plan.handler';
import { UpdatePlanHandler } from './handlers/update-plan.handler';
import { DeactivatePlanHandler } from './handlers/deactivate-plan.handler';
import { ChangeSubscriptionPlanHandler } from './handlers/change-subscription-plan.handler';

// Query Handlers
import { GetSubscriptionHandler } from './query-handlers/get-subscription.handler';
import { GetInvoicesHandler } from './query-handlers/get-invoices.handler';
import { GetPaymentsHandler } from './query-handlers/get-payments.handler';
import { GetPlansHandler } from './query-handlers/get-plans.handler';
import { GetPlanByIdHandler } from './query-handlers/get-plan-by-id.handler';
import { GetTenantBillingHandler } from './query-handlers/get-tenant-billing.handler';

// Event Handlers
import { TenantSubscriptionRequestedHandler } from './event-handlers/tenant-subscription-requested.handler';

// Seed
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
    TypeOrmModule.forFeature([Subscription, Invoice, Payment, SubscriptionModuleItem, TenantUsageMetrics, Plan, ScheduledPlanChange]),
    CqrsModule,
    ScheduleModule,
  ],
  controllers: [StripeWebhookController],
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
export class BillingModule {}
