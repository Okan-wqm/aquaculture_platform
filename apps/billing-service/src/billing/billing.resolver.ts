import { Resolver, Query, Mutation, Args, ID, Context } from '@nestjs/graphql';
import { UnauthorizedException, ForbiddenException } from '@nestjs/common';
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

/**
 * SECURITY: Role-based authorization for billing operations
 * Defines which roles can perform various billing actions
 */
enum BillingRole {
  SUPER_ADMIN = 'super_admin',
  TENANT_ADMIN = 'tenant_admin',
  BILLING_ADMIN = 'billing_admin',
  FINANCE_MANAGER = 'finance_manager',
}

/** Roles allowed to create/modify subscriptions */
const SUBSCRIPTION_WRITE_ROLES: string[] = [
  BillingRole.SUPER_ADMIN,
  BillingRole.TENANT_ADMIN,
  BillingRole.BILLING_ADMIN,
];

/** Roles allowed to create invoices */
const INVOICE_WRITE_ROLES: string[] = [
  BillingRole.SUPER_ADMIN,
  BillingRole.BILLING_ADMIN,
  BillingRole.FINANCE_MANAGER,
];

/** Roles allowed to record payments */
const PAYMENT_WRITE_ROLES: string[] = [
  BillingRole.SUPER_ADMIN,
  BillingRole.BILLING_ADMIN,
  BillingRole.FINANCE_MANAGER,
];

/** Roles allowed to read billing data */
const BILLING_READ_ROLES: string[] = [
  BillingRole.SUPER_ADMIN,
  BillingRole.TENANT_ADMIN,
  BillingRole.BILLING_ADMIN,
  BillingRole.FINANCE_MANAGER,
];

interface GraphQLContext {
  req: {
    headers: {
      'x-tenant-id'?: string;
      'x-user-id'?: string;
    };
    user?: {
      sub: string;
      tenantId: string;
      roles?: string[];
    };
  };
}

// UUID v4 regex for tenant ID validation
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// Helper functions outside of class to avoid GraphQL resolver detection
function extractTenantId(context: GraphQLContext): string {
  const tenantId =
    context.req.user?.tenantId ||
    context.req.headers['x-tenant-id'];

  if (!tenantId || typeof tenantId !== 'string') {
    throw new UnauthorizedException('Tenant ID is required');
  }

  const trimmedTenantId = tenantId.trim();
  if (trimmedTenantId.length === 0) {
    throw new UnauthorizedException('Tenant ID cannot be empty');
  }

  // Validate UUID format to prevent SQL injection and ensure proper tenant isolation
  if (!UUID_REGEX.test(trimmedTenantId)) {
    throw new UnauthorizedException('Invalid tenant ID format');
  }

  return trimmedTenantId;
}

function extractUserId(context: GraphQLContext): string {
  const userId =
    context.req.user?.sub ||
    context.req.headers['x-user-id'] ||
    'system';
  return userId;
}

/**
 * SECURITY: Validates that the user has at least one of the required roles
 * @throws ForbiddenException if user lacks required roles
 */
function requireRoles(context: GraphQLContext, allowedRoles: string[], operation: string): void {
  const userRoles = context.req.user?.roles || [];

  // Super admin bypass
  if (userRoles.includes(BillingRole.SUPER_ADMIN)) {
    return;
  }

  const hasRole = allowedRoles.some((role) => userRoles.includes(role));
  if (!hasRole) {
    throw new ForbiddenException(
      `Access denied: ${operation} requires one of these roles: ${allowedRoles.join(', ')}`,
    );
  }
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
    requireRoles(context, BILLING_READ_ROLES, 'view subscription');
    return this.queryBus.execute(new GetSubscriptionQuery(tenantId));
  }

  // Subscription Mutations
  @Mutation(() => Subscription)
  async createSubscription(
    @Args('input') input: CreateSubscriptionInput,
    @Context() context: GraphQLContext,
  ): Promise<Subscription> {
    const tenantId = extractTenantId(context);
    requireRoles(context, SUBSCRIPTION_WRITE_ROLES, 'create subscription');
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
    requireRoles(context, SUBSCRIPTION_WRITE_ROLES, 'cancel subscription');
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
    requireRoles(context, BILLING_READ_ROLES, 'view invoices');
    const filter: InvoiceFilterInput = {};
    if (status) filter.status = status;
    return this.queryBus.execute(new GetInvoicesQuery(tenantId, filter));
  }

  @Query(() => [Invoice], { name: 'overdueInvoices' })
  async getOverdueInvoices(
    @Context() context: GraphQLContext,
  ): Promise<Invoice[]> {
    const tenantId = extractTenantId(context);
    requireRoles(context, BILLING_READ_ROLES, 'view overdue invoices');
    return this.queryBus.execute(
      new GetInvoicesQuery(tenantId, { status: InvoiceStatus.OVERDUE }),
    );
  }

  @Query(() => [Invoice], { name: 'unpaidInvoices' })
  async getUnpaidInvoices(
    @Context() context: GraphQLContext,
  ): Promise<Invoice[]> {
    const tenantId = extractTenantId(context);
    requireRoles(context, BILLING_READ_ROLES, 'view unpaid invoices');
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
    requireRoles(context, INVOICE_WRITE_ROLES, 'create invoice');
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
    requireRoles(context, BILLING_READ_ROLES, 'view payments');
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
    requireRoles(context, PAYMENT_WRITE_ROLES, 'record payment');
    const userId = extractUserId(context);
    return this.commandBus.execute(
      new RecordPaymentCommand(tenantId, input, userId),
    );
  }
}
