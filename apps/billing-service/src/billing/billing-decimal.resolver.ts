/**
 * Decimal-scalar field resolvers for the billing GraphQL surface
 * (ADR-0004 / PLAT-LOW-001 / PLAT-LOW-002 / DATA-MEDIUM-009 — additive
 * coexistence).
 *
 * Each `*Decimal` field re-serialises the SAME money value as its deprecated
 * `Float` sibling, but through the `Decimal` scalar (an exact decimal string)
 * so no IEEE-754 precision is lost on the wire. The DB layer is already
 * `numeric(19,4)` via `@MoneyColumn` / `DecimalTransformer`; only the GraphQL
 * `Float` serialisation was lossy.
 *
 * Implemented as `@ResolveField` (not entity getters, not a resolver-boundary
 * mapper) so the field is populated automatically on EVERY path — query,
 * mutation, TypeORM entity instance, or plain JSONB-deserialised object — and
 * no command/query handler needs to know about the wire representation. The
 * `Decimal` scalar accepts `number | Decimal | string`, so both the
 * `Decimal`-backed entity columns and the `number`-typed nested JSONB fields
 * flow through unchanged.
 */
import { Parent, ResolveField, Resolver } from '@nestjs/graphql';
import Decimal from 'decimal.js';
import { DecimalScalar } from '@aquaculture/backend-common/graphql';

import {
  TenantInvoiceDto,
  TenantSubscriptionDto,
} from './dto/tenant-billing-response.dto';
import { Invoice, InvoiceLineItem, TaxInfo } from './entities/invoice.entity';
import { Payment, RefundInfo } from './entities/payment.entity';
import { Plan } from './entities/plan.entity';
import { PlanPricing } from './entities/subscription.entity';

@Resolver(() => Invoice)
export class InvoiceDecimalResolver {
  @ResolveField(() => DecimalScalar)
  subtotalDecimal(@Parent() invoice: Invoice): Decimal {
    return invoice.subtotal;
  }

  @ResolveField(() => DecimalScalar, { nullable: true })
  discountDecimal(@Parent() invoice: Invoice): Decimal | null {
    return invoice.discount ?? null;
  }

  @ResolveField(() => DecimalScalar)
  totalDecimal(@Parent() invoice: Invoice): Decimal {
    return invoice.total;
  }

  @ResolveField(() => DecimalScalar)
  amountPaidDecimal(@Parent() invoice: Invoice): Decimal {
    return invoice.amountPaid;
  }

  @ResolveField(() => DecimalScalar)
  amountDueDecimal(@Parent() invoice: Invoice): Decimal {
    return invoice.amountDue;
  }
}

@Resolver(() => InvoiceLineItem)
export class InvoiceLineItemDecimalResolver {
  @ResolveField(() => DecimalScalar)
  unitPriceDecimal(@Parent() item: InvoiceLineItem): number {
    return item.unitPrice;
  }

  @ResolveField(() => DecimalScalar)
  amountDecimal(@Parent() item: InvoiceLineItem): number {
    return item.amount;
  }
}

@Resolver(() => TaxInfo)
export class TaxInfoDecimalResolver {
  @ResolveField(() => DecimalScalar)
  taxAmountDecimal(@Parent() tax: TaxInfo): number {
    return tax.taxAmount;
  }
}

@Resolver(() => Payment)
export class PaymentDecimalResolver {
  @ResolveField(() => DecimalScalar)
  amountDecimal(@Parent() payment: Payment): Decimal {
    return payment.amount;
  }

  @ResolveField(() => DecimalScalar)
  refundedAmountDecimal(@Parent() payment: Payment): Decimal {
    return payment.refundedAmount;
  }
}

@Resolver(() => RefundInfo)
export class RefundInfoDecimalResolver {
  @ResolveField(() => DecimalScalar)
  amountDecimal(@Parent() refund: RefundInfo): number {
    return refund.amount;
  }
}

@Resolver(() => Plan)
export class PlanDecimalResolver {
  @ResolveField(() => DecimalScalar)
  basePriceDecimal(@Parent() plan: Plan): Decimal {
    return plan.basePrice;
  }
}

@Resolver(() => PlanPricing)
export class PlanPricingDecimalResolver {
  @ResolveField(() => DecimalScalar)
  basePriceDecimal(@Parent() pricing: PlanPricing): number {
    return pricing.basePrice;
  }

  @ResolveField(() => DecimalScalar, { nullable: true })
  perFarmPriceDecimal(@Parent() pricing: PlanPricing): number | null {
    return pricing.perFarmPrice ?? null;
  }

  @ResolveField(() => DecimalScalar, { nullable: true })
  perSensorPriceDecimal(@Parent() pricing: PlanPricing): number | null {
    return pricing.perSensorPrice ?? null;
  }

  @ResolveField(() => DecimalScalar, { nullable: true })
  perUserPriceDecimal(@Parent() pricing: PlanPricing): number | null {
    return pricing.perUserPrice ?? null;
  }
}

@Resolver(() => TenantSubscriptionDto)
export class TenantSubscriptionDtoDecimalResolver {
  @ResolveField(() => DecimalScalar)
  monthlyPriceDecimal(@Parent() subscription: TenantSubscriptionDto): number {
    return subscription.monthlyPrice;
  }
}

@Resolver(() => TenantInvoiceDto)
export class TenantInvoiceDtoDecimalResolver {
  @ResolveField(() => DecimalScalar)
  amountDecimal(@Parent() invoice: TenantInvoiceDto): number {
    return invoice.amount;
  }
}

/** All billing Decimal field resolvers — registered in `BillingModule`. */
export const BillingDecimalResolvers = [
  InvoiceDecimalResolver,
  InvoiceLineItemDecimalResolver,
  TaxInfoDecimalResolver,
  PaymentDecimalResolver,
  RefundInfoDecimalResolver,
  PlanDecimalResolver,
  PlanPricingDecimalResolver,
  TenantSubscriptionDtoDecimalResolver,
  TenantInvoiceDtoDecimalResolver,
];
