import { Resolver, Query, Mutation, Args, ID, Context } from '@nestjs/graphql';
import { UnauthorizedException, ForbiddenException, BadRequestException } from '@nestjs/common';
import { CommandBus, QueryBus } from '@nestjs/cqrs';
import { Subscription } from './entities/subscription.entity';
import { Invoice, InvoiceStatus } from './entities/invoice.entity';
import { Payment, PaymentStatus } from './entities/payment.entity';
import { Plan } from './entities/plan.entity';
import { CreateSubscriptionInput } from './dto/create-subscription.input';
import { CreateInvoiceInput } from './dto/create-invoice.input';
import { RecordPaymentInput } from './dto/record-payment.input';
import { RefundPaymentInput } from './dto/refund-payment.input';
import { CreatePlanInput } from './dto/create-plan.input';
import { UpdatePlanInput } from './dto/update-plan.input';
import { ChangeSubscriptionPlanInput } from './dto/change-subscription-plan.input';
import { CreateSubscriptionCommand } from './commands/create-subscription.command';
import { CancelSubscriptionCommand } from './commands/cancel-subscription.command';
import { CreateInvoiceCommand } from './commands/create-invoice.command';
import { FinalizeInvoiceCommand } from './commands/finalize-invoice.command';
import { VoidInvoiceCommand } from './commands/void-invoice.command';
import { RecordPaymentCommand } from './commands/record-payment.command';
import { RefundPaymentCommand } from './commands/refund-payment.command';
import { CreatePlanCommand } from './commands/create-plan.command';
import { UpdatePlanCommand } from './commands/update-plan.command';
import { DeactivatePlanCommand } from './commands/deactivate-plan.command';
import { ChangeSubscriptionPlanCommand } from './commands/change-subscription-plan.command';
import { GetSubscriptionQuery } from './queries/get-subscription.query';
import { GetInvoicesQuery, InvoiceFilterInput } from './queries/get-invoices.query';
import { GetPaymentsQuery, PaymentFilterInput } from './queries/get-payments.query';
import { GetPlansQuery } from './queries/get-plans.query';
import { GetPlanByIdQuery } from './queries/get-plan-by-id.query';
import { GetTenantBillingQuery } from './queries/get-tenant-billing.query';
import { TenantBillingResponse } from './dto/tenant-billing-response.dto';
import { Role, isPlatformRole, type Role as PlatformRole } from '@platform/identity';

/**
 * Billing carries operation policy, not a second role vocabulary. The removed
 * BILLING_ADMIN and FINANCE_MANAGER strings were never issued by the auth
 * service, so their branches were unreachable. Financial writes preserve the
 * reachable policy (SUPER_ADMIN); tenant administrators retain read access.
 */
const BILLING_WRITE_ROLES = Object.freeze([Role.SUPER_ADMIN] as const);
const BILLING_READ_ROLES = Object.freeze([Role.SUPER_ADMIN, Role.TENANT_ADMIN] as const);

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
  // Only trust tenant identity from validated JWT, never from raw headers
  const tenantId = context.req.user?.tenantId;

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
  // Defense-in-depth: APP_GUARD already enforces auth globally, but sub may
  // be absent in a malformed JWT that somehow passed. Never fall back to
  // 'system' — a financial mutation attributed to 'system' is untraceable.
  const sub = context.req.user?.sub;
  if (!sub) throw new UnauthorizedException('Authenticated user identity (sub) is required');
  return sub;
}

/**
 * SECURITY: Validates that the user has at least one of the required roles
 * @throws ForbiddenException if user lacks required roles
 */
function requireRoles(
  context: GraphQLContext,
  allowedRoles: readonly PlatformRole[],
  operation: string,
): void {
  const userRoles = (context.req.user?.roles ?? []).filter(isPlatformRole);

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

  // Tenant Billing Aggregate Query (used by tenant-admin billing page)
  @Query(() => TenantBillingResponse, { name: 'tenantBilling' })
  async getTenantBilling(
    @Context() context: GraphQLContext,
  ): Promise<TenantBillingResponse> {
    const tenantId = extractTenantId(context);
    requireRoles(context, BILLING_READ_ROLES, 'view tenant billing');
    return this.queryBus.execute(new GetTenantBillingQuery(tenantId));
  }

  // Subscription Mutations
  @Mutation(() => Subscription)
  async createSubscription(
    @Args('input') input: CreateSubscriptionInput,
    @Context() context: GraphQLContext,
  ): Promise<Subscription> {
    const tenantId = extractTenantId(context);
    requireRoles(context, BILLING_WRITE_ROLES, 'create subscription');
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
    if (!UUID_REGEX.test(id)) {
      throw new BadRequestException('Invalid subscription ID format');
    }
    if (reason && reason.length > 1000) {
      throw new BadRequestException('Cancellation reason must not exceed 1000 characters');
    }
    const tenantId = extractTenantId(context);
    requireRoles(context, BILLING_WRITE_ROLES, 'cancel subscription');
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
    // Single query for all unpaid statuses
    return this.queryBus.execute(
      new GetInvoicesQuery(tenantId, {
        statuses: [InvoiceStatus.PENDING, InvoiceStatus.OVERDUE, InvoiceStatus.PARTIALLY_PAID],
      }),
    );
  }

  // Invoice Mutations
  @Mutation(() => Invoice)
  async createInvoice(
    @Args('input') input: CreateInvoiceInput,
    @Context() context: GraphQLContext,
  ): Promise<Invoice> {
    const tenantId = extractTenantId(context);
    requireRoles(context, BILLING_WRITE_ROLES, 'create invoice');
    const userId = extractUserId(context);
    return this.commandBus.execute(
      new CreateInvoiceCommand(tenantId, input, userId),
    );
  }

  /**
   * Transition a DRAFT invoice to SENT status, making it payable.
   * Invoices must be finalized before payments can be recorded.
   */
  @Mutation(() => Invoice)
  async finalizeInvoice(
    @Args('id', { type: () => ID }) id: string,
    @Context() context: GraphQLContext,
  ): Promise<Invoice> {
    const tenantId = extractTenantId(context);
    requireRoles(context, BILLING_WRITE_ROLES, 'finalize invoice');
    const userId = extractUserId(context);
    return this.commandBus.execute(
      new FinalizeInvoiceCommand(tenantId, id, userId),
    );
  }

  /**
   * Void an invoice. Only unpaid invoices (DRAFT, PENDING, SENT, OVERDUE) can be voided.
   */
  @Mutation(() => Invoice)
  async voidInvoice(
    @Args('id', { type: () => ID }) id: string,
    @Args('reason') reason: string,
    @Context() context: GraphQLContext,
  ): Promise<Invoice> {
    const tenantId = extractTenantId(context);
    requireRoles(context, BILLING_WRITE_ROLES, 'void invoice');
    const userId = extractUserId(context);
    return this.commandBus.execute(
      new VoidInvoiceCommand(tenantId, id, reason, userId),
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
    requireRoles(context, BILLING_WRITE_ROLES, 'record payment');
    const userId = extractUserId(context);
    return this.commandBus.execute(
      new RecordPaymentCommand(tenantId, input, userId),
    );
  }

  /**
   * Refund a payment (full or partial).
   * Only SUPER_ADMIN can issue refunds.
   * Supports multiple partial refunds up to the original payment amount.
   */
  @Mutation(() => Payment)
  async refundPayment(
    @Args('input') input: RefundPaymentInput,
    @Context() context: GraphQLContext,
  ): Promise<Payment> {
    const tenantId = extractTenantId(context);
    requireRoles(context, BILLING_WRITE_ROLES, 'refund payment');
    const userId = extractUserId(context);
    return this.commandBus.execute(
      new RefundPaymentCommand(tenantId, input, userId),
    );
  }

  // ==================== Plan Queries ====================

  /**
   * List all active, public plans.
   * Available to any authenticated user for plan comparison / upgrade flow.
   */
  @Query(() => [Plan], { name: 'plans' })
  async getPlans(
    @Context() context: GraphQLContext,
  ): Promise<Plan[]> {
    // Any authenticated user can view public plans — no role restriction
    extractTenantId(context); // Still require valid auth
    return this.queryBus.execute(new GetPlansQuery(true));
  }

  /**
   * List all plans including inactive/private ones.
   * SUPER_ADMIN only — used in admin panel for plan management.
   */
  @Query(() => [Plan], { name: 'allPlans' })
  async getAllPlans(
    @Context() context: GraphQLContext,
  ): Promise<Plan[]> {
    extractTenantId(context);
    requireRoles(context, BILLING_WRITE_ROLES, 'view all plans');
    return this.queryBus.execute(new GetPlansQuery(false));
  }

  /**
   * Get a single plan by ID.
   */
  @Query(() => Plan, { name: 'plan', nullable: true })
  async getPlanById(
    @Args('id', { type: () => ID }) id: string,
    @Context() context: GraphQLContext,
  ): Promise<Plan | null> {
    if (!UUID_REGEX.test(id)) {
      throw new BadRequestException('Invalid plan ID format');
    }
    extractTenantId(context);
    requireRoles(context, BILLING_READ_ROLES, 'view plan');
    return this.queryBus.execute(new GetPlanByIdQuery(id));
  }

  // ==================== Plan Mutations ====================

  /**
   * Create a new subscription plan. SUPER_ADMIN only.
   */
  @Mutation(() => Plan)
  async createPlan(
    @Args('input') input: CreatePlanInput,
    @Context() context: GraphQLContext,
  ): Promise<Plan> {
    extractTenantId(context);
    requireRoles(context, BILLING_WRITE_ROLES, 'create plan');
    const userId = extractUserId(context);
    return this.commandBus.execute(new CreatePlanCommand(input, userId));
  }

  /**
   * Update an existing plan. SUPER_ADMIN only.
   * Requires expectedVersion for optimistic concurrency control.
   * SAFETY: Price changes only affect NEW subscriptions — existing ones are not modified.
   */
  @Mutation(() => Plan)
  async updatePlan(
    @Args('id', { type: () => ID }) id: string,
    @Args('input') input: UpdatePlanInput,
    @Context() context: GraphQLContext,
  ): Promise<Plan> {
    if (!UUID_REGEX.test(id)) {
      throw new BadRequestException('Invalid plan ID format');
    }
    extractTenantId(context);
    requireRoles(context, BILLING_WRITE_ROLES, 'update plan');
    const userId = extractUserId(context);
    return this.commandBus.execute(new UpdatePlanCommand(id, input, userId));
  }

  /**
   * Soft-deactivate a plan. SUPER_ADMIN only.
   * The plan remains in the database for existing subscriptions but is
   * no longer visible in public listings or selectable for new subscriptions.
   */
  @Mutation(() => Plan)
  async deactivatePlan(
    @Args('id', { type: () => ID }) id: string,
    @Context() context: GraphQLContext,
  ): Promise<Plan> {
    if (!UUID_REGEX.test(id)) {
      throw new BadRequestException('Invalid plan ID format');
    }
    extractTenantId(context);
    requireRoles(context, BILLING_WRITE_ROLES, 'deactivate plan');
    const userId = extractUserId(context);
    return this.commandBus.execute(new DeactivatePlanCommand(id, userId));
  }

  // ==================== Subscription Plan Change ====================

  /**
   * Change a tenant's subscription plan (upgrade or downgrade).
   *
   * - Upgrade: Takes effect immediately with pro-rata credit calculation.
   * - Downgrade: Takes effect at end of current billing period.
   *
   * SUPER_ADMIN only.
   */
  @Mutation(() => Subscription)
  async changeSubscriptionPlan(
    @Args('input') input: ChangeSubscriptionPlanInput,
    @Context() context: GraphQLContext,
  ): Promise<Subscription> {
    const tenantId = extractTenantId(context);
    requireRoles(context, BILLING_WRITE_ROLES, 'change subscription plan');
    const userId = extractUserId(context);
    return this.commandBus.execute(
      new ChangeSubscriptionPlanCommand(tenantId, input, userId),
    );
  }
}
