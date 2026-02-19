---
name: billing-service
description: Knowledge base for billing-service - Subscription management, metered billing, invoicing, payment tracking. CQRS pattern.
---

# Billing Service Knowledge Base

## Overview
The billing-service manages the SaaS billing lifecycle for the aquaculture platform. It handles subscriptions (trial, active, past-due, cancelled), metered usage tracking, invoice generation, payment recording, credits/discounts, and Stripe integration. CQRS pattern throughout. Exposes GraphQL Federation v2 subgraph on port 3006.

## Directory Structure
```
apps/billing-service/src/
  app.module.ts              # Root - TypeORM (billing schema), GraphQL Fed v2, NATS
  main.ts
  filters/
    global-exception.filter.ts

  billing/
    billing.module.ts
    billing.resolver.ts      # GraphQL resolver for all billing operations
    entities/
      subscription.entity.ts         # Tenant subscription (plan, status, limits, pricing)
      invoice.entity.ts              # Invoice with line items
      payment.entity.ts              # Payment records
      subscription-module-item.entity.ts  # Per-module items in a subscription
      tenant-usage-metrics.entity.ts  # Usage tracking for metered billing
    commands/
      create-subscription.command.ts
      cancel-subscription.command.ts
      create-invoice.command.ts
      record-payment.command.ts
    queries/
      get-subscription.query.ts
      get-invoices.query.ts
      get-payments.query.ts
    handlers/
      create-subscription.handler.ts
      cancel-subscription.handler.ts
      create-invoice.handler.ts
      record-payment.handler.ts
    query-handlers/
      get-subscription.handler.ts
      get-invoices.handler.ts
      get-payments.handler.ts
    event-handlers/
      tenant-subscription-requested.handler.ts  # Handles NATS event from admin-api
    dto/
      create-subscription.input.ts
      create-invoice.input.ts
      record-payment.input.ts
    __tests__/
      billing-integration.spec.ts
      subscription.service.spec.ts
      invoice.service.spec.ts
      payment.service.spec.ts
      credit-discount.service.spec.ts

  modules/
    metering/
      metering.module.ts
      usage-metering.service.ts      # Records usage events (API calls, sensor readings, etc.)
      usage-aggregator.service.ts    # Aggregates usage for billing period
      metered-billing.service.ts     # Converts usage to billable amounts
      entities/
        usage-aggregation.entity.ts  # Aggregated usage records
      __tests__/
        usage-metering.service.spec.ts
        usage-aggregator.service.spec.ts
        metered-billing.service.spec.ts

  health/
    health.module.ts
    health.controller.ts
```

## Modules & Features

### BillingModule
Core billing functionality:
- **CreateSubscriptionHandler**: creates subscription for a tenant, sets limits and pricing
- **CancelSubscriptionHandler**: cancels with optional immediate or end-of-period effect
- **CreateInvoiceHandler**: generates invoices from subscription data and usage metrics
- **RecordPaymentHandler**: records payments, updates invoice status
- **TenantSubscriptionRequestedHandler**: NATS event handler - when admin creates tenant, billing creates initial subscription
- **BillingResolver**: GraphQL interface for all billing operations

### MeteringModule
Usage-based billing:
- **UsageMeteringService**: records granular usage events (sensor count, API calls, users, storage)
- **UsageAggregatorService**: aggregates usage events into billing period summaries
- **MeteredBillingService**: converts aggregated usage to billable line items
- **UsageAggregation entity**: stores pre-computed usage totals

## Key Entities

### Subscription
- `id`, `tenantId` (unique - one subscription per tenant)
- `planTier`: STARTER | PROFESSIONAL | ENTERPRISE | CUSTOM
- `planName`, `status`: trial | active | past_due | cancelled | suspended | expired
- `billingCycle`: monthly | quarterly | semi_annual | annual
- `limits` (JSONB - `PlanLimits`):
  ```
  maxFarms, maxPonds, maxSensors, maxUsers, dataRetentionDays
  alertsEnabled, reportsEnabled, apiAccessEnabled, customIntegrationsEnabled
  ```
- `pricing` (JSONB - `PlanPricing`):
  ```
  basePrice, perFarmPrice, perSensorPrice, perUserPrice, currency
  ```
- `startDate`, `endDate`, `currentPeriodStart`, `currentPeriodEnd`
- `trialEndDate`, `cancelledAt`, `cancellationReason`
- `autoRenew`, `stripeSubscriptionId` (HideField), `stripeCustomerId` (HideField)
- `version` (optimistic locking via @VersionColumn)
- Relations: `invoices` (OneToMany), `moduleItems` (OneToMany)

### Invoice
- `id`, `tenantId`, `subscriptionId`
- `invoiceNumber` (unique, human-readable), `status`: draft | sent | paid | overdue | cancelled
- `amount`, `currency`, `tax`, `totalAmount`
- `lineItems` (JSONB array) - itemized charges
- `dueDate`, `paidAt`
- `stripeInvoiceId` (HideField)

### Payment
- `id`, `tenantId`, `invoiceId`
- `amount`, `currency`, `method`: card | bank_transfer | crypto
- `status`: pending | completed | failed | refunded
- `transactionId`, `gatewayResponse` (JSONB)
- `paidAt`
- `stripePaymentIntentId` (HideField)

### SubscriptionModuleItem
- Links specific modules to a subscription with per-module pricing
- `subscriptionId`, `moduleCode`, `price`, `isIncluded`

### TenantUsageMetrics
- Per-period usage totals for a tenant
- `tenantId`, `period` (month), `farmCount`, `sensorCount`, `userCount`, `apiCallCount`, `storageGb`

### UsageAggregation (metering)
- Aggregated usage for billing: `tenantId`, `metricType`, `periodStart`, `periodEnd`, `value`

## API / GraphQL (billing subgraph)

### Key Queries
- `subscription(tenantId)` - get current subscription
- `invoices(tenantId)` - list invoices
- `invoice(id)` - single invoice
- `payments(invoiceId)` - payments for an invoice
- `usageMetrics(tenantId, period)` - usage data

### Key Mutations
- `createSubscription(input)` - create initial subscription
- `updateSubscription(input)` - change plan, billing cycle
- `cancelSubscription(tenantId, reason)` - cancel
- `reactivateSubscription(tenantId)` - reactivate cancelled
- `createInvoice(input)` - manual invoice generation
- `recordPayment(input)` - record payment against invoice
- `applyCredit(tenantId, amount)` - apply credit/discount
- `recordUsage(tenantId, metric, value)` - record metered usage

## Patterns Used
- **CQRS** - all operations go through Commands and Queries
- **Event-driven**: consumes `TenantSubscriptionRequested` from admin-api-service
- **Optimistic locking**: Subscription has `@VersionColumn()` to prevent concurrent updates
- **Stripe integration**: subscription and payment IDs stored for reconciliation (hidden from GQL)
- **JSONB for complex objects**: limits, pricing, lineItems stored as JSONB for flexibility
- **Multi-module pricing**: SubscriptionModuleItem allows per-module pricing within a subscription

## Inter-Service Communication
Consumes NATS events:
- `TenantSubscriptionRequested` (from admin-api-service during tenant provisioning)
- `TenantDeactivated` (triggers subscription cancellation)

Publishes NATS events:
- `SubscriptionCreated`
- `SubscriptionCancelled`
- `InvoiceGenerated`
- `PaymentReceived`
- `SubscriptionPastDue`
- `TrialExpiringSoon`

## Key Dependencies
- `@platform/event-bus` - NATS JetStream
- `@nestjs/cqrs` or `@platform/cqrs` - CQRS bus
- TypeORM with PostgreSQL (billing schema)
- Stripe SDK (for payment processing)

## Known Gotchas
- **One subscription per tenant** - Subscription entity has `@Index(['tenantId'], { unique: true })`
- **Stripe IDs are hidden** - `stripeSubscriptionId`, `stripeCustomerId`, `stripeInvoiceId`, `stripePaymentIntentId` are `@HideField()` in GraphQL
- **Limits as JSONB** - plan limits are stored as JSONB, not relational columns. When checking limits in other services, they must fetch subscription and parse `limits` field
- **Trial management** - `trialEndDate` null means not in trial; check `status === 'trial'` + `trialEndDate`
- **Credit/discount service** - `credit-discount.service.spec.ts` exists but the service may not be in the directory listing (may be in billing.module providers)
- **Currency** - multi-currency support in pricing; always store and compare in same currency
- **billing schema** - unlike farm/hr/sensor/alert, billing uses the shared `billing` schema (admin-api-service has read access for analytics)

## Related Services
- admin-api-service: triggers subscription creation during tenant provisioning; reads billing data for analytics
- auth-service: tenant data referenced by tenantId
- notification-service: receives billing events to send invoices/reminders
