/**
 * DailyFeedingExecution Entity - Günlük Yemleme Çalıştırma
 *
 * Her tank için günlük yemleme planı ve gerçekleşen sonuçları takip eder.
 * FCR ile büyüme hesaplaması ve yem geçişi kontrolü yapılır.
 *
 * Özellikler:
 * - Tank başına günlük yemleme planı
 * - Planlanan vs gerçekleşen karşılaştırması
 * - FCR ile büyüme hesaplama
 * - Otomatik yem geçişi
 * - Sıcaklık ve çevresel koşul takibi
 *
 * @module Feeding
 */
import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
  ManyToOne,
  JoinColumn,
} from 'typeorm';
import { ObjectType, Field, ID, Float, Int, registerEnumType } from '@nestjs/graphql';
import GraphQLJSON from 'graphql-type-json';
import {
  IsUUID,
  IsNumber,
  IsString,
  IsOptional,
  Min,
  ValidateNested,
  IsEnum,
  MaxLength,
} from 'class-validator';
import { Type } from 'class-transformer';
import { FeedingProgram, InvalidJSONBStructureError } from './feeding-program.entity';
import { FeedingProgramTank, ProgramEquipmentType } from './feeding-program-tank.entity';
import { FCRSource } from './feeding-program.entity';
import { FeedingMethod } from './feeding-record.entity';

// Re-export for consumers who import from this file
export { InvalidJSONBStructureError };

// ============================================================================
// VALIDATION ERROR CLASSES
// ============================================================================

/**
 * Error thrown when attempting to record feeding on an invalid execution state
 */
export class InvalidExecutionStateError extends Error {
  constructor(currentStatus: ExecutionStatus) {
    super(
      `Cannot record feeding: execution is in '${currentStatus}' state. Only PLANNED or IN_PROGRESS executions can record feeding.`,
    );
    this.name = 'InvalidExecutionStateError';
  }
}

/**
 * Error thrown when division by zero would occur
 */
export class DivisionByZeroError extends Error {
  constructor(field: string) {
    super(`Cannot perform calculation: ${field} is zero, which would cause division by zero.`);
    this.name = 'DivisionByZeroError';
  }
}

// ============================================================================
// ENUMS
// ============================================================================

/**
 * Execution status for daily feeding
 *
 * @description
 * - PLANNED: Scheduled but not yet started
 * - IN_PROGRESS: Feeding is currently being performed
 * - COMPLETED: All feeding completed successfully
 * - SKIPPED: Feeding was skipped (reason required)
 * - PARTIAL: Some but not all feeding completed (e.g., equipment failure mid-feeding)
 */
export enum ExecutionStatus {
  /** Scheduled but not yet started */
  PLANNED = 'planned',
  /** Feeding is currently being performed */
  IN_PROGRESS = 'in_progress',
  /** All feeding completed successfully */
  COMPLETED = 'completed',
  /** Feeding was skipped (requires skipReason) */
  SKIPPED = 'skipped',
  /** Some but not all feeding completed - used when feeding is interrupted */
  PARTIAL = 'partial',
}

registerEnumType(ExecutionStatus, {
  name: 'ExecutionStatus',
  description: 'Günlük yemleme çalıştırma durumu',
});

// ============================================================================
// INTERFACES
// ============================================================================

/**
 * Hesaplanan değerler (günlük plan oluşturulurken)
 */
export interface ExecutionCalculation {
  // Tank başlangıç durumu
  avgWeightG: number; // Ortalama balık ağırlığı (g)
  fishCount: number; // Balık sayısı
  biomassKg: number; // Toplam biomass (kg)
  waterTempC: number; // Su sıcaklığı (°C)
  /** True if temperature is using default value because sensor reading was unavailable */
  usingDefaultTemperature?: boolean;

  // Aktif yem bilgisi
  activeFeedId: string;
  activeFeedCode: string;
  activeFeedName: string;
  feedingRatePercent: number; // Yemleme oranı (% biomass)

  // Hesaplanan yem miktarı
  plannedFeedKg: number; // biomassKg × feedingRatePercent / 100
  mealsPerDay: number; // Günlük öğün sayısı
  perMealKg: number; // Öğün başına yem (kg)

  // FCR bilgisi
  expectedFCR: number;
  fcrSource: FCRSource;

  // Geçiş uyarısı (opsiyonel)
  transitionWarning?: TransitionWarning;
}

/**
 * Yem geçiş uyarısı
 */
export interface TransitionWarning {
  currentRange: string; // "5-50g"
  nextRange: string; // "50-200g"
  nextFeedId: string;
  nextFeedCode: string;
  remainingGrams: number; // Kalan gram (50 - 45.2 = 4.8)
  estimatedDays: number; // Tahmini gün sayısı
}

/**
 * Gerçekleşen sonuçlar (operatör girişi sonrası)
 */
export interface ExecutionResult {
  // Verilen yem
  actualFeedGivenKg: number;
  variance: number; // actualFeedGivenKg - plannedFeedKg
  variancePercent: number;

  // FCR ile büyüme hesabı
  appliedFCR: number;
  calculatedGrowthKg: number; // actualFeedGivenKg / appliedFCR
  newBiomassKg: number; // biomassKg + calculatedGrowthKg
  newAvgWeightG: number; // newBiomassKg / fishCount × 1000

  // Yem geçişi
  feedTransitioned: boolean;
  newFeedId?: string;
  newFeedCode?: string;

  // Mortality (opsiyonel)
  mortalityCount?: number;
  mortalityBiomassKg?: number;
}

// ============================================================================
// ENTITY
// ============================================================================

@ObjectType({ description: 'Daily feeding execution record for a tank' })
@Entity('daily_feeding_executions')
@Index(['tenantId', 'executionDate'])
@Index(['tenantId', 'feedingProgramId', 'executionDate'])
@Index(['feedingProgramTankId', 'executionDate'], { unique: true })
@Index(['status', 'executionDate']) // Composite index for status-based queries
export class DailyFeedingExecution {
  @Field(() => ID)
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Field({ description: 'Tenant ID for multi-tenant isolation' })
  @Column('uuid')
  @Index()
  @IsUUID()
  @IsString()
  tenantId: string;

  // -------------------------------------------------------------------------
  // PROGRAM İLİŞKİLERİ
  // -------------------------------------------------------------------------

  @Field()
  @Column('uuid')
  @Index()
  feedingProgramId: string;

  @ManyToOne(() => FeedingProgram, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'feedingProgramId' })
  feedingProgram?: FeedingProgram;

  @Field()
  @Column('uuid')
  @Index()
  feedingProgramTankId: string;

  @ManyToOne(() => FeedingProgramTank, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'feedingProgramTankId' })
  feedingProgramTank?: FeedingProgramTank;

  // -------------------------------------------------------------------------
  // TARİH
  // -------------------------------------------------------------------------

  @Field()
  @Column({ type: 'date' })
  @Index()
  executionDate: Date;

  // -------------------------------------------------------------------------
  // TANK BİLGİSİ (Denormalized - hızlı erişim)
  // -------------------------------------------------------------------------

  @Field()
  @Column('uuid')
  equipmentId: string;

  @Field(() => ProgramEquipmentType)
  @Column({
    type: 'enum',
    enum: ProgramEquipmentType,
  })
  equipmentType: ProgramEquipmentType;

  @Field()
  @Column({ length: 200 })
  equipmentName: string;

  @Field()
  @Column({ length: 50 })
  equipmentCode: string;

  // -------------------------------------------------------------------------
  // HESAPLANAN DEĞERLER (Calculated Values)
  // -------------------------------------------------------------------------

  /**
   * Calculated values at plan creation time
   * Contains tank state, active feed info, planned amounts, and FCR data
   *
   * @remarks This field is required and must be populated during entity creation.
   * The default empty object is provided for database schema compatibility only.
   */
  @Field(() => GraphQLJSON, { description: 'Calculated execution parameters' })
  @Column({ type: 'jsonb', default: () => "'{}'" })
  calculations: ExecutionCalculation;

  // -------------------------------------------------------------------------
  // GERÇEKLEŞEN SONUÇLAR
  // -------------------------------------------------------------------------

  @Field(() => GraphQLJSON, { nullable: true })
  @Column({ type: 'jsonb', nullable: true })
  actualResults?: ExecutionResult;

  // -------------------------------------------------------------------------
  // DURUM
  // -------------------------------------------------------------------------

  @Field(() => ExecutionStatus)
  @Column({
    type: 'enum',
    enum: ExecutionStatus,
    default: ExecutionStatus.PLANNED,
  })
  @Index()
  status: ExecutionStatus;

  @Field({ nullable: true })
  @Column({ type: 'timestamptz', nullable: true })
  completedAt?: Date;

  /**
   * When this execution's FCR-based growth was rolled into the tank/batch weight.
   * PER_FEEDING programs set it inline at recording time; DAILY programs leave it
   * null until the daily roll-up job applies the aggregate growth (this is the
   * idempotency key that stops growth being applied twice).
   */
  @Field({ nullable: true })
  @Column({ type: 'timestamptz', nullable: true })
  growthAppliedAt?: Date;

  @Field({ nullable: true })
  @Column('uuid', { nullable: true })
  completedBy?: string;

  // -------------------------------------------------------------------------
  // FEEDER BİLGİSİ (Kim/ne ile yemleme yapıldı)
  // -------------------------------------------------------------------------

  @Field({ nullable: true, description: 'SubEquipment feeder ID (for automatic feeders)' })
  @Column('uuid', { nullable: true })
  feederEquipmentId?: string;

  @Field({ nullable: true, description: 'Denormalized feeder name for quick access' })
  @Column({ length: 100, nullable: true })
  feederName?: string;

  @Field(() => FeedingMethod, {
    nullable: true,
    description: 'Feeding method used (manual, automatic, etc.)',
  })
  @Column({
    type: 'enum',
    enum: FeedingMethod,
    nullable: true,
  })
  feedingMethod?: FeedingMethod;

  /**
   * Optional notes about the feeding execution
   * @maxLength 2000
   */
  @Field({ nullable: true, description: 'Optional notes about the feeding execution' })
  @Column({ type: 'varchar', length: 2000, nullable: true })
  @MaxLength(2000)
  @IsOptional()
  notes?: string;

  /**
   * Reason for skipping - required when status is SKIPPED
   * @maxLength 500
   */
  @Field({ nullable: true, description: 'Reason for skipping (required when status=SKIPPED)' })
  @Column({ type: 'varchar', length: 500, nullable: true })
  @MaxLength(500)
  @IsOptional()
  skipReason?: string;

  // -------------------------------------------------------------------------
  // AUDIT FIELDS
  // -------------------------------------------------------------------------

  /**
   * UUID of the user who created this execution record
   */
  @Field({ description: 'UUID of the user who created this record' })
  @Column('uuid')
  @IsUUID()
  createdBy: string;

  /**
   * UUID of the user who last modified this execution record
   */
  @Field({ nullable: true, description: 'UUID of the user who last modified this record' })
  @Column('uuid', { nullable: true })
  @IsUUID()
  @IsOptional()
  lastModifiedBy?: string;

  @Field({ description: 'Timestamp when the record was created' })
  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @Field({ description: 'Timestamp when the record was last updated' })
  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;

  // -------------------------------------------------------------------------
  // COMPUTED FIELDS (GraphQL exposed calculated properties)
  // -------------------------------------------------------------------------

  /**
   * Planned feed amount in kilograms
   * @returns The planned feed amount or 0 if calculations not available
   */
  @Field(() => Float, { description: 'Planned feed amount in kilograms' })
  get plannedFeedKg(): number {
    return this.calculations?.plannedFeedKg ?? 0;
  }

  /**
   * Actual feed given in kilograms
   * @returns The actual feed amount or null if not yet recorded
   */
  @Field(() => Float, { nullable: true, description: 'Actual feed given in kilograms' })
  get actualFeedKg(): number | null {
    return this.actualResults?.actualFeedGivenKg ?? null;
  }

  /**
   * Variance between actual and planned feed in kilograms
   * @returns The variance or null if not yet recorded
   */
  @Field(() => Float, {
    nullable: true,
    description: 'Variance between actual and planned feed (kg)',
  })
  get varianceKg(): number | null {
    return this.actualResults?.variance ?? null;
  }

  /**
   * Variance percentage between actual and planned feed
   * @returns The variance percentage or null if not yet recorded
   */
  @Field(() => Float, {
    nullable: true,
    description: 'Variance percentage between actual and planned feed',
  })
  get variancePercent(): number | null {
    return this.actualResults?.variancePercent ?? null;
  }

  /**
   * Whether there is a feed transition warning
   * @returns True if a transition warning exists
   */
  @Field(() => Boolean, { description: 'Whether there is a feed transition warning' })
  get hasTransitionWarning(): boolean {
    return !!this.calculations?.transitionWarning;
  }

  /**
   * Whether feed was transitioned during this execution
   * @returns True if feed was transitioned, false otherwise
   */
  @Field(() => Boolean, { description: 'Whether feed was transitioned during this execution' })
  get feedTransitioned(): boolean {
    return this.actualResults?.feedTransitioned ?? false;
  }

  // -------------------------------------------------------------------------
  // JSONB VALIDATION METHODS
  // -------------------------------------------------------------------------

  /**
   * Validates the ExecutionCalculation JSONB structure
   * @returns Array of validation issues, empty if valid
   */
  validateCalculations(): string[] {
    const issues: string[] = [];
    const calc = this.calculations;

    // Check if calculations is empty object (default) or missing required fields
    if (!calc || Object.keys(calc).length === 0) {
      return ['calculations is empty or not properly initialized'];
    }

    // Required numeric fields
    if (typeof calc.avgWeightG !== 'number' || calc.avgWeightG < 0) {
      issues.push('avgWeightG must be a non-negative number');
    }
    if (typeof calc.fishCount !== 'number' || calc.fishCount < 0) {
      issues.push('fishCount must be a non-negative number');
    }
    if (typeof calc.biomassKg !== 'number' || calc.biomassKg < 0) {
      issues.push('biomassKg must be a non-negative number');
    }
    if (typeof calc.waterTempC !== 'number') {
      issues.push('waterTempC must be a number');
    }
    if (typeof calc.feedingRatePercent !== 'number' || calc.feedingRatePercent < 0) {
      issues.push('feedingRatePercent must be a non-negative number');
    }
    if (typeof calc.plannedFeedKg !== 'number' || calc.plannedFeedKg < 0) {
      issues.push('plannedFeedKg must be a non-negative number');
    }
    if (typeof calc.mealsPerDay !== 'number' || calc.mealsPerDay < 1) {
      issues.push('mealsPerDay must be at least 1');
    }
    if (typeof calc.perMealKg !== 'number' || calc.perMealKg < 0) {
      issues.push('perMealKg must be a non-negative number');
    }
    if (typeof calc.expectedFCR !== 'number' || calc.expectedFCR < 0) {
      issues.push('expectedFCR must be a non-negative number');
    }

    // Required string fields
    if (typeof calc.activeFeedId !== 'string' || !calc.activeFeedId) {
      issues.push('activeFeedId must be a non-empty string');
    }
    if (typeof calc.activeFeedCode !== 'string' || !calc.activeFeedCode) {
      issues.push('activeFeedCode must be a non-empty string');
    }
    if (typeof calc.activeFeedName !== 'string' || !calc.activeFeedName) {
      issues.push('activeFeedName must be a non-empty string');
    }

    // Validate fcrSource enum
    if (!calc.fcrSource || !Object.values(FCRSource).includes(calc.fcrSource)) {
      issues.push('fcrSource must be a valid FCRSource enum value');
    }

    return issues;
  }

  /**
   * Validates the ExecutionResult JSONB structure
   * @returns Array of validation issues, empty if valid
   */
  validateActualResults(): string[] {
    const issues: string[] = [];
    const result = this.actualResults;

    if (!result) {
      return []; // actualResults is optional
    }

    // Required numeric fields
    if (typeof result.actualFeedGivenKg !== 'number' || result.actualFeedGivenKg < 0) {
      issues.push('actualFeedGivenKg must be a non-negative number');
    }
    if (typeof result.variance !== 'number') {
      issues.push('variance must be a number');
    }
    if (typeof result.variancePercent !== 'number') {
      issues.push('variancePercent must be a number');
    }
    if (typeof result.appliedFCR !== 'number' || result.appliedFCR <= 0) {
      issues.push('appliedFCR must be a positive number');
    }
    if (typeof result.calculatedGrowthKg !== 'number') {
      issues.push('calculatedGrowthKg must be a number');
    }
    if (typeof result.newBiomassKg !== 'number' || result.newBiomassKg < 0) {
      issues.push('newBiomassKg must be a non-negative number');
    }
    if (typeof result.newAvgWeightG !== 'number' || result.newAvgWeightG < 0) {
      issues.push('newAvgWeightG must be a non-negative number');
    }
    if (typeof result.feedTransitioned !== 'boolean') {
      issues.push('feedTransitioned must be a boolean');
    }

    // Optional fields validation
    if (
      result.mortalityCount !== undefined &&
      (typeof result.mortalityCount !== 'number' || result.mortalityCount < 0)
    ) {
      issues.push('mortalityCount must be a non-negative number if provided');
    }
    if (
      result.mortalityBiomassKg !== undefined &&
      (typeof result.mortalityBiomassKg !== 'number' || result.mortalityBiomassKg < 0)
    ) {
      issues.push('mortalityBiomassKg must be a non-negative number if provided');
    }

    return issues;
  }

  /**
   * Validates all JSONB structures and throws if invalid
   * @throws InvalidJSONBStructureError if validation fails
   */
  assertValidJSONBStructures(): void {
    const calculationsIssues = this.validateCalculations();
    if (calculationsIssues.length > 0) {
      throw new InvalidJSONBStructureError('calculations', calculationsIssues);
    }

    const resultsIssues = this.validateActualResults();
    if (resultsIssues.length > 0) {
      throw new InvalidJSONBStructureError('actualResults', resultsIssues);
    }
  }

  // -------------------------------------------------------------------------
  // BUSINESS METHODS
  // -------------------------------------------------------------------------

  /**
   * Check if the execution is completed
   * @returns True if status is COMPLETED
   */
  isCompleted(): boolean {
    return this.status === ExecutionStatus.COMPLETED;
  }

  /**
   * Check if the execution was skipped
   * @returns True if status is SKIPPED
   */
  isSkipped(): boolean {
    return this.status === ExecutionStatus.SKIPPED;
  }

  /**
   * Check if the execution is partially completed
   * @returns True if status is PARTIAL
   */
  isPartial(): boolean {
    return this.status === ExecutionStatus.PARTIAL;
  }

  /**
   * Check if feeding can be recorded for this execution
   * @returns True if status allows recording (PLANNED or IN_PROGRESS)
   */
  canRecordFeeding(): boolean {
    return [ExecutionStatus.PLANNED, ExecutionStatus.IN_PROGRESS].includes(this.status);
  }

  /**
   * Records actual feeding data and calculates growth metrics
   *
   * @param actualKg - Actual feed given in kilograms
   * @param fcr - Feed Conversion Ratio to apply
   * @param completedBy - UUID of the user completing the feeding
   * @param notes - Optional notes about the feeding
   * @param isPartial - If true, marks as PARTIAL instead of COMPLETED
   *
   * @throws InvalidExecutionStateError if feeding cannot be recorded in current state
   * @throws DivisionByZeroError if fcr is zero or fishCount is zero
   * @throws InvalidJSONBStructureError if calculations structure is invalid
   */
  recordActualFeeding(
    actualKg: number,
    fcr: number,
    completedBy: string,
    notes?: string,
    isPartial: boolean = false,
  ): void {
    // Validate state before mutation
    if (!this.canRecordFeeding()) {
      throw new InvalidExecutionStateError(this.status);
    }

    // Validate calculations structure
    const calcIssues = this.validateCalculations();
    if (calcIssues.length > 0) {
      throw new InvalidJSONBStructureError('calculations', calcIssues);
    }

    const { biomassKg, fishCount } = this.calculations;
    const plannedKg = this.calculations.plannedFeedKg;

    // Validate FCR to prevent division by zero
    if (fcr === 0) {
      throw new DivisionByZeroError('fcr (Feed Conversion Ratio)');
    }

    // Validate fishCount to prevent division by zero in average weight calculation
    if (fishCount === 0) {
      throw new DivisionByZeroError('fishCount');
    }

    // Growth calculation: feed given divided by FCR
    const growthKg = actualKg / fcr;
    const newBiomassKg = biomassKg + growthKg;
    const newAvgWeightG = (newBiomassKg / fishCount) * 1000;

    // Variance calculation with safe division
    // When plannedKg is 0 (fasting day), any actual feed is 100% overfeeding
    const variance = actualKg - plannedKg;
    const variancePercent = plannedKg > 0 ? (variance / plannedKg) * 100 : actualKg > 0 ? 100 : 0;

    this.actualResults = {
      actualFeedGivenKg: actualKg,
      variance,
      variancePercent,
      appliedFCR: fcr,
      calculatedGrowthKg: growthKg,
      newBiomassKg,
      newAvgWeightG,
      feedTransitioned: false,
    };

    // Set appropriate status based on isPartial flag
    this.status = isPartial ? ExecutionStatus.PARTIAL : ExecutionStatus.COMPLETED;
    this.completedAt = new Date();
    this.completedBy = completedBy;
    this.lastModifiedBy = completedBy;
    if (notes) {
      this.notes = notes;
    }
  }

  /**
   * Skip this feeding execution
   *
   * @param reason - Reason for skipping (required)
   * @param skippedBy - UUID of the user skipping the feeding
   *
   * @throws InvalidExecutionStateError if skipping is not allowed in current state
   */
  skip(reason: string, skippedBy: string): void {
    // Validate state before mutation
    if (!this.canRecordFeeding()) {
      throw new InvalidExecutionStateError(this.status);
    }

    this.status = ExecutionStatus.SKIPPED;
    this.skipReason = reason;
    this.completedAt = new Date();
    this.completedBy = skippedBy;
    this.lastModifiedBy = skippedBy;
  }

  /**
   * Mark that a feed transition occurred during this execution
   *
   * @param newFeedId - UUID of the new feed
   * @param newFeedCode - Code of the new feed
   */
  markFeedTransition(newFeedId: string, newFeedCode: string): void {
    if (this.actualResults) {
      this.actualResults.feedTransitioned = true;
      this.actualResults.newFeedId = newFeedId;
      this.actualResults.newFeedCode = newFeedCode;
    }
  }

  /**
   * Start the feeding execution (transition from PLANNED to IN_PROGRESS)
   *
   * @param startedBy - UUID of the user starting the feeding
   *
   * @throws InvalidExecutionStateError if not in PLANNED state
   */
  startFeeding(startedBy: string): void {
    if (this.status !== ExecutionStatus.PLANNED) {
      throw new InvalidExecutionStateError(this.status);
    }

    this.status = ExecutionStatus.IN_PROGRESS;
    this.lastModifiedBy = startedBy;
  }
}
