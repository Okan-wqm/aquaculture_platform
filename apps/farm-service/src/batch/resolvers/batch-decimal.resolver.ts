/**
 * Decimal-scalar field resolvers for farm batch cost DTOs
 * (ADR-0004 / DATA-MEDIUM-009 — additive coexistence).
 *
 * Each `*Decimal` field re-serialises the SAME money value as its deprecated
 * `Float` sibling, but through the exact-decimal `Decimal` scalar so no
 * IEEE-754 precision is lost on the wire. Implemented as `@ResolveField`
 * (not construction-site population) because these DTOs are assembled in
 * several query handlers — the field resolver fires wherever the DTO is
 * returned, so no handler needs to know about the wire representation.
 */
import { Parent, ResolveField, Resolver } from '@nestjs/graphql';
import { DecimalScalar } from '@aquaculture/backend-common/graphql';

import { BatchPerformanceResponse } from '../dto/batch-resolver.dto';
import {
  BatchFeedTotalResponse,
  BatchTraceabilitySummaryResponse,
} from '../dto/batch-traceability.response';

@Resolver(() => BatchPerformanceResponse)
export class BatchPerformanceDecimalResolver {
  @ResolveField(() => DecimalScalar)
  totalFeedCostDecimal(@Parent() perf: BatchPerformanceResponse): number {
    return perf.totalFeedCost;
  }

  @ResolveField(() => DecimalScalar)
  purchaseCostDecimal(@Parent() perf: BatchPerformanceResponse): number {
    return perf.purchaseCost;
  }

  @ResolveField(() => DecimalScalar)
  totalCostDecimal(@Parent() perf: BatchPerformanceResponse): number {
    return perf.totalCost;
  }

  @ResolveField(() => DecimalScalar)
  costPerKgDecimal(@Parent() perf: BatchPerformanceResponse): number {
    return perf.costPerKg;
  }

  @ResolveField(() => DecimalScalar)
  costPerFishDecimal(@Parent() perf: BatchPerformanceResponse): number {
    return perf.costPerFish;
  }
}

@Resolver(() => BatchFeedTotalResponse)
export class BatchFeedTotalDecimalResolver {
  @ResolveField(() => DecimalScalar, { nullable: true })
  totalCostDecimal(@Parent() feed: BatchFeedTotalResponse): number | null {
    return feed.totalCost ?? null;
  }
}

@Resolver(() => BatchTraceabilitySummaryResponse)
export class BatchTraceabilitySummaryDecimalResolver {
  @ResolveField(() => DecimalScalar, { nullable: true })
  totalFeedCostDecimal(@Parent() summary: BatchTraceabilitySummaryResponse): number | null {
    return summary.totalFeedCost ?? null;
  }
}

/** All batch cost-DTO Decimal field resolvers — registered in `BatchModule`. */
export const BatchDecimalResolvers = [
  BatchPerformanceDecimalResolver,
  BatchFeedTotalDecimalResolver,
  BatchTraceabilitySummaryDecimalResolver,
];
