/**
 * IP-3: Batch resolver DTO types — extracted from batch.resolver.ts (939 lines).
 *
 * Input types (GraphQL @InputType) and response types (GraphQL @ObjectType)
 * that were defined inline in the resolver. Extracted to reduce resolver
 * file size below the 500-line limit.
 */
import { MobileCommandEnvelopeInput } from '@aquaculture/backend-common/mobile-command';
import { ID, Float, Field, InputType, Int, ObjectType, registerEnumType } from '@nestjs/graphql';
import { IsEnum, IsInt, IsNotEmpty, IsNumber, IsOptional, IsString, IsUUID, Min } from 'class-validator';
import { GraphQLJSON } from 'graphql-type-json';

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
  @Field(() => ID) id: string;
  @Field(() => BatchDocumentType) documentType: BatchDocumentType;
  @Field() documentName: string;
  @Field({ nullable: true }) documentNumber?: string;
  @Field() storagePath: string;
  @Field() storageUrl: string;
  @Field() originalFilename: string;
  @Field() mimeType: string;
  @Field(() => Int) fileSize: number;
  @Field({ nullable: true }) issueDate?: Date;
  @Field({ nullable: true }) expiryDate?: Date;
  @Field({ nullable: true }) issuingAuthority?: string;
  @Field({ nullable: true }) notes?: string;
  @Field() createdAt: Date;
}

@InputType()
export class UpdateBatchInput implements UpdateBatchPayload {
  @Field(() => ID) id: string;
  @Field({ nullable: true }) name?: string;
  @Field({ nullable: true }) expectedHarvestDate?: Date;
  @Field(() => Float, { nullable: true }) targetFCR?: number;
  @Field({ nullable: true }) notes?: string;
}

@InputType()
export class RecordMortalityInput extends MobileCommandEnvelopeInput {
  @Field(() => ID) @IsNotEmpty() @IsUUID() batchId: string;
  @Field(() => ID) @IsNotEmpty() @IsUUID() tankId: string;
  @Field(() => Int) @IsNotEmpty() @IsInt() @Min(1) quantity: number;
  @Field(() => MortalityReason) @IsNotEmpty() @IsEnum(MortalityReason) reason: MortalityReason;
  @Field({ nullable: true }) @IsOptional() @IsString() detail?: string;
  @Field({ defaultValue: () => new Date() }) @IsOptional() observedAt: Date;
  @Field({ nullable: true }) @IsOptional() @IsString() observedBy?: string;
  @Field(() => Float, { nullable: true }) @IsOptional() @IsNumber() @Min(0) avgWeightG?: number;
  @Field({ nullable: true }) @IsOptional() @IsString() notes?: string;
}

@InputType()
export class RecordCullInput extends MobileCommandEnvelopeInput {
  @Field(() => ID) @IsNotEmpty() @IsUUID() batchId: string;
  @Field(() => ID) @IsNotEmpty() @IsUUID() tankId: string;
  @Field(() => Int) @IsNotEmpty() @IsInt() @Min(1) quantity: number;
  @Field(() => CullReason) @IsNotEmpty() @IsEnum(CullReason) reason: CullReason;
  @Field({ nullable: true }) @IsOptional() @IsString() detail?: string;
  @Field({ defaultValue: () => new Date() }) @IsOptional() culledAt: Date;
  @Field(() => Float, { nullable: true }) @IsOptional() @IsNumber() @Min(0) avgWeightG?: number;
  @Field({ nullable: true }) @IsOptional() @IsString() notes?: string;
}

@InputType()
export class AllocateToTankInput extends MobileCommandEnvelopeInput {
  @Field(() => ID) @IsNotEmpty() @IsUUID() batchId: string;
  @Field(() => ID) @IsNotEmpty() @IsUUID() tankId: string;
  @Field(() => Int) @IsNotEmpty() @IsInt() @Min(1) quantity: number;
  @Field(() => Float) @IsNotEmpty() @IsNumber() @Min(0) avgWeightG: number;
  @Field(() => AllocationType, { defaultValue: AllocationType.INITIAL_STOCKING }) @IsOptional() @IsEnum(AllocationType) allocationType: AllocationType;
  @Field({ nullable: true }) @IsOptional() allocatedAt?: Date;
  @Field({ nullable: true }) @IsOptional() @IsString() notes?: string;
}

@InputType()
export class TransferBatchInput extends MobileCommandEnvelopeInput {
  @Field(() => ID) @IsNotEmpty() @IsUUID() batchId: string;
  @Field(() => ID) @IsNotEmpty() @IsUUID() sourceTankId: string;
  @Field(() => ID) @IsNotEmpty() @IsUUID() destinationTankId: string;
  @Field(() => Int) @IsNotEmpty() @IsInt() @Min(1) quantity: number;
  @Field(() => Float, { nullable: true }) @IsOptional() @IsNumber() @Min(0) avgWeightG?: number;
  @Field({ nullable: true }) @IsOptional() transferredAt?: Date;
  @Field({ nullable: true }) @IsOptional() @IsString() transferReason?: string;
  @Field({ nullable: true }) @IsOptional() @IsString() notes?: string;
  @Field(() => Boolean, { nullable: true, defaultValue: false, description: 'Kapasite kontrolünü atla' }) @IsOptional() skipCapacityCheck?: boolean;
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
  @Field(() => Float) target: number;
  @Field(() => Float) actual: number;
  @Field(() => Float) theoretical: number;
  @Field(() => Float) variance: number;
  @Field(() => FCRStatusType) status: 'excellent' | 'good' | 'average' | 'poor';
}

@ObjectType()
export class BatchListResponse {
  @Field(() => [Batch]) items: Batch[];
  @Field(() => Int) total: number;
  @Field(() => Int) page: number;
  @Field(() => Int) limit: number;
  @Field(() => Int) totalPages: number;
  @Field() hasNextPage: boolean;
  @Field() hasPreviousPage: boolean;
}

@ObjectType()
export class BatchPerformanceResponse {
  @Field(() => ID) batchId: string;
  @Field() batchNumber: string;
  @Field() speciesName: string;
  @Field(() => Int) initialQuantity: number;
  @Field(() => Int) currentQuantity: number;
  @Field(() => Float) initialBiomassKg: number;
  @Field(() => Float) currentBiomassKg: number;
  @Field(() => Float) initialAvgWeightG: number;
  @Field(() => Float) currentAvgWeightG: number;
  @Field(() => Float) weightGainG: number;
  @Field(() => Float) weightGainPercent: number;
  @Field(() => Int) totalMortality: number;
  @Field(() => Float) mortalityRate: number;
  @Field(() => Float) survivalRate: number;
  @Field(() => Float) retentionRate: number;
  @Field(() => Int) cullCount: number;
  @Field(() => FCRInfo) fcr: FCRInfo;
  @Field(() => Float) sgr: number;
  @Field(() => Int) daysInProduction: number;
  @Field(() => Float) avgDailyGrowthG: number;
  @Field(() => Float) targetDailyGrowthG: number;
  @Field(() => Float) growthVariancePercent: number;
  @Field(() => Float) totalFeedConsumedKg: number;
  @Field(() => Float) totalFeedCost: number;
  @Field(() => Float) avgDailyFeedKg: number;
  @Field(() => Float) purchaseCost: number;
  @Field(() => Float) totalCost: number;
  @Field(() => Float) costPerKg: number;
  @Field(() => Float) costPerFish: number;
  @Field({ nullable: true }) projectedHarvestDate?: Date;
  @Field(() => Float, { nullable: true }) projectedHarvestWeightG?: number;
  @Field(() => Int, { nullable: true }) daysToHarvest?: number;
  @Field(() => Int) performanceIndex: number;
  @Field(() => PerformanceStatusType) performanceStatus: 'excellent' | 'good' | 'average' | 'below_average' | 'poor';
}

@ObjectType()
export class BatchHistoryEntryResponse implements BatchHistoryEntry {
  @Field(() => ID) id: string;
  @Field(() => BatchHistoryEventType) eventType: BatchHistoryEventType;
  @Field() timestamp: Date;
  @Field() description: string;
  @Field(() => GraphQLJSON) details: Record<string, unknown>;
  @Field({ nullable: true }) performedBy?: string;
  @Field(() => ID, { nullable: true }) tankId?: string;
  @Field({ nullable: true }) tankCode?: string;
  @Field(() => Int, { nullable: true }) quantityChange?: number;
  @Field(() => Float, { nullable: true }) biomassChangeKg?: number;
}

@ObjectType()
export class DeleteBatchResponse {
  @Field() success: boolean;
  @Field(() => ID) id: string;
  @Field({ nullable: true }) message?: string;
}

@ObjectType()
export class AvailableTankResponse implements AvailableTank {
  @Field(() => ID) id: string;
  @Field() code: string;
  @Field() name: string;
  @Field(() => Float) volume: number;
  @Field(() => Float) maxBiomass: number;
  @Field(() => Float) currentBiomass: number;
  @Field(() => Float) availableCapacity: number;
  @Field(() => Int) currentCount: number;
  @Field(() => Float) maxDensity: number;
  @Field(() => Float) currentDensity: number;
  @Field() status: string;
  @Field(() => ID) departmentId: string;
  @Field() departmentName: string;
  @Field(() => ID, { nullable: true }) siteId?: string;
  @Field({ nullable: true }) siteName?: string;
}
