/**
 * CleanerFish GraphQL Resolver
 *
 * Cleaner fish batch operasyonları için GraphQL API.
 * Lumpfish, Wrasse türleri ve tank deployment işlemleri.
 *
 * @module Batch/Resolvers
 */
import {
  Resolver,
  Query,
  Mutation,
  Args,
  ID,
  ObjectType,
  Field,
  Int,
  Float,
  InputType,
} from '@nestjs/graphql';
import { Logger } from '@nestjs/common';
import { IsUUID, IsNotEmpty, IsInt, Min, IsOptional, IsNumber, IsString, IsEnum, IsDateString } from 'class-validator';
import { CommandBus, QueryBus } from '@platform/cqrs';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Batch, BatchStatus, BatchType } from '../entities/batch.entity';
import { TankBatch } from '../entities/tank-batch.entity';
import { TankOperation, OperationType, MortalityReason } from '../entities/tank-operation.entity';
import { Species } from '../../species/entities/species.entity';

// Commands
import { CreateCleanerBatchCommand, CreateCleanerBatchPayload } from '../commands/create-cleaner-batch.command';
import { DeployCleanerFishCommand, DeployCleanerFishPayload } from '../commands/deploy-cleaner-fish.command';
import { RecordCleanerMortalityCommand, RecordCleanerMortalityPayload } from '../commands/record-cleaner-mortality.command';
import { TransferCleanerFishCommand, TransferCleanerFishPayload } from '../commands/transfer-cleaner-fish.command';
import { RemoveCleanerFishCommand, RemoveCleanerFishPayload, CleanerFishRemovalReason } from '../commands/remove-cleaner-fish.command';

// ============================================================================
// INPUT TYPES
// ============================================================================

@InputType()
export class CreateCleanerBatchInput {
  @Field(() => ID)
  @IsNotEmpty()
  @IsUUID()
  speciesId: string;

  @Field(() => Int)
  @IsNotEmpty()
  @IsInt()
  @Min(1)
  initialQuantity: number;

  @Field(() => Float)
  @IsNotEmpty()
  @IsNumber()
  @Min(0)
  initialAvgWeightG: number;

  @Field(() => String)
  @IsNotEmpty()
  @IsString()
  sourceType: string; // 'farmed' | 'wild_caught'

  @Field(() => String, { nullable: true })
  @IsOptional()
  @IsString()
  sourceLocation?: string;

  @Field(() => ID, { nullable: true })
  @IsOptional()
  @IsUUID()
  supplierId?: string;

  @Field()
  @IsNotEmpty()
  stockedAt: Date;

  @Field(() => Float, { nullable: true })
  @IsOptional()
  @IsNumber()
  purchaseCost?: number;

  @Field(() => String, { nullable: true })
  @IsOptional()
  @IsString()
  currency?: string;

  @Field(() => String, { nullable: true })
  @IsOptional()
  @IsString()
  notes?: string;
}

@InputType()
export class DeployCleanerFishInput {
  @Field(() => ID)
  @IsNotEmpty()
  @IsUUID()
  cleanerBatchId: string;

  @Field(() => ID)
  @IsNotEmpty()
  @IsUUID()
  targetTankId: string;

  @Field(() => Int)
  @IsNotEmpty()
  @IsInt()
  @Min(1)
  quantity: number;

  @Field(() => Float, { nullable: true })
  @IsOptional()
  @IsNumber()
  avgWeightG?: number;

  @Field()
  @IsNotEmpty()
  deployedAt: Date;

  @Field(() => String, { nullable: true })
  @IsOptional()
  @IsString()
  notes?: string;
}

@InputType()
export class RecordCleanerMortalityInput {
  @Field(() => ID)
  @IsNotEmpty()
  @IsUUID()
  cleanerBatchId: string;

  @Field(() => ID)
  @IsNotEmpty()
  @IsUUID()
  tankId: string;

  @Field(() => Int)
  @IsNotEmpty()
  @IsInt()
  @Min(1)
  quantity: number;

  @Field(() => String)
  @IsNotEmpty()
  @IsString()
  reason: string; // MortalityReason value: 'disease' | 'water_quality' | 'stress' | 'handling' | 'temperature' | 'oxygen' | 'unknown' | 'other'

  @Field(() => String, { nullable: true })
  @IsOptional()
  @IsString()
  detail?: string;

  @Field()
  @IsNotEmpty()
  observedAt: Date;

  @Field(() => String, { nullable: true })
  @IsOptional()
  @IsString()
  notes?: string;
}

@InputType()
export class TransferCleanerFishInput {
  @Field(() => ID)
  @IsNotEmpty()
  @IsUUID()
  cleanerBatchId: string;

  @Field(() => ID)
  @IsNotEmpty()
  @IsUUID()
  sourceTankId: string;

  @Field(() => ID)
  @IsNotEmpty()
  @IsUUID()
  destinationTankId: string;

  @Field(() => Int)
  @IsNotEmpty()
  @IsInt()
  @Min(1)
  quantity: number;

  @Field()
  @IsNotEmpty()
  transferredAt: Date;

  @Field(() => String, { nullable: true })
  @IsOptional()
  @IsString()
  reason?: string;

  @Field(() => String, { nullable: true })
  @IsOptional()
  @IsString()
  notes?: string;
}

@InputType()
export class RemoveCleanerFishInput {
  @Field(() => ID)
  @IsNotEmpty()
  @IsUUID()
  cleanerBatchId: string;

  @Field(() => ID)
  @IsNotEmpty()
  @IsUUID()
  tankId: string;

  @Field(() => Int)
  @IsNotEmpty()
  @IsInt()
  @Min(1)
  quantity: number;

  @Field(() => String, { description: 'Removal reason: end_of_cycle, harvest, relocation, other' })
  @IsNotEmpty()
  @IsString()
  reason: string;

  @Field()
  @IsNotEmpty()
  removedAt: Date;

  @Field(() => Float, { nullable: true, description: 'Average weight at removal (for harvest tracking)' })
  @IsOptional()
  @IsNumber()
  avgWeightG?: number;

  @Field(() => String, { nullable: true })
  @IsOptional()
  @IsString()
  notes?: string;
}

// ============================================================================
// RESPONSE TYPES
// ============================================================================

@ObjectType('CleanerFishSpeciesInfo')
export class CleanerFishSpeciesInfo {
  @Field(() => ID)
  id: string;

  @Field()
  scientificName: string;

  @Field()
  commonName: string;

  @Field(() => String, { nullable: true })
  localName?: string;

  @Field()
  code: string;

  @Field(() => String, { nullable: true })
  cleanerFishType?: string;
}

@ObjectType()
export class CleanerFishBatchSummary {
  @Field(() => ID)
  batchId: string;

  @Field()
  batchNumber: string;

  @Field()
  speciesName: string;

  @Field(() => Int)
  totalQuantity: number;

  @Field(() => Int)
  deployedQuantity: number;

  @Field(() => Int)
  availableQuantity: number;

  @Field(() => String)
  sourceType: string;

  @Field(() => String, { nullable: true })
  sourceLocation?: string;
}

@ObjectType()
export class TankCleanerFishInfo {
  @Field(() => ID)
  tankId: string;

  @Field()
  tankName: string;

  @Field(() => Int)
  cleanerFishQuantity: number;

  @Field(() => Float)
  cleanerFishBiomassKg: number;

  @Field(() => Float)
  cleanerFishRatio: number;

  @Field(() => [CleanerFishDetailResponse])
  details: CleanerFishDetailResponse[];
}

@ObjectType()
export class CleanerFishDetailResponse {
  @Field(() => ID)
  batchId: string;

  @Field()
  batchNumber: string;

  @Field()
  speciesName: string;

  @Field(() => Int)
  quantity: number;

  @Field(() => Float)
  avgWeightG: number;

  @Field(() => Float)
  biomassKg: number;

  @Field(() => String)
  sourceType: string;

  @Field()
  deployedAt: Date;
}

@ObjectType()
export class CleanerFishReportRow {
  @Field()
  speciesName: string;

  @Field(() => Int)
  openingStock: number;

  @Field(() => Int)
  added: number;

  @Field(() => Int)
  removed: number;

  @Field(() => Int)
  mortality: number;

  @Field(() => Int)
  transferred: number;

  @Field(() => Int)
  closingStock: number;
}

@ObjectType()
export class CleanerFishReport {
  @Field(() => ID)
  siteId: string;

  @Field()
  siteName: string;

  @Field(() => Int)
  month: number;

  @Field(() => Int)
  year: number;

  @Field(() => [CleanerFishReportRow])
  rows: CleanerFishReportRow[];

  @Field(() => Int)
  totalOpeningStock: number;

  @Field(() => Int)
  totalClosingStock: number;
}

// ============================================================================
// RESOLVER
// ============================================================================

@Resolver(() => Batch)
export class CleanerFishResolver {
  private readonly logger = new Logger(CleanerFishResolver.name);

  constructor(
    private readonly commandBus: CommandBus,
    private readonly queryBus: QueryBus,
    @InjectRepository(Batch)
    private readonly batchRepository: Repository<Batch>,
    @InjectRepository(TankBatch)
    private readonly tankBatchRepository: Repository<TankBatch>,
    @InjectRepository(TankOperation)
    private readonly operationRepository: Repository<TankOperation>,
    @InjectRepository(Species)
    private readonly speciesRepository: Repository<Species>,
  ) {}

  // -------------------------------------------------------------------------
  // QUERIES
  // -------------------------------------------------------------------------

  @Query(() => [CleanerFishSpeciesInfo], { name: 'cleanerFishSpecies' })
  async getCleanerFishSpecies(
    @Args('tenantId') tenantId: string,
  ): Promise<CleanerFishSpeciesInfo[]> {
    this.logger.debug(`Getting cleaner fish species for tenant: ${tenantId}`);

    const species = await this.speciesRepository.find({
      where: { tenantId, isCleanerFish: true, isActive: true, isDeleted: false },
      order: { commonName: 'ASC' },
    });

    return species.map((s) => ({
      id: s.id,
      scientificName: s.scientificName,
      commonName: s.commonName,
      localName: s.localName,
      code: s.code,
      cleanerFishType: s.cleanerFishType,
    }));
  }

  @Query(() => [Batch], { name: 'cleanerFishBatches' })
  async getCleanerFishBatches(
    @Args('tenantId') tenantId: string,
    @Args('status', { type: () => BatchStatus, nullable: true }) status?: BatchStatus,
  ): Promise<Batch[]> {
    this.logger.debug(`Getting cleaner fish batches for tenant: ${tenantId}`);

    const where: any = {
      tenantId,
      batchType: BatchType.CLEANER_FISH,
      isActive: true,
    };

    if (status) {
      where.status = status;
    }

    return this.batchRepository.find({
      where,
      order: { stockedAt: 'DESC' },
    });
  }

  @Query(() => TankCleanerFishInfo, { name: 'tankCleanerFish', nullable: true })
  async getTankCleanerFish(
    @Args('tenantId') tenantId: string,
    @Args('tankId', { type: () => ID }) tankId: string,
  ): Promise<TankCleanerFishInfo | null> {
    this.logger.debug(`Getting cleaner fish info for tank: ${tankId}`);

    const tankBatch = await this.tankBatchRepository.findOne({
      where: { tenantId, tankId },
    });

    if (!tankBatch || !tankBatch.cleanerFishQuantity) {
      return null;
    }

    const details: CleanerFishDetailResponse[] = (tankBatch.cleanerFishDetails || []).map((d) => ({
      batchId: d.batchId,
      batchNumber: d.batchNumber,
      speciesName: d.speciesName,
      quantity: d.quantity,
      avgWeightG: d.avgWeightG,
      biomassKg: d.biomassKg,
      sourceType: d.sourceType,
      deployedAt: d.deployedAt,
    }));

    return {
      tankId,
      tankName: tankBatch.tankName || '',
      cleanerFishQuantity: tankBatch.cleanerFishQuantity,
      cleanerFishBiomassKg: Number(tankBatch.cleanerFishBiomassKg),
      cleanerFishRatio: tankBatch.getCleanerFishRatio(),
      details,
    };
  }

  @Query(() => CleanerFishReport, { name: 'cleanerFishReport', nullable: true })
  async getCleanerFishReport(
    @Args('tenantId') tenantId: string,
    @Args('siteId', { type: () => ID }) siteId: string,
    @Args('month', { type: () => Int }) month: number,
    @Args('year', { type: () => Int }) year: number,
  ): Promise<CleanerFishReport> {
    this.logger.debug(`Generating cleaner fish report for site: ${siteId}, ${month}/${year}`);

    // TODO: Implement full report logic with tank operations aggregation
    // This is a placeholder implementation
    const rows: CleanerFishReportRow[] = [];

    return {
      siteId,
      siteName: 'Site', // Would be fetched from Site entity
      month,
      year,
      rows,
      totalOpeningStock: 0,
      totalClosingStock: 0,
    };
  }

  // -------------------------------------------------------------------------
  // MUTATIONS
  // -------------------------------------------------------------------------

  @Mutation(() => Batch, { name: 'createCleanerFishBatch' })
  async createCleanerFishBatch(
    @Args('input') input: CreateCleanerBatchInput,
    @Args('tenantId') tenantId: string,
    @Args('userId') userId: string,
  ): Promise<Batch> {
    this.logger.log(`Creating cleaner fish batch for species: ${input.speciesId}`);

    const payload: CreateCleanerBatchPayload = {
      speciesId: input.speciesId,
      initialQuantity: input.initialQuantity,
      initialAvgWeightG: input.initialAvgWeightG,
      sourceType: input.sourceType as 'farmed' | 'wild_caught',
      sourceLocation: input.sourceLocation,
      supplierId: input.supplierId,
      stockedAt: new Date(input.stockedAt),
      purchaseCost: input.purchaseCost,
      currency: input.currency,
      notes: input.notes,
    };

    return this.commandBus.execute(
      new CreateCleanerBatchCommand(tenantId, payload, userId),
    );
  }

  @Mutation(() => Batch, { name: 'deployCleanerFish' })
  async deployCleanerFish(
    @Args('input') input: DeployCleanerFishInput,
    @Args('tenantId') tenantId: string,
    @Args('userId') userId: string,
  ): Promise<Batch> {
    this.logger.log(`Deploying cleaner fish from batch ${input.cleanerBatchId} to tank ${input.targetTankId}`);

    const payload: DeployCleanerFishPayload = {
      cleanerBatchId: input.cleanerBatchId,
      targetTankId: input.targetTankId,
      quantity: input.quantity,
      avgWeightG: input.avgWeightG,
      deployedAt: new Date(input.deployedAt),
      notes: input.notes,
    };

    return this.commandBus.execute(
      new DeployCleanerFishCommand(tenantId, payload, userId),
    );
  }

  @Mutation(() => Batch, { name: 'recordCleanerMortality' })
  async recordCleanerMortality(
    @Args('input') input: RecordCleanerMortalityInput,
    @Args('tenantId') tenantId: string,
    @Args('userId') userId: string,
  ): Promise<Batch> {
    this.logger.log(`Recording cleaner fish mortality for batch ${input.cleanerBatchId}`);

    const payload: RecordCleanerMortalityPayload = {
      cleanerBatchId: input.cleanerBatchId,
      tankId: input.tankId,
      quantity: input.quantity,
      reason: input.reason,
      detail: input.detail,
      observedAt: new Date(input.observedAt),
      notes: input.notes,
    };

    return this.commandBus.execute(
      new RecordCleanerMortalityCommand(tenantId, payload, userId),
    );
  }

  @Mutation(() => Batch, { name: 'transferCleanerFish' })
  async transferCleanerFish(
    @Args('input') input: TransferCleanerFishInput,
    @Args('tenantId') tenantId: string,
    @Args('userId') userId: string,
  ): Promise<Batch> {
    this.logger.log(`Transferring cleaner fish from tank ${input.sourceTankId} to ${input.destinationTankId}`);

    const payload: TransferCleanerFishPayload = {
      cleanerBatchId: input.cleanerBatchId,
      sourceTankId: input.sourceTankId,
      destinationTankId: input.destinationTankId,
      quantity: input.quantity,
      transferredAt: new Date(input.transferredAt),
      reason: input.reason,
      notes: input.notes,
    };

    return this.commandBus.execute(
      new TransferCleanerFishCommand(tenantId, payload, userId),
    );
  }

  @Mutation(() => Batch, { name: 'removeCleanerFish' })
  async removeCleanerFish(
    @Args('input') input: RemoveCleanerFishInput,
    @Args('tenantId') tenantId: string,
    @Args('userId') userId: string,
  ): Promise<Batch> {
    this.logger.log(`Removing cleaner fish from tank ${input.tankId}, reason: ${input.reason}`);

    const payload: RemoveCleanerFishPayload = {
      cleanerBatchId: input.cleanerBatchId,
      tankId: input.tankId,
      quantity: input.quantity,
      reason: input.reason as CleanerFishRemovalReason,
      removedAt: new Date(input.removedAt),
      avgWeightG: input.avgWeightG,
      notes: input.notes,
    };

    return this.commandBus.execute(
      new RemoveCleanerFishCommand(tenantId, payload, userId),
    );
  }
}
