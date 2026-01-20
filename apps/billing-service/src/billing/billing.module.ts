import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CqrsModule } from '@nestjs/cqrs';
import { Subscription } from './entities/subscription.entity';
import { Invoice } from './entities/invoice.entity';
import { Payment } from './entities/payment.entity';
import { BillingResolver } from './billing.resolver';

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
    TypeOrmModule.forFeature([Subscription, Invoice, Payment]),
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
