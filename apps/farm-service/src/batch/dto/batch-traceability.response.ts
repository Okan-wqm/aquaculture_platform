/**
 * Batch traceability report GraphQL types (Phase 6).
 *
 * Typed mirror of the query-layer result (`get-batch-traceability.query.ts`):
 * summary + residency intervals (each with water/feed aggregates) + whole-batch
 * feed totals + the operation timeline (reuses BatchHistoryEntryResponse — one
 * event shape across batchHistory and the report).
 */
import { ID, Float, Field, Int, ObjectType } from '@nestjs/graphql';

import {
  BatchFeedTotal,
  BatchResidency,
  BatchResidencyWater,
  BatchTraceabilitySummary,
} from '../queries/get-batch-traceability.query';

import { BatchHistoryEntryResponse } from './batch-resolver.dto';

@ObjectType()
export class BatchFeedTotalResponse implements BatchFeedTotal {
  @Field(() => ID) feedId!: string;
  @Field({ nullable: true }) feedName?: string;
  @Field({ nullable: true }) feedCode?: string;
  @Field(() => Float) totalKg!: number;
  @Field(() => Float, { nullable: true }) totalCost?: number;
}

@ObjectType()
export class BatchResidencyWaterResponse implements BatchResidencyWater {
  @Field(() => Float, { nullable: true }) temperatureMinC?: number;
  @Field(() => Float, { nullable: true }) temperatureAvgC?: number;
  @Field(() => Float, { nullable: true }) temperatureMaxC?: number;
  @Field(() => Int) measurementCount!: number;
}

@ObjectType()
export class BatchResidencyResponse implements BatchResidency {
  @Field(() => ID) tankId!: string;
  @Field({ nullable: true }) tankName?: string;
  @Field({ nullable: true }) tankCode?: string;
  @Field() movedAt!: Date;
  @Field({ nullable: true }) exitedAt?: Date;
  @Field() isCurrent!: boolean;
  @Field(() => Float) durationDays!: number;
  @Field(() => Int) quantityAtEntry!: number;
  @Field(() => Float, { nullable: true }) avgWeightAtEntryG?: number;
  @Field({ nullable: true }) transferReason?: string;
  @Field(() => BatchResidencyWaterResponse) water!: BatchResidencyWaterResponse;
  @Field(() => [BatchFeedTotalResponse]) feed!: BatchFeedTotalResponse[];
  @Field(() => Float) feedTotalKg!: number;
}

@ObjectType()
export class BatchTraceabilitySummaryResponse implements BatchTraceabilitySummary {
  @Field(() => ID) batchId!: string;
  @Field() batchNumber!: string;
  @Field() status!: string;
  @Field({ nullable: true }) speciesName?: string;
  @Field() stockedAt!: Date;
  @Field({ nullable: true }) harvestedAt?: Date;
  @Field(() => Int) daysInProduction!: number;
  @Field(() => Int) initialQuantity!: number;
  @Field(() => Int) currentQuantity!: number;
  @Field(() => Float, { nullable: true }) initialAvgWeightG?: number;
  @Field(() => Float, { nullable: true }) currentAvgWeightG?: number;
  @Field(() => Float, { nullable: true }) survivalRatePercent?: number;
  @Field(() => ID, { nullable: true }) protocolId?: string;
  @Field({ nullable: true }) protocolName?: string;
  @Field(() => Float) totalFeedKg!: number;
  @Field(() => Float, { nullable: true }) totalFeedCost?: number;
  @Field(() => Float, { nullable: true }) fcrActual?: number;
}

@ObjectType()
export class BatchTraceabilityResponse {
  @Field(() => BatchTraceabilitySummaryResponse) summary!: BatchTraceabilitySummaryResponse;
  @Field(() => [BatchResidencyResponse]) residencies!: BatchResidencyResponse[];
  @Field(() => [BatchFeedTotalResponse]) feedTotals!: BatchFeedTotalResponse[];
  @Field(() => [BatchHistoryEntryResponse]) events!: BatchHistoryEntryResponse[];
}
