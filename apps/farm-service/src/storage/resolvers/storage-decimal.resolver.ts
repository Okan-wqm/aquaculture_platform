/**
 * Decimal-scalar field resolvers for farm storage / purchase-order money DTOs
 * (ADR-0004 / DATA-MEDIUM-009 — additive coexistence).
 *
 * Each `*Decimal` field re-serialises the SAME money value as its deprecated
 * `Float` sibling, but through the exact-decimal `Decimal` scalar so no
 * IEEE-754 precision is lost on the wire. Implemented as `@ResolveField`
 * (the DTOs are assembled in query handlers behind a generic `@Resolver()`)
 * so no handler needs to know about the wire representation.
 */
import { Parent, ResolveField, Resolver } from '@nestjs/graphql';
import { DecimalScalar } from '@aquaculture/backend-common/graphql';

import {
  PurchaseOrderItemResponse,
  PurchaseOrderResponse,
} from '../dto/purchase-order.response';
import {
  CategoryTotal,
  StorageOverviewResponse,
} from '../dto/storage-overview.response';

@Resolver(() => PurchaseOrderItemResponse)
export class PurchaseOrderItemDecimalResolver {
  @ResolveField(() => DecimalScalar, { nullable: true })
  unitPriceDecimal(@Parent() item: PurchaseOrderItemResponse): number | null {
    return item.unitPrice ?? null;
  }

  @ResolveField(() => DecimalScalar, { nullable: true })
  totalPriceDecimal(@Parent() item: PurchaseOrderItemResponse): number | null {
    return item.totalPrice ?? null;
  }
}

@Resolver(() => PurchaseOrderResponse)
export class PurchaseOrderDecimalResolver {
  @ResolveField(() => DecimalScalar, { nullable: true })
  totalAmountDecimal(@Parent() order: PurchaseOrderResponse): number | null {
    return order.totalAmount ?? null;
  }
}

@Resolver(() => CategoryTotal)
export class CategoryTotalDecimalResolver {
  @ResolveField(() => DecimalScalar)
  totalValueDecimal(@Parent() category: CategoryTotal): number {
    return category.totalValue;
  }
}

@Resolver(() => StorageOverviewResponse)
export class StorageOverviewDecimalResolver {
  @ResolveField(() => DecimalScalar)
  totalStockValueDecimal(@Parent() overview: StorageOverviewResponse): number {
    return overview.totalStockValue;
  }
}

/** All storage money-DTO Decimal field resolvers — registered in `StorageModule`. */
export const StorageDecimalResolvers = [
  PurchaseOrderItemDecimalResolver,
  PurchaseOrderDecimalResolver,
  CategoryTotalDecimalResolver,
  StorageOverviewDecimalResolver,
];
