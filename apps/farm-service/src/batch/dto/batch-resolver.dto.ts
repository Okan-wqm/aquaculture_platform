/**
 * IP-3: Batch resolver DTO types — extracted from batch.resolver.ts (939 lines).
 *
 * Input types (GraphQL @InputType) and response types (GraphQL @ObjectType)
 * that were defined inline in the resolver. Extracted to reduce resolver
 * file size below the 500-line limit.
 */
import { MobileCommandEnvelopeInput } from '@aquaculture/backend-common/mobile-command';
import { StandardPaginatedResponse } from '@aquaculture/backend-common/pagination';
import { ID, Float, Field, InputType, Int, ObjectType, registerEnumType } from '@nestjs/graphql';
import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsNotEmpty, IsNumber, IsOptional, IsString, IsUUID, MaxLength, Min, ValidateNested } from 'class-validator';
import { GraphQLJSON } from 'graphql-type-json';

/**
 * FARM-HIGH-052: stock-mutating mobile mutations MUST carry an idempotency key,
 * so the four inputs below re-declare clientCommandId + payloadHash as
 * NON-NULLABLE, overriding the nullable fields on the abstract
 * MobileCommandEnvelopeInput parent. A non-nullable @Field on the subclass wins
 * at GraphQL schema build, making it structurally impossible to submit a stock
 * mutation without the key — the handler's legacy-mode reject then becomes
 * unreachable from the GraphQL front. Mobile already generates these (Phase 1-3).
 *
 * NOTE: a TS class field declared without a default keeps the inherited optional
 * member's nullability for type-checking; the runtime GraphQL/validation
 * non-nullability is what enforces the key. The `!` definite-assignment marker
 * documents that intent.
 */

import { AllocationType } from '../commands/allocate-to-tank.command';
import { CullReason } from '../commands/record-cull.command';
import { MortalityReason } from '../commands/record-mortality.command';
import { UpdateBatchPayload } from '../commands/update-batch.command';
import { BatchDocumentType } from '../entities/batch-document.entity';
import { Batch, BatchInputType, BatchStatus } from '../entities/batch.entity';
import { BatchHistoryEntry, BatchHistoryEventType } from '../queries/get-batch-history.query';
import { AvailableTank } from '../queries/list-available-tanks.query';
import { BatchFilterInput as BatchFilter } from '../queries/list-batches.query';

// ============================================================================
// INPUT TYPES
// ============================================================================

@ObjectType()
export class BatchDocumentResponse {
  @Field(() => ID) id!: string;
  @Field(() => BatchDocumentType) documentType!: BatchDocumentType;
  @Field() documentName!: string;
  @Field({ nullable: true }) documentNumber?: string;
  @Field() storagePath!: string;
  @Field() storageUrl!: string;
  @Field() originalFilename!: string;
  @Field() mimeType!: string;
  @Field(() => Int) fileSize!: number;
  @Field({ nullable: true }) issueDate?: Date;
  @Field({ nullable: true }) expiryDate?: Date;
  @Field({ nullable: true }) issuingAuthority?: string;
  @Field({ nullable: true }) notes?: string;
  @Field() createdAt!: Date;
}

@InputType()
export class UpdateBatchInput implements UpdateBatchPayload {
  @Field(() => ID) id!: string;
  @Field({ nullable: true }) name?: string;
  @Field({ nullable: true }) expectedHarvestDate?: Date;
  @Field(() => Float, { nullable: true }) targetFCR?: number;
  @Field({ nullable: true }) notes?: string;
}

@InputType()
export class RecordMortalityInput extends MobileCommandEnvelopeInput {
  @Field(() => ID) @IsNotEmpty() @IsUUID() clientCommandId!: string;
  @Field() @IsNotEmpty() @IsString() @MaxLength(128) payloadHash!: string;
  @Field(() => ID) @IsNotEmpty() @IsUUID() batchId!: string;
  @Field(() => ID) @IsNotEmpty() @IsUUID() tankId!: string;
  @Field(() => Int) @IsNotEmpty() @IsInt() @Min(1) quantity!: number;
  @Field(() => MortalityReason) @IsNotEmpty() @IsEnum(MortalityReason) reason!: MortalityReason;
  @Field({ nullable: true }) @IsOptional() @IsString() detail?: string;
  @Field({ defaultValue: () => new Date() }) @IsOptional() observedAt!: Date;
  @Field({ nullable: true }) @IsOptional() @IsString() observedBy?: string;
  @Field(() => Float, { nullable: true }) @IsOptional() @IsNumber() @Min(0) avgWeightG?: number;
  /** D-3 mod (b): tane + kg birlikte — verilen kg AYNEN düşer, kalanın
   *  ortalaması kayar (büyük balık kaybı). Boşsa mod (a): kg güncel
   *  ortalamadan türetilir, ortalama değişmez. */
  @Field(() => Float, { nullable: true }) @IsOptional() @IsNumber() @Min(0.001) biomassKg?: number;
  @Field({ nullable: true }) @IsOptional() @IsString() notes?: string;
}

@InputType()
export class RecordCullInput extends MobileCommandEnvelopeInput {
  @Field(() => ID) @IsNotEmpty() @IsUUID() clientCommandId!: string;
  @Field() @IsNotEmpty() @IsString() @MaxLength(128) payloadHash!: string;
  @Field(() => ID) @IsNotEmpty() @IsUUID() batchId!: string;
  @Field(() => ID) @IsNotEmpty() @IsUUID() tankId!: string;
  @Field(() => Int) @IsNotEmpty() @IsInt() @Min(1) quantity!: number;
  @Field(() => CullReason) @IsNotEmpty() @IsEnum(CullReason) reason!: CullReason;
  @Field({ nullable: true }) @IsOptional() @IsString() detail?: string;
  @Field({ defaultValue: () => new Date() }) @IsOptional() culledAt!: Date;
  @Field(() => Float, { nullable: true }) @IsOptional() @IsNumber() @Min(0) avgWeightG?: number;
  /** D-3 mod (b): tane + kg birlikte — verilen kg AYNEN düşer, kalanın
   *  ortalaması kayar (büyük balık kaybı). Boşsa mod (a): kg güncel
   *  ortalamadan türetilir, ortalama değişmez. */
  @Field(() => Float, { nullable: true }) @IsOptional() @IsNumber() @Min(0.001) biomassKg?: number;
  @Field({ nullable: true }) @IsOptional() @IsString() notes?: string;
}

@InputType()
export class AllocateToTankInput extends MobileCommandEnvelopeInput {
  @Field(() => ID) @IsNotEmpty() @IsUUID() clientCommandId!: string;
  @Field() @IsNotEmpty() @IsString() @MaxLength(128) payloadHash!: string;
  @Field(() => ID) @IsNotEmpty() @IsUUID() batchId!: string;
  @Field(() => ID) @IsNotEmpty() @IsUUID() tankId!: string;
  @Field(() => Int) @IsNotEmpty() @IsInt() @Min(1) quantity!: number;
  @Field(() => Float) @IsNotEmpty() @IsNumber() @Min(0) avgWeightG!: number;
  @Field(() => AllocationType, { defaultValue: AllocationType.INITIAL_STOCKING }) @IsOptional() @IsEnum(AllocationType) allocationType!: AllocationType;
  @Field({ nullable: true }) @IsOptional() allocatedAt?: Date;
  @Field({ nullable: true }) @IsOptional() @IsString() notes?: string;
}

@InputType()
export class TransferBatchInput extends MobileCommandEnvelopeInput {
  @Field(() => ID) @IsNotEmpty() @IsUUID() clientCommandId!: string;
  @Field() @IsNotEmpty() @IsString() @MaxLength(128) payloadHash!: string;
  @Field(() => ID) @IsNotEmpty() @IsUUID() batchId!: string;
  @Field(() => ID) @IsNotEmpty() @IsUUID() sourceTankId!: string;
  @Field(() => ID) @IsNotEmpty() @IsUUID() destinationTankId!: string;
  @Field(() => Int) @IsNotEmpty() @IsInt() @Min(1) quantity!: number;
  @Field(() => Float, { nullable: true }) @IsOptional() @IsNumber() @Min(0) avgWeightG?: number;
  /** D-3 mod (b): tane + kg birlikte — verilen kg AYNEN düşer, kalanın
   *  ortalaması kayar (büyük balık kaybı). Boşsa mod (a): kg güncel
   *  ortalamadan türetilir, ortalama değişmez. */
  @Field(() => Float, { nullable: true }) @IsOptional() @IsNumber() @Min(0.001) biomassKg?: number;
  @Field({ nullable: true }) @IsOptional() transferredAt?: Date;
  @Field({ nullable: true }) @IsOptional() @IsString() transferReason?: string;
  @Field({ nullable: true }) @IsOptional() @IsString() notes?: string;
  @Field(() => Boolean, { nullable: true, defaultValue: false, description: 'Kapasite kontrolünü atla' }) @IsOptional() skipCapacityCheck?: boolean;
}

@InputType()
export class GradingOutputInput {
  @Field(() => ID) @IsNotEmpty() @IsUUID() destinationTankId!: string;
  @Field(() => Int) @IsNotEmpty() @IsInt() @Min(1) quantity!: number;
  @Field(() => Float) @IsNotEmpty() @IsNumber() @Min(0.01) avgWeightG!: number;
  @Field({ nullable: true }) @IsOptional() @IsString() @MaxLength(64) sizeClass?: string;
  /** Per-output at-most-once envelope — each movement is its own transfer. */
  @Field(() => ID) @IsNotEmpty() @IsUUID() clientCommandId!: string;
  @Field() @IsNotEmpty() @IsString() @MaxLength(128) payloadHash!: string;
}

@InputType()
export class RecordGradingInput extends MobileCommandEnvelopeInput {
  @Field(() => ID) @IsNotEmpty() @IsUUID() batchId!: string;
  @Field(() => ID) @IsNotEmpty() @IsUUID() sourceTankId!: string;
  @Field({ nullable: true }) @IsOptional() gradedAt?: Date;
  @Field({ nullable: true }) @IsOptional() @IsString() notes?: string;
  @Field(() => [GradingOutputInput]) @ValidateNested({ each: true }) @Type(() => GradingOutputInput) outputs!: GradingOutputInput[];
}

@InputType()
export class BatchFilterInput implements BatchFilter {
  @Field(() => [BatchStatus], { nullable: true }) status?: BatchStatus[];
  @Field(() => ID, { nullable: true }) speciesId?: string;
  @Field(() => BatchInputType, { nullable: true }) inputType?: BatchInputType;
  @Field(() => ID, { nullable: true }) supplierId?: string;
  @Field(() => ID, { nullable: true }) tankId?: string;
  @Field(() => ID, { nullable: true, description: 'Filter by site' }) siteId?: string;
  @Field(() => ID, { nullable: true, description: 'Filter by department' }) departmentId?: string;
  @Field({ nullable: true }) isActive?: boolean;
  @Field({ nullable: true }) stockedAfter?: Date;
  @Field({ nullable: true }) stockedBefore?: Date;
  @Field({ nullable: true }) searchTerm?: string;
}

// ============================================================================
// RESPONSE TYPES
// ============================================================================

export enum FCRStatusType {
  EXCELLENT = 'excellent',
  GOOD = 'good',
  AVERAGE = 'average',
  POOR = 'poor',
}

export enum PerformanceStatusType {
  EXCELLENT = 'excellent',
  GOOD = 'good',
  AVERAGE = 'average',
  BELOW_AVERAGE = 'below_average',
  POOR = 'poor',
}

registerEnumType(FCRStatusType, { name: 'FCRStatusType' });
registerEnumType(PerformanceStatusType, { name: 'PerformanceStatusType' });

@ObjectType()
export class FCRInfo {
  @Field(() => Float) target!: number;
  @Field(() => Float) actual!: number;
  @Field(() => Float) theoretical!: number;
  @Field(() => Float) variance!: number;
  @Field(() => FCRStatusType) status!: 'excellent' | 'good' | 'average' | 'poor';
}

@ObjectType()
export class BatchListResponse extends StandardPaginatedResponse(Batch) {}

@ObjectType()
export class BatchPerformanceResponse {
  @Field(() => ID) batchId!: string;
  @Field() batchNumber!: string;
  @Field() speciesName!: string;
  @Field(() => Int) initialQuantity!: number;
  @Field(() => Int) currentQuantity!: number;
  @Field(() => Float) initialBiomassKg!: number;
  @Field(() => Float) currentBiomassKg!: number;
  @Field(() => Float) initialAvgWeightG!: number;
  @Field(() => Float) currentAvgWeightG!: number;
  @Field(() => Float) weightGainG!: number;
  @Field(() => Float) weightGainPercent!: number;
  @Field(() => Int) totalMortality!: number;
  @Field(() => Float) mortalityRate!: number;
  @Field(() => Float) survivalRate!: number;
  @Field(() => Float) retentionRate!: number;
  @Field(() => Int) cullCount!: number;
  @Field(() => FCRInfo) fcr!: FCRInfo;
  @Field(() => Float) sgr!: number;
  @Field(() => Int) daysInProduction!: number;
  @Field(() => Float) avgDailyGrowthG!: number;
  @Field(() => Float) targetDailyGrowthG!: number;
  @Field(() => Float) growthVariancePercent!: number;
  @Field(() => Float) totalFeedConsumedKg!: number;
  @Field(() => Float, { deprecationReason: 'Use totalFeedCostDecimal (exact decimal string, ADR-0004).' }) totalFeedCost!: number;
  @Field(() => Float) avgDailyFeedKg!: number;
  @Field(() => Float, { deprecationReason: 'Use purchaseCostDecimal (exact decimal string, ADR-0004).' }) purchaseCost!: number;
  @Field(() => Float, { deprecationReason: 'Use totalCostDecimal (exact decimal string, ADR-0004).' }) totalCost!: number;
  @Field(() => Float, { deprecationReason: 'Use costPerKgDecimal (exact decimal string, ADR-0004).' }) costPerKg!: number;
  @Field(() => Float, { deprecationReason: 'Use costPerFishDecimal (exact decimal string, ADR-0004).' }) costPerFish!: number;
  @Field({ nullable: true }) projectedHarvestDate?: Date;
  @Field(() => Float, { nullable: true }) projectedHarvestWeightG?: number;
  @Field(() => Int, { nullable: true }) daysToHarvest?: number;
  @Field(() => Int) performanceIndex!: number;
  @Field(() => PerformanceStatusType) performanceStatus!: 'excellent' | 'good' | 'average' | 'below_average' | 'poor';
}

@ObjectType()
export class BatchHistoryEntryResponse implements BatchHistoryEntry {
  @Field(() => ID) id!: string;
  @Field(() => BatchHistoryEventType) eventType!: BatchHistoryEventType;
  @Field() timestamp!: Date;
  @Field() description!: string;
  @Field(() => GraphQLJSON) details!: Record<string, unknown>;
  @Field({ nullable: true }) performedBy?: string;
  @Field(() => ID, { nullable: true }) tankId?: string;
  @Field({ nullable: true }) tankCode?: string;
  @Field(() => Int, { nullable: true }) quantityChange?: number;
  @Field(() => Float, { nullable: true }) biomassChangeKg?: number;
}

@ObjectType()
export class DeleteBatchResponse {
  @Field() success!: boolean;
  @Field(() => ID) id!: string;
  @Field({ nullable: true }) message?: string;
}

@ObjectType()
export class AvailableTankResponse implements AvailableTank {
  @Field(() => ID) id!: string;
  @Field() code!: string;
  @Field() name!: string;
  @Field(() => Float) volume!: number;
  @Field(() => Float) maxBiomass!: number;
  @Field(() => Float) currentBiomass!: number;
  @Field(() => Float) availableCapacity!: number;
  @Field(() => Int) currentCount!: number;
  @Field(() => Float) maxDensity!: number;
  @Field(() => Float) currentDensity!: number;
  @Field() status!: string;
  @Field(() => ID) departmentId!: string;
  @Field() departmentName!: string;
  @Field(() => ID, { nullable: true }) siteId?: string;
  @Field({ nullable: true }) siteName?: string;
}
