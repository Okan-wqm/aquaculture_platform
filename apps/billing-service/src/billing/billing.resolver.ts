import { Resolver, Query, Mutation, Args, ID, Context } from '@nestjs/graphql';
import { UnauthorizedException } from '@nestjs/common';
import { CommandBus, QueryBus } from '@nestjs/cqrs';
import { Subscription } from './entities/subscription.entity';
import { Invoice, InvoiceStatus } from './entities/invoice.entity';
import { Payment, PaymentStatus } from './entities/payment.entity';
import { CreateSubscriptionInput } from './dto/create-subscription.input';
import { CreateInvoiceInput } from './dto/create-invoice.input';
import { RecordPaymentInput } from './dto/record-payment.input';
import { CreateSubscriptionCommand } from './commands/create-subscription.command';
import { CancelSubscriptionCommand } from './commands/cancel-subscription.command';
import { CreateInvoiceCommand } from './commands/create-invoice.command';
import { RecordPaymentCommand } from './commands/record-payment.command';
import { GetSubscriptionQuery } from './queries/get-subscription.query';
import { GetInvoicesQuery, InvoiceFilterInput } from './queries/get-invoices.query';
import { GetPaymentsQuery, PaymentFilterInput } from './queries/get-payments.query';

interface GraphQLContext {
  req: {
    headers: {
      'x-tenant-id'?: string;
      'x-user-id'?: string;
    };
    user?: {
      sub: string;
      tenantId: string;
    };
  };
}

// Helper functions outside of class to avoid GraphQL resolver detection
function extractTenantId(context: GraphQLContext): string {
  const tenantId =
    context.req.user?.tenantId ||
    context.req.headers['x-tenant-id'];
  if (!tenantId) {
    throw new UnauthorizedException('Tenant ID is required');
  }
  return tenantId;
}

function extractUserId(context: GraphQLContext): string {
  const userId =
    context.req.user?.sub ||
    context.req.headers['x-user-id'] ||
    'system';
  return userId;
}

@Resolver(() => Subscription)
export class BillingResolver {
  constructor(
    private readonly commandBus: CommandBus,
    private readonly queryBus: QueryBus,
  ) {}

  // Subscription Queries
  @Query(() => Subscription, { name: 'subscription', nullable: true })
  async getSubscription(
    @Context() context: GraphQLContext,
  ): Promise<Subscription | null> {
    const tenantId = extractTenantId(context);
    return this.queryBus.execute(new GetSubscriptionQuery(tenantId));
  }

  // Subscription Mutations
  @Mutation(() => Subscription)
  async createSubscription(
    @Args('input') input: CreateSubscriptionInput,
    @Context() context: GraphQLContext,
  ): Promise<Subscription> {
    const tenantId = extractTenantId(context);
    const userId = extractUserId(context);
    return this.commandBus.execute(
      new CreateSubscriptionCommand(tenantId, input, userId),
    );
  }

  @Mutation(() => Subscription)
  async cancelSubscription(
    @Args('id', { type: () => ID }) id: string,
    @Args('reason') reason: string,
    @Context() context: GraphQLContext,
  ): Promise<Subscription> {
    const tenantId = extractTenantId(context);
    const userId = extractUserId(context);
    return this.commandBus.execute(
      new CancelSubscriptionCommand(tenantId, id, reason, userId),
    );
  }

  // Invoice Queries
  @Query(() => [Invoice], { name: 'invoices' })
  async getInvoices(
    @Args('status', { type: () => InvoiceStatus, nullable: true }) status: InvoiceStatus,
    @Context() context: GraphQLContext,
  ): Promise<Invoice[]> {
    const tenantId = extractTenantId(context);
    const filter: InvoiceFilterInput = {};
    if (status) filter.status = status;
    return this.queryBus.execute(new GetInvoicesQuery(tenantId, filter));
  }

  @Query(() => [Invoice], { name: 'overdueInvoices' })
  async getOverdueInvoices(
    @Context() context: GraphQLContext,
  ): Promise<Invoice[]> {
    const tenantId = extractTenantId(context);
    return this.queryBus.execute(
      new GetInvoicesQuery(tenantId, { status: InvoiceStatus.OVERDUE }),
    );
  }

  @Query(() => [Invoice], { name: 'unpaidInvoices' })
  async getUnpaidInvoices(
    @Context() context: GraphQLContext,
  ): Promise<Invoice[]> {
    const tenantId = extractTenantId(context);
    // Get both pending and overdue invoices
    const pendingInvoices = await this.queryBus.execute(
      new GetInvoicesQuery(tenantId, { status: InvoiceStatus.PENDING }),
    );
    const overdueInvoices = await this.queryBus.execute(
      new GetInvoicesQuery(tenantId, { status: InvoiceStatus.OVERDUE }),
    );
    return [...pendingInvoices, ...overdueInvoices];
  }

  // Invoice Mutations
  @Mutation(() => Invoice)
  async createInvoice(
    @Args('input') input: CreateInvoiceInput,
    @Context() context: GraphQLContext,
  ): Promise<Invoice> {
    const tenantId = extractTenantId(context);
    const userId = extractUserId(context);
    return this.commandBus.execute(
      new CreateInvoiceCommand(tenantId, input, userId),
    );
  }

  // Payment Queries
  @Query(() => [Payment], { name: 'payments' })
  async getPayments(
    @Args('invoiceId', { type: () => ID, nullable: true }) invoiceId: string,
    @Args('status', { type: () => PaymentStatus, nullable: true }) status: PaymentStatus,
    @Context() context: GraphQLContext,
  ): Promise<Payment[]> {
    const tenantId = extractTenantId(context);
    const filter: PaymentFilterInput = {};
    if (invoiceId) filter.invoiceId = invoiceId;
    if (status) filter.status = status;
    return this.queryBus.execute(new GetPaymentsQuery(tenantId, filter));
  }

  // Payment Mutations
  @Mutation(() => Payment)
  async recordPayment(
    @Args('input') input: RecordPaymentInput,
    @Context() context: GraphQLContext,
  ): Promise<Payment> {
    const tenantId = extractTenantId(context);
    const userId = extractUserId(context);
    return this.commandBus.execute(
      new RecordPaymentCommand(tenantId, input, userId),
    );
  }
}
