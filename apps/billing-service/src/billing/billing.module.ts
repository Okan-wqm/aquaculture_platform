import { Module } from '@nestjs/common';
import { CqrsModule } from '@nestjs/cqrs';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BillingResolver } from './billing.resolver';

// Entities
import { Subscription } from './entities/subscription.entity';
import { Invoice } from './entities/invoice.entity';
import { Payment } from './entities/payment.entity';
import { SubscriptionModuleItem } from './entities/subscription-module-item.entity';

// Command Handlers
import { CreateSubscriptionHandler } from './handlers/create-subscription.handler';
import { CancelSubscriptionHandler } from './handlers/cancel-subscription.handler';
import { CreateInvoiceHandler } from './handlers/create-invoice.handler';
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
    TypeOrmModule.forFeature([Subscription, Invoice, Payment, SubscriptionModuleItem]),
    CqrsModule,
  ],
  providers: [
    BillingResolver,
    ...CommandHandlers,
    ...QueryHandlers,
    ...EventHandlers,
  ],
  exports: [TypeOrmModule],
})
export class BillingModule {}
