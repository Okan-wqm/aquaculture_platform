import { Module } from '@nestjs/common';
import { CqrsModule } from '@nestjs/cqrs';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ScheduleModule } from '@nestjs/schedule';
import { BillingResolver } from './billing.resolver';
import { BillingSchedulerService } from './billing-scheduler.service';

// Entities
import { Subscription } from './entities/subscription.entity';
import { Invoice } from './entities/invoice.entity';
import { Payment } from './entities/payment.entity';
import { SubscriptionModuleItem } from './entities/subscription-module-item.entity';
import { TenantUsageMetrics } from './entities/tenant-usage-metrics.entity';

// Command Handlers
import { CreateSubscriptionHandler } from './handlers/create-subscription.handler';
import { CancelSubscriptionHandler } from './handlers/cancel-subscription.handler';
import { CreateInvoiceHandler } from './handlers/create-invoice.handler';
import { FinalizeInvoiceHandler } from './handlers/finalize-invoice.handler';
import { VoidInvoiceHandler } from './handlers/void-invoice.handler';
import { RecordPaymentHandler } from './handlers/record-payment.handler';

// Query Handlers
import { GetSubscriptionHandler } from './query-handlers/get-subscription.handler';
import { GetInvoicesHandler } from './query-handlers/get-invoices.handler';
import { GetPaymentsHandler } from './query-handlers/get-payments.handler';

// Event Handlers
import { TenantSubscriptionRequestedHandler } from './event-handlers/tenant-subscription-requested.handler';

const CommandHandlers = [
  CreateSubscriptionHandler,
  CancelSubscriptionHandler,
  CreateInvoiceHandler,
  FinalizeInvoiceHandler,
  VoidInvoiceHandler,
  RecordPaymentHandler,
];

const QueryHandlers = [
  GetSubscriptionHandler,
  GetInvoicesHandler,
  GetPaymentsHandler,
];

const EventHandlers = [
  TenantSubscriptionRequestedHandler,
];

@Module({
  imports: [
    TypeOrmModule.forFeature([Subscription, Invoice, Payment, SubscriptionModuleItem, TenantUsageMetrics]),
    CqrsModule,
    ScheduleModule.forRoot(),
  ],
  providers: [
    BillingResolver,
    BillingSchedulerService,
    ...CommandHandlers,
    ...QueryHandlers,
    ...EventHandlers,
  ],
  exports: [TypeOrmModule],
})
export class BillingModule {}
