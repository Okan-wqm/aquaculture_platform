/**
 * FeedingProgram Entity - Yemleme Programi
 *
 * Tank bazli yemleme programi yonetimi. Bir programa birden fazla
 * tank/pond/cage eklenebilir ve her biri icin ayri yemleme hesaplamasi yapilir.
 *
 * Ozellikler:
 * - Coklu tank destegi
 * - Agirlik araliklarina gore yem atamasi
 * - Opsiyonel FCR tablosu (Sicaklik x Agirlik)
 * - Otomatik yem gecisi
 * - Program durumu yonetimi
 * - Optimistic locking ile concurrent update korumasi
 * - Soft delete destegi
 *
 * @module Feeding
 */
import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  DeleteDateColumn,
  VersionColumn,
  Index,
  OneToMany,
  ManyToOne,
  JoinColumn,
} from 'typeorm';
import { ObjectType, Field, ID, Float, Int, registerEnumType } from '@nestjs/graphql';
import GraphQLJSON from 'graphql-type-json';
import {
  IsNotEmpty,
  IsUUID,
  IsString,
  IsOptional,
  IsEnum,
  IsDate,
  IsNumber,
  IsBoolean,
  MaxLength,
  Min,
  Max,
  ValidateNested,
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
} from 'class-validator';
import { Type } from 'class-transformer';

// ============================================================================
// CONSTANTS
// ============================================================================

/**
 * Maximum number of feed assignments allowed per program (DoS protection)
 */
export const MAX_FEED_ASSIGNMENTS = 50;

/**
 * Maximum number of temperatures in FCR table (DoS protection)
 */
export const MAX_FCR_TEMPERATURES = 20;

/**
 * Maximum number of weights in FCR table (DoS protection)
 */
export const MAX_FCR_WEIGHTS = 30;

// ============================================================================
// ENUMS
// ============================================================================

/**
 * Program durumu
 */
export enum FeedingProgramStatus {
  DRAFT = 'draft', // Taslak - henuz aktif degil
  ACTIVE = 'active', // Aktif - gunluk planlar olusturuluyor
  PAUSED = 'paused', // Duraklatilmis
  COMPLETED = 'completed', // Tamamlandi
  CANCELLED = 'cancelled', // Iptal edildi
}

registerEnumType(FeedingProgramStatus, {
  name: 'FeedingProgramStatus',
  description: 'Yemleme programi durumu',
});

/**
 * FCR kaynagi
 */
export enum FCRSource {
  PROGRAM = 'program', // Program'in kendi FCR tablosu
  FEED = 'feed', // Feed entity'sindeki fcrMatrix
}

registerEnumType(FCRSource, {
  name: 'FCRSource',
  description: 'FCR veri kaynagi',
});

/**
 * When the FCR-based weight growth from actual feeding is applied to the tank/
 * batch. The DAY-END TOTAL growth is identical either way (growth is linear in
 * feed); the mode only controls WHEN the avg-weight rolls up.
 */
export enum GrowthApplicationMode {
  /** Apply growth immediately on each recorded feeding (avg weight updates live). */
  PER_FEEDING = 'per_feeding',
  /** Hold back growth; a daily job rolls up the day's feed into one weight update. */
  DAILY = 'daily',
}

registerEnumType(GrowthApplicationMode, {
  name: 'GrowthApplicationMode',
  description: 'When FCR-based feeding growth is applied to the tank/batch',
});

// ============================================================================
// ERROR CLASSES
// ============================================================================

/**
 * Error thrown when JSONB validation fails
 */
export class InvalidJSONBStructureError extends Error {
  constructor(field: string, issues: string[]) {
    super(`Invalid ${field} structure: ${issues.join(', ')}`);
    this.name = 'InvalidJSONBStructureError';
  }
}

/**
 * Error thrown when weight is out of valid range
 */
export class WeightOutOfRangeError extends Error {
  constructor(weight: number, minWeight: number) {
    super(`Weight ${weight}g is below the minimum configured weight ${minWeight}g`);
    this.name = 'WeightOutOfRangeError';
  }
}

// ============================================================================
// INTERFACES & VALIDATION CLASSES
// ============================================================================

/**
 * Yem atamasi (agirlik araligina gore)
 */
export interface FeedAssignment {
  /** UUID of the feed */
  feedId: string;
  /** Feed code for display */
  feedCode: string;
  /** Feed name for display */
  feedName: string;
  /** Gram cinsinden minimum agirlik */
  minWeightG: number;
  /** Gram cinsinden maksimum agirlik */
  maxWeightG: number;
  /** Ortusme durumunda oncelik (1 = en yuksek) */
  priority: number;
  /** Optional notes about this assignment */
  notes?: string;
}

/**
 * Validates a FeedAssignment object at runtime
 * @param assignment - The feed assignment to validate
 * @returns Array of validation error messages
 */
export function validateFeedAssignment(assignment: unknown): string[] {
  const errors: string[] = [];

  if (!assignment || typeof assignment !== 'object') {
    errors.push('Feed assignment must be an object');
    return errors;
  }

  const a = assignment as Record<string, unknown>;

  // Required fields
  if (!a['feedId'] || typeof a['feedId'] !== 'string') {
    errors.push('feedId must be a non-empty string (UUID)');
  } else if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(a['feedId'])) {
    errors.push('feedId must be a valid UUID');
  }

  if (!a['feedCode'] || typeof a['feedCode'] !== 'string') {
    errors.push('feedCode must be a non-empty string');
  } else if (a['feedCode'].length > 50) {
    errors.push('feedCode must not exceed 50 characters');
  }

  if (!a['feedName'] || typeof a['feedName'] !== 'string') {
    errors.push('feedName must be a non-empty string');
  } else if (a['feedName'].length > 200) {
    errors.push('feedName must not exceed 200 characters');
  }

  if (typeof a['minWeightG'] !== 'number' || a['minWeightG'] < 0) {
    errors.push('minWeightG must be a non-negative number');
  }

  if (typeof a['maxWeightG'] !== 'number' || a['maxWeightG'] < 0) {
    errors.push('maxWeightG must be a non-negative number');
  }

  if (typeof a['minWeightG'] === 'number' && typeof a['maxWeightG'] === 'number') {
    if (a['minWeightG'] >= a['maxWeightG']) {
      errors.push('minWeightG must be less than maxWeightG');
    }
  }

  if (typeof a['priority'] !== 'number' || a['priority'] < 1 || a['priority'] > 100) {
    errors.push('priority must be a number between 1 and 100');
  }

  if (a['notes'] !== undefined && typeof a['notes'] !== 'string') {
    errors.push('notes must be a string if provided');
  }

  return errors;
}

/**
 * FCR Tablosu (Sicaklik x Agirlik matrisi)
 */
export interface FCRTable {
  /** Sicaklik degerleri (C) - orn: [15, 18, 21, 24] */
  temperatures: number[];
  /** Agirlik degerleri (g) - orn: [5, 20, 50, 100, 200] */
  weights: number[];
  /** 2D matris: fcrValues[tempIndex][weightIndex] */
  fcrValues: number[][];
  /** Temperature unit */
  temperatureUnit?: 'celsius' | 'fahrenheit';
  /** Weight unit */
  weightUnit?: 'gram' | 'kg';
  /** Optional notes */
  notes?: string;
}

/**
 * Validates an FCRTable object at runtime
 * @param table - The FCR table to validate
 * @returns Array of validation error messages
 */
export function validateFCRTable(table: unknown): string[] {
  const errors: string[] = [];

  if (!table || typeof table !== 'object') {
    errors.push('FCR table must be an object');
    return errors;
  }

  const t = table as Record<string, unknown>;

  // Temperatures validation
  if (!Array.isArray(t['temperatures'])) {
    errors.push('temperatures must be an array');
  } else {
    if (t['temperatures'].length === 0) {
      errors.push('temperatures array must not be empty');
    }
    if (t['temperatures'].length > MAX_FCR_TEMPERATURES) {
      errors.push(`temperatures array must not exceed ${MAX_FCR_TEMPERATURES} items`);
    }
    for (let i = 0; i < t['temperatures'].length; i++) {
      if (
        typeof t['temperatures'][i] !== 'number' ||
        t['temperatures'][i] < -10 ||
        t['temperatures'][i] > 50
      ) {
        errors.push(`temperatures[${i}] must be a number between -10 and 50`);
      }
    }
  }

  // Weights validation
  if (!Array.isArray(t['weights'])) {
    errors.push('weights must be an array');
  } else {
    if (t['weights'].length === 0) {
      errors.push('weights array must not be empty');
    }
    if (t['weights'].length > MAX_FCR_WEIGHTS) {
      errors.push(`weights array must not exceed ${MAX_FCR_WEIGHTS} items`);
    }
    for (let i = 0; i < t['weights'].length; i++) {
      if (typeof t['weights'][i] !== 'number' || t['weights'][i] < 0 || t['weights'][i] > 100000) {
        errors.push(`weights[${i}] must be a number between 0 and 100000`);
      }
    }
  }

  // FCR values validation
  if (!Array.isArray(t['fcrValues'])) {
    errors.push('fcrValues must be a 2D array');
  } else {
    const expectedRows = Array.isArray(t['temperatures']) ? t['temperatures'].length : 0;
    const expectedCols = Array.isArray(t['weights']) ? t['weights'].length : 0;

    if (t['fcrValues'].length !== expectedRows) {
      errors.push(`fcrValues must have ${expectedRows} rows (one per temperature)`);
    }

    for (let i = 0; i < t['fcrValues'].length; i++) {
      if (!Array.isArray(t['fcrValues'][i])) {
        errors.push(`fcrValues[${i}] must be an array`);
      } else if (t['fcrValues'][i].length !== expectedCols) {
        errors.push(`fcrValues[${i}] must have ${expectedCols} columns (one per weight)`);
      } else {
        for (let j = 0; j < t['fcrValues'][i].length; j++) {
          const val = t['fcrValues'][i][j];
          // 0 is allowed as it indicates an uncovered cell
          if (typeof val !== 'number' || val < 0 || val > 5) {
            errors.push(`fcrValues[${i}][${j}] must be a number between 0 and 5`);
          }
        }
      }
    }
  }

  // Optional fields validation
  if (
    t['temperatureUnit'] !== undefined &&
    !['celsius', 'fahrenheit'].includes(t['temperatureUnit'] as string)
  ) {
    errors.push('temperatureUnit must be "celsius" or "fahrenheit"');
  }

  if (t['weightUnit'] !== undefined && !['gram', 'kg'].includes(t['weightUnit'] as string)) {
    errors.push('weightUnit must be "gram" or "kg"');
  }

  if (t['notes'] !== undefined && typeof t['notes'] !== 'string') {
    errors.push('notes must be a string if provided');
  }

  return errors;
}

/**
 * Program ayarlari
 */
export interface ProgramSettings {
  /** Otomatik yem gecisi yapilsin mi? */
  autoTransition: boolean;
  /** Gecis esik degeri (gram) - orn: 0.5g */
  transitionBuffer: number;
  /** Geciste bildirim gonderilsin mi? */
  notifyOnTransition: boolean;
  /** FCR kaynagi */
  fcrSource: FCRSource;
  /** When FCR-based growth from feeding rolls up (defaults to PER_FEEDING). */
  growthApplicationMode?: GrowthApplicationMode;
  /** Varsayilan gunluk ogun sayisi */
  defaultMealsPerDay?: number;
  /** Minimum yemleme orani (%) */
  minFeedingRatePercent?: number;
  /** Maksimum yemleme orani (%) */
  maxFeedingRatePercent?: number;
}

/**
 * Validates a ProgramSettings object at runtime
 * @param settings - The program settings to validate
 * @returns Array of validation error messages
 */
export function validateProgramSettings(settings: unknown): string[] {
  const errors: string[] = [];

  if (!settings || typeof settings !== 'object') {
    errors.push('Program settings must be an object');
    return errors;
  }

  const s = settings as Record<string, unknown>;

  if (typeof s['autoTransition'] !== 'boolean') {
    errors.push('autoTransition must be a boolean');
  }

  if (
    typeof s['transitionBuffer'] !== 'number' ||
    s['transitionBuffer'] < 0 ||
    s['transitionBuffer'] > 100
  ) {
    errors.push('transitionBuffer must be a number between 0 and 100');
  }

  if (typeof s['notifyOnTransition'] !== 'boolean') {
    errors.push('notifyOnTransition must be a boolean');
  }

  if (!Object.values(FCRSource).includes(s['fcrSource'] as FCRSource)) {
    errors.push('fcrSource must be a valid FCRSource enum value');
  }

  if (
    s['growthApplicationMode'] !== undefined &&
    !Object.values(GrowthApplicationMode).includes(
      s['growthApplicationMode'] as GrowthApplicationMode,
    )
  ) {
    errors.push('growthApplicationMode must be a valid GrowthApplicationMode enum value');
  }

  if (s['defaultMealsPerDay'] !== undefined) {
    if (
      typeof s['defaultMealsPerDay'] !== 'number' ||
      s['defaultMealsPerDay'] < 1 ||
      s['defaultMealsPerDay'] > 24
    ) {
      errors.push('defaultMealsPerDay must be a number between 1 and 24');
    }
  }

  if (s['minFeedingRatePercent'] !== undefined) {
    if (
      typeof s['minFeedingRatePercent'] !== 'number' ||
      s['minFeedingRatePercent'] < 0 ||
      s['minFeedingRatePercent'] > 100
    ) {
      errors.push('minFeedingRatePercent must be a number between 0 and 100');
    }
  }

  if (s['maxFeedingRatePercent'] !== undefined) {
    if (
      typeof s['maxFeedingRatePercent'] !== 'number' ||
      s['maxFeedingRatePercent'] < 0 ||
      s['maxFeedingRatePercent'] > 100
    ) {
      errors.push('maxFeedingRatePercent must be a number between 0 and 100');
    }
  }

  if (
    typeof s['minFeedingRatePercent'] === 'number' &&
    typeof s['maxFeedingRatePercent'] === 'number' &&
    s['minFeedingRatePercent'] > s['maxFeedingRatePercent']
  ) {
    errors.push('minFeedingRatePercent must be less than or equal to maxFeedingRatePercent');
  }

  return errors;
}

import { DecimalTransformer } from '@aquaculture/backend-common/database';

// ============================================================================
// FORWARD DECLARATION FOR RELATION TYPE
// ============================================================================

// Import at runtime to avoid circular dependency
import type { FeedingProgramTank } from './feeding-program-tank.entity';

// ============================================================================
// ENTITY
// ============================================================================

/**
 * FeedingProgram Entity
 *
 * Represents a feeding program that manages feed assignments for tanks/ponds/cages.
 * Supports weight-based feed transitions, optional FCR tables, and program lifecycle management.
 *
 * Index hints for tenant isolation:
 * - Always filter by tenantId first in queries
 * - Use composite index (tenantId, status) for listing programs
 * - Use composite index (tenantId, code) for unique code lookups
 *
 * @example
 * ```typescript
 * // Service method with proper tenant isolation
 * async findByTenant(tenantId: string): Promise<FeedingProgram[]> {
 *   return this.repository.find({
 *     where: { tenantId, isDeleted: false },
 *     order: { createdAt: 'DESC' },
 *   });
 * }
 * ```
 */
@ObjectType()
@Entity('feeding_programs')
@Index(['tenantId', 'status'])
@Index(['tenantId', 'code'], { unique: true })
@Index(['tenantId', 'siteId'])
@Index(['tenantId', 'isDeleted'])
export class FeedingProgram {
  @Field(() => ID)
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /**
   * Tenant ID for multi-tenancy isolation.
   * All queries MUST filter by this field.
   */
  @Field()
  @Column('uuid')
  @Index()
  @IsUUID('4', { message: 'tenantId must be a valid UUID' })
  @IsNotEmpty({ message: 'tenantId is required' })
  tenantId!: string;

  /**
   * Site ID for site-level filtering.
   * Optional - programs can be tenant-wide or site-specific.
   */
  @Field({ nullable: true })
  @Column('uuid', { nullable: true })
  @Index()
  @IsOptional()
  @IsUUID('4', { message: 'siteId must be a valid UUID' })
  siteId?: string;

  // -------------------------------------------------------------------------
  // TEMEL BILGILER
  // -------------------------------------------------------------------------

  /**
   * Program name (human-readable)
   */
  @Field()
  @Column({ length: 200 })
  @IsNotEmpty({ message: 'name is required' })
  @IsString({ message: 'name must be a string' })
  @MaxLength(200, { message: 'name must not exceed 200 characters' })
  name!: string;

  /**
   * Unique program code within tenant - e.g., FP-2024-001
   */
  @Field()
  @Column({ length: 50 })
  @IsNotEmpty({ message: 'code is required' })
  @IsString({ message: 'code must be a string' })
  @MaxLength(50, { message: 'code must not exceed 50 characters' })
  code!: string;

  /**
   * Optional program description
   */
  @Field({ nullable: true })
  @Column({ type: 'text', nullable: true })
  @IsOptional()
  @IsString({ message: 'description must be a string' })
  @MaxLength(2000, { message: 'description must not exceed 2000 characters' })
  description?: string;

  // -------------------------------------------------------------------------
  // YEM ATAMALARI (Agirlik araliklari)
  // -------------------------------------------------------------------------

  /**
   * Feed assignments by weight range.
   * Validated at runtime using validateFeedAssignments() method.
   * Maximum 50 assignments allowed (DoS protection).
   */
  @Field(() => GraphQLJSON)
  @Column({ type: 'jsonb' })
  feedAssignments!: FeedAssignment[];

  // -------------------------------------------------------------------------
  // FCR TABLOSU (Opsiyonel)
  // -------------------------------------------------------------------------

  /**
   * Optional FCR lookup table (Temperature x Weight matrix).
   * Validated at runtime using validateFCRTable() method.
   */
  @Field(() => GraphQLJSON, { nullable: true })
  @Column({ type: 'jsonb', nullable: true })
  fcrTable?: FCRTable;

  // -------------------------------------------------------------------------
  // DURUM
  // -------------------------------------------------------------------------

  /**
   * Program status (draft, active, paused, completed, cancelled)
   */
  @Field(() => FeedingProgramStatus)
  @Column({
    type: 'enum',
    enum: FeedingProgramStatus,
    default: FeedingProgramStatus.DRAFT,
  })
  @Index()
  @IsEnum(FeedingProgramStatus, { message: 'status must be a valid FeedingProgramStatus' })
  status!: FeedingProgramStatus;

  /**
   * Program start date
   */
  @Field()
  @Column({ type: 'date' })
  @IsDate({ message: 'startDate must be a valid date' })
  startDate!: Date;

  /**
   * Optional program end date
   */
  @Field({ nullable: true })
  @Column({ type: 'date', nullable: true })
  @IsOptional()
  @IsDate({ message: 'endDate must be a valid date' })
  endDate?: Date;

  /**
   * Timestamp when program was paused (if status is PAUSED)
   */
  @Field({ nullable: true })
  @Column({ type: 'timestamptz', nullable: true })
  pausedAt?: Date;

  /**
   * Timestamp when program was last activated
   */
  @Field({ nullable: true })
  @Column({ type: 'timestamptz', nullable: true })
  activatedAt?: Date;

  /**
   * Timestamp when program was completed
   */
  @Field({ nullable: true })
  @Column({ type: 'timestamptz', nullable: true })
  completedAt?: Date;

  // -------------------------------------------------------------------------
  // AYARLAR
  // -------------------------------------------------------------------------

  /**
   * Program settings including FCR source, transition settings, etc.
   * Validated at runtime using validateProgramSettings() function.
   */
  @Field(() => GraphQLJSON)
  @Column({
    type: 'jsonb',
    default: {
      autoTransition: true,
      transitionBuffer: 0.5,
      notifyOnTransition: true,
      fcrSource: FCRSource.FEED,
      defaultMealsPerDay: 4,
    },
  })
  settings!: ProgramSettings;

  // -------------------------------------------------------------------------
  // ISTATISTIKLER (Runtime)
  // -------------------------------------------------------------------------

  /**
   * Number of tanks attached to this program
   */
  @Field(() => Int)
  @Column({ type: 'int', default: 0 })
  @IsNumber({}, { message: 'totalTanks must be a number' })
  @Min(0, { message: 'totalTanks must be at least 0' })
  @Max(10000, { message: 'totalTanks must not exceed 10000' })
  totalTanks!: number;

  /**
   * Total number of feed transitions across all tanks
   */
  @Field(() => Int)
  @Column({ type: 'int', default: 0 })
  @IsNumber({}, { message: 'totalFeedTransitions must be a number' })
  @Min(0, { message: 'totalFeedTransitions must be at least 0' })
  totalFeedTransitions!: number;

  /**
   * Total feed consumed in kg (nullable).
   * Uses transformer to ensure proper number type from PostgreSQL decimal.
   */
  @Field(() => Float, { nullable: true })
  @Column({
    type: 'decimal',
    precision: 15,
    scale: 2,
    nullable: true,
    transformer: new DecimalTransformer(),
  })
  @IsOptional()
  @IsNumber({}, { message: 'totalFeedConsumed must be a number' })
  @Min(0, { message: 'totalFeedConsumed must be at least 0' })
  totalFeedConsumed?: number;

  // -------------------------------------------------------------------------
  // KULLANICI BILGILERI (Foreign Key Relations)
  // -------------------------------------------------------------------------

  /**
   * User ID who created this program.
   * References users table in auth service.
   */
  @Field()
  @Column('uuid')
  @IsUUID('4', { message: 'createdBy must be a valid UUID' })
  @IsNotEmpty({ message: 'createdBy is required' })
  createdBy!: string;

  /**
   * User ID who last modified this program.
   * References users table in auth service.
   */
  @Field({ nullable: true })
  @Column('uuid', { nullable: true })
  @IsOptional()
  @IsUUID('4', { message: 'lastModifiedBy must be a valid UUID' })
  lastModifiedBy?: string;

  // -------------------------------------------------------------------------
  // AUDIT FIELDS
  // -------------------------------------------------------------------------

  /**
   * Record creation timestamp
   */
  @Field()
  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  /**
   * Record last update timestamp
   */
  @Field()
  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;

  /**
   * Soft delete timestamp (null if not deleted)
   */
  @Field({ nullable: true })
  @DeleteDateColumn({ type: 'timestamptz', nullable: true })
  deletedAt?: Date;

  /**
   * Soft delete flag for filtering
   */
  @Field()
  @Column({ default: false })
  @Index()
  isDeleted!: boolean;

  /**
   * User ID who deleted this program (soft delete)
   */
  @Field({ nullable: true })
  @Column('uuid', { nullable: true })
  @IsOptional()
  @IsUUID('4', { message: 'deletedBy must be a valid UUID' })
  deletedBy?: string;

  /**
   * Version column for optimistic locking.
   * Prevents concurrent update conflicts.
   */
  @VersionColumn()
  version!: number;

  // -------------------------------------------------------------------------
  // RELATIONS
  // -------------------------------------------------------------------------

  /**
   * Tanks/ponds/cages attached to this feeding program.
   * Properly typed OneToMany relation with cascade options.
   */
  @OneToMany('FeedingProgramTank', 'feedingProgram', {
    cascade: ['insert', 'update'],
    eager: false,
  })
  tanks?: FeedingProgramTank[];

  // -------------------------------------------------------------------------
  // BUSINESS METHODS
  // -------------------------------------------------------------------------

  /**
   * Checks if the program is currently active
   * @returns true if status is ACTIVE
   */
  isActive(): boolean {
    return this.status === FeedingProgramStatus.ACTIVE;
  }

  /**
   * Checks if the program can be edited
   * @returns true if status is DRAFT or PAUSED
   */
  isEditable(): boolean {
    return [FeedingProgramStatus.DRAFT, FeedingProgramStatus.PAUSED].includes(this.status);
  }

  /**
   * Activates the program and records activation timestamp
   */
  activate(): void {
    this.status = FeedingProgramStatus.ACTIVE;
    this.activatedAt = new Date();
    this.pausedAt = undefined;
  }

  /**
   * Pauses the program and records pause timestamp
   */
  pause(): void {
    this.status = FeedingProgramStatus.PAUSED;
    this.pausedAt = new Date();
  }

  /**
   * Completes the program and records completion timestamp
   */
  complete(): void {
    this.status = FeedingProgramStatus.COMPLETED;
    this.completedAt = new Date();
  }

  /**
   * Cancels the program
   */
  cancel(): void {
    this.status = FeedingProgramStatus.CANCELLED;
  }

  /**
   * Soft deletes the program
   * @param deletedBy - UUID of the user performing the deletion
   */
  softDelete(deletedBy?: string): void {
    this.isDeleted = true;
    this.deletedAt = new Date();
    this.deletedBy = deletedBy;
  }

  /**
   * Restores a soft-deleted program
   */
  restore(): void {
    this.isDeleted = false;
    this.deletedAt = undefined;
    this.deletedBy = undefined;
  }

  /**
   * Finds the appropriate feed assignment for a given weight.
   *
   * Logic:
   * 1. If weight is below the minimum configured weight, returns the first (lowest) assignment
   * 2. Sorts assignments by priority
   * 3. Finds the first assignment where weight falls within [minWeightG, maxWeightG)
   * 4. If weight exceeds all ranges, returns the last (highest) assignment
   *
   * @param avgWeightG - Average fish weight in grams
   * @returns The matching FeedAssignment or null if no assignments exist
   */
  findFeedForWeight(avgWeightG: number): FeedAssignment | null {
    if (!this.feedAssignments || this.feedAssignments.length === 0) {
      return null;
    }

    // Sort by minWeightG to find the minimum threshold
    const sortedByWeight = [...this.feedAssignments].sort((a, b) => a.minWeightG - b.minWeightG);

    // Handle weight below minimum - return the first/lowest assignment
    const lowestAssignment = sortedByWeight[0];
    if (lowestAssignment && avgWeightG < lowestAssignment.minWeightG) {
      return lowestAssignment;
    }

    // Sort by priority for normal lookup
    const sortedByPriority = [...this.feedAssignments].sort((a, b) => a.priority - b.priority);

    // Find the first assignment where weight falls within range
    for (const assignment of sortedByPriority) {
      if (avgWeightG >= assignment.minWeightG && avgWeightG < assignment.maxWeightG) {
        return assignment;
      }
    }

    // If weight exceeds all ranges, return the highest range assignment
    const lastAssignment = sortedByWeight[sortedByWeight.length - 1];
    if (lastAssignment && avgWeightG >= lastAssignment.maxWeightG) {
      return lastAssignment;
    }

    return null;
  }

  /**
   * Checks if a feed transition is approaching based on current weight
   *
   * @param avgWeightG - Current average fish weight in grams
   * @param bufferG - Optional override for transition buffer (defaults to settings.transitionBuffer)
   * @returns Object indicating if transition is approaching and details about the next feed
   */
  isTransitionApproaching(
    avgWeightG: number,
    bufferG?: number,
  ): { approaching: boolean; nextFeed?: FeedAssignment; remainingG?: number } {
    const buffer = bufferG ?? this.settings.transitionBuffer;
    const currentFeed = this.findFeedForWeight(avgWeightG);

    if (!currentFeed) {
      return { approaching: false };
    }

    const remainingG = currentFeed.maxWeightG - avgWeightG;

    if (remainingG <= buffer && remainingG > 0) {
      // Find the next feed (the one starting at current feed's maxWeightG)
      const nextFeed = this.findFeedForWeight(currentFeed.maxWeightG + 0.1);
      return {
        approaching: true,
        nextFeed: nextFeed || undefined,
        remainingG,
      };
    }

    return { approaching: false };
  }

  /**
   * Validates all feed assignments in this program.
   * Checks for:
   * - At least one assignment exists
   * - min < max for each assignment
   * - No gaps between weight ranges
   * - No overlapping ranges
   * - Maximum array size not exceeded
   * - Individual assignment validation
   *
   * @returns Object with valid flag and array of error messages
   */
  validateFeedAssignments(): { valid: boolean; errors: string[] } {
    const errors: string[] = [];

    if (!this.feedAssignments || this.feedAssignments.length === 0) {
      errors.push('En az bir yem atamasi gereklidir');
      return { valid: false, errors };
    }

    // Check max array size (DoS protection)
    if (this.feedAssignments.length > MAX_FEED_ASSIGNMENTS) {
      errors.push(`Maksimum ${MAX_FEED_ASSIGNMENTS} yem atamasi yapilabilir`);
    }

    // Validate individual assignments
    for (let i = 0; i < this.feedAssignments.length; i++) {
      const assignmentErrors = validateFeedAssignment(this.feedAssignments[i]);
      for (const err of assignmentErrors) {
        errors.push(`Yem atamasi [${i}]: ${err}`);
      }
    }

    // Sort by minWeightG for gap/overlap checks
    const sorted = [...this.feedAssignments].sort((a, b) => a.minWeightG - b.minWeightG);

    for (let i = 0; i < sorted.length; i++) {
      const current = sorted[i];
      if (!current) continue;

      // Min < Max check
      if (current.minWeightG >= current.maxWeightG) {
        errors.push(
          `${current.feedCode}: minWeight (${current.minWeightG}) >= maxWeight (${current.maxWeightG})`,
        );
      }

      // Gap check
      if (i > 0) {
        const prev = sorted[i - 1];
        if (prev && current.minWeightG > prev.maxWeightG) {
          errors.push(
            `Agirlik araliginda bosluk var: ${prev.maxWeightG}g - ${current.minWeightG}g`,
          );
        }
      }

      // Overlap check
      if (i > 0) {
        const prev = sorted[i - 1];
        if (prev && current.minWeightG < prev.maxWeightG) {
          errors.push(`Agirlik araliklari ortusyor: ${prev.feedCode} ve ${current.feedCode}`);
        }
      }
    }

    return { valid: errors.length === 0, errors };
  }

  /**
   * Validates the FCR table if present.
   * Checks:
   * - Temperature array exists and is valid
   * - Weight array exists and is valid
   * - FCR values matrix has correct dimensions
   * - All FCR values are within valid range (0-5)
   * - Maximum array sizes not exceeded
   *
   * @returns Object with valid flag and array of error messages
   */
  validateFCRTable(): { valid: boolean; errors: string[] } {
    if (!this.fcrTable) {
      return { valid: true, errors: [] }; // FCR table is optional
    }

    const errors = validateFCRTable(this.fcrTable);
    return { valid: errors.length === 0, errors };
  }

  /**
   * Validates the program settings.
   *
   * @returns Object with valid flag and array of error messages
   */
  validateSettings(): { valid: boolean; errors: string[] } {
    const errors = validateProgramSettings(this.settings);
    return { valid: errors.length === 0, errors };
  }

  /**
   * Performs full validation of all JSONB fields.
   * Should be called before saving the entity.
   *
   * @throws InvalidJSONBStructureError if any validation fails
   */
  validateAllJSONBFields(): void {
    const allErrors: string[] = [];

    const assignmentResult = this.validateFeedAssignments();
    if (!assignmentResult.valid) {
      allErrors.push(...assignmentResult.errors);
    }

    const fcrResult = this.validateFCRTable();
    if (!fcrResult.valid) {
      allErrors.push(...fcrResult.errors);
    }

    const settingsResult = this.validateSettings();
    if (!settingsResult.valid) {
      allErrors.push(...settingsResult.errors);
    }

    if (allErrors.length > 0) {
      throw new InvalidJSONBStructureError('FeedingProgram JSONB fields', allErrors);
    }
  }
}
