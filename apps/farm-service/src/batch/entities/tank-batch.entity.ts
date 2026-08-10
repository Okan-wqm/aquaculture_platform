/**
 * TankBatch Entity - Tank Güncel Batch Durumu
 *
 * Her tank'ın mevcut batch durumunu gösterir (snapshot).
 * Bir tank'ta birden fazla batch olabilir (mixed batch).
 *
 * Özellikler:
 * - Gerçek zamanlı tank durumu
 * - Mixed batch desteği (batch_details JSONB)
 * - Yoğunluk ve kapasite takibi
 *
 * @module Batch
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
import { DecimalTransformer } from '@aquaculture/backend-common/database';
import {
  ObjectType,
  Field,
  ID,
  Float,
  Int,
} from '@nestjs/graphql';
import GraphQLJSON from 'graphql-type-json';
import { Batch } from './batch.entity';
// Note: Tank is referenced via string to avoid circular dependency
// Type-only import for TypeScript type checking
import type { Equipment } from '../../equipment/entities/equipment.entity';

// ============================================================================
// INTERFACES
// ============================================================================

/**
 * Mixed batch durumunda her batch'in detayları
 */
export interface BatchDetail {
  batchId: string;
  batchNumber: string;
  quantity: number;
  avgWeightG: number;
  biomassKg: number;
  percentageOfTank: number;          // Tank içindeki yüzde
}

/**
 * Provenance of the tank's CURRENT `avgWeightG` / `totalBiomassKg`.
 *
 * WHY: until this column existed, a tank weight that the FCR model PROJECTED
 * (`biomass += fedKg / assumedFCR`) and a tank weight that somebody actually
 * WEIGHED were byte-identical in the database. Nothing downstream could tell
 * an invented number from a measured one, so nobody could compute how wrong
 * the projection was — the model drifted forever with no feedback signal.
 *
 * WHAT: a discriminated union stamped by the single TankBatch growth writer
 * (`BiomassGrowthApplierService`). The `measurement` arm additionally carries
 * the projected value it superseded and the resulting projection error, so
 * "how far off was the model since the last weighing?" is a stored fact, not
 * a derivation nobody can perform.
 *
 * The union tag is required by the writer's parameter type, so an untagged
 * (provenance-less) growth write cannot be expressed.
 */
export type TankWeightProvenance =
  | {
      source: 'fcr_projection';
      /** ISO timestamp of the write that produced the current aggregates. */
      at: string;
      /** FCR the growth was divided by (`growthKg = fedKg / basedOnFcr`). */
      basedOnFcr: number;
    }
  | {
      source: 'measurement';
      /** ISO timestamp of the write that produced the current aggregates. */
      at: string;
      measurementId: string;
      sampleSize: number;
      confidencePercent: number;
      /** Tank average weight (g) asserted by the weighing. */
      measuredAvgWeightG: number;
      /** Tank average weight (g) the FCR projection had reached just before this weighing re-based it. */
      supersededProjectedAvgWeightG: number;
      /** (measured − projected) / projected × 100. Positive = fish heavier than the model believed. */
      projectionErrorPercent: number;
    };

/**
 * Cleaner fish detayları - Aynı tankta birden fazla cleaner fish batch olabilir
 */
export interface CleanerFishDetail {
  batchId: string;
  batchNumber: string;
  speciesId: string;
  speciesName: string;               // Lumpfish, Ballan Wrasse, etc.
  quantity: number;
  initialQuantity?: number;          // Tanka ilk yerleştirildiğindeki miktar
  avgWeightG: number;
  biomassKg: number;
  sourceType: 'farmed' | 'wild_caught';
  deployedAt: Date;
  totalMortality?: number;           // Bu batch'in bu tanktaki toplam mortality
  mortalityRate?: number;            // Mortality oranı (%)
  lastMortalityAt?: Date;            // Son mortality kaydı
}

// ============================================================================
// ENTITY
// ============================================================================

@ObjectType()
@Entity('tank_batches')
@Index(['tenantId', 'tankId'], { unique: true })
@Index(['tenantId', 'primaryBatchId'])
export class TankBatch {
  @Field(() => ID)
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Field()
  @Column('uuid')
  @Index()
  tenantId!: string;

  // -------------------------------------------------------------------------
  // TANK İLİŞKİSİ
  // -------------------------------------------------------------------------

  @Field()
  @Column('uuid')
  @Index()
  tankId!: string;

  @ManyToOne('Tank', { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'tankId' })
  tank?: Equipment;

  // Denormalized tank name for quick access
  @Field({ nullable: true })
  @Column({ length: 255, nullable: true })
  tankName?: string;

  @Field({ nullable: true })
  @Column({ length: 50, nullable: true })
  tankCode?: string;

  // -------------------------------------------------------------------------
  // STOK BİLGİLERİ (EKLENEN)
  // -------------------------------------------------------------------------
  // NOTE: the former `currentQuantity` COUNT mirror is RETIRED (ORPHAN-HIGH-353
  // step 3, DropTankBatchCurrentQuantityMirror) — the fish count is the
  // batchDetails-derived `totalQuantity` SSoT. `currentBiomassKg` remains: it is
  // the growth-tracked live biomass (feeding accrues weight-gain into it), NOT a
  // count-style mirror; guarded by farm-tank-count-ssot.spec's asymmetry check.

  @Field(() => Float, { nullable: true })
  @Column({ type: 'decimal', precision: 15, scale: 2, nullable: true, transformer: new DecimalTransformer() })
  currentBiomassKg?: number;

  // -------------------------------------------------------------------------
  // PRIMARY BATCH (Ana batch - tek batch durumunda)
  // -------------------------------------------------------------------------

  @Field({ nullable: true })
  @Column('uuid', { nullable: true })
  primaryBatchId?: string;

  @ManyToOne('Batch', { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'primaryBatchId' })
  primaryBatch?: Batch;

  // Denormalized batch number for quick access
  @Field({ nullable: true })
  @Column({ length: 50, nullable: true })
  primaryBatchNumber?: string;

  // -------------------------------------------------------------------------
  // STOK BİLGİLERİ
  // -------------------------------------------------------------------------

  @Field(() => Int)
  @Column({ type: 'int', default: 0 })
  totalQuantity!: number;                     // Toplam adet

  @Field(() => Float)
  @Column({ type: 'decimal', precision: 10, scale: 2, default: 0, transformer: new DecimalTransformer() })
  avgWeightG!: number;                        // Ortalama ağırlık (g)

  @Field(() => Float)
  @Column({ type: 'decimal', precision: 15, scale: 2, default: 0, transformer: new DecimalTransformer() })
  totalBiomassKg!: number;                    // Toplam biomass (kg)

  @Field(() => Float)
  @Column({ type: 'decimal', precision: 10, scale: 2, default: 0, transformer: new DecimalTransformer() })
  densityKgM3!: number;                       // Yoğunluk (kg/m³)

  // -------------------------------------------------------------------------
  // MİXED BATCH DETAYLARI
  // -------------------------------------------------------------------------

  @Field()
  @Column({ default: false })
  isMixedBatch!: boolean;                     // Birden fazla batch var mı?

  @Field(() => GraphQLJSON, { nullable: true })
  @Column({ type: 'jsonb', nullable: true })
  batchDetails?: BatchDetail[];              // Mixed batch durumunda detaylar

  // -------------------------------------------------------------------------
  // AĞIRLIK PROVENANSI
  // -------------------------------------------------------------------------

  /**
   * Where the current `avgWeightG` / `totalBiomassKg` came from — projected by
   * the FCR model or asserted by a weighing. Written ONLY by
   * `BiomassGrowthApplierService` (the single growth writer); nullable because
   * rows written before this column existed carry no provenance and must not be
   * retro-labelled with a source nobody recorded.
   *
   * @see TankWeightProvenance
   */
  @Field(() => GraphQLJSON, { nullable: true })
  @Column({ type: 'jsonb', nullable: true })
  weightProvenance?: TankWeightProvenance;

  // -------------------------------------------------------------------------
  // CLEANER FISH TAKİBİ
  // -------------------------------------------------------------------------

  /**
   * Tanktaki cleaner fish toplam adedi
   * Production fish'lerden bağımsız takip edilir
   */
  @Field(() => Int, { nullable: true })
  @Column({ type: 'int', default: 0 })
  cleanerFishQuantity!: number;

  /**
   * Tanktaki cleaner fish toplam biomass (kg)
   */
  @Field(() => Float, { nullable: true })
  @Column({ type: 'decimal', precision: 10, scale: 2, default: 0, transformer: new DecimalTransformer() })
  cleanerFishBiomassKg!: number;

  /**
   * Cleaner fish detayları - her batch için ayrı kayıt
   * Bir tankta birden fazla cleaner fish batch olabilir
   */
  @Field(() => GraphQLJSON, { nullable: true })
  @Column({ type: 'jsonb', nullable: true })
  cleanerFishDetails?: CleanerFishDetail[];

  // -------------------------------------------------------------------------
  // SON OPERASYONLAR
  // -------------------------------------------------------------------------

  @Field({ nullable: true })
  @Column({ type: 'timestamptz', nullable: true })
  lastFeedingAt?: Date;

  @Field({ nullable: true })
  @Column({ type: 'timestamptz', nullable: true })
  lastSamplingAt?: Date;

  @Field({ nullable: true })
  @Column({ type: 'timestamptz', nullable: true })
  lastMortalityAt?: Date;

  // -------------------------------------------------------------------------
  // KAPASİTE DURUMU
  // -------------------------------------------------------------------------

  @Field(() => Float, { nullable: true })
  @Column({ type: 'decimal', precision: 5, scale: 2, nullable: true, transformer: new DecimalTransformer() })
  capacityUsedPercent?: number;              // Kapasite kullanım yüzdesi

  @Field()
  @Column({ default: false })
  isOverCapacity!: boolean;                   // Kapasite aşıldı mı?

  // -------------------------------------------------------------------------
  // AUDIT FIELDS
  // -------------------------------------------------------------------------

  @Field()
  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @Field()
  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;

  // -------------------------------------------------------------------------
  // BUSINESS METHODS
  // -------------------------------------------------------------------------

  /**
   * Yoğunluğu hesaplar
   */
  calculateDensity(tankVolumeM3: number): number {
    if (!tankVolumeM3 || tankVolumeM3 <= 0) return 0;
    return this.totalBiomassKg / tankVolumeM3;
  }

  /**
   * Tank boş mu?
   */
  isEmpty(): boolean {
    return this.totalQuantity === 0;
  }

  /**
   * Tank'a yeni batch eklenebilir mi?
   */
  canAddBatch(maxDensity: number, tankVolumeM3: number): boolean {
    return this.densityKgM3 < maxDensity;
  }

  /**
   * Tankta cleaner fish var mı?
   */
  hasCleanerFish(): boolean {
    return this.cleanerFishQuantity > 0;
  }

  /**
   * Toplam biomass (production + cleaner fish)
   */
  getTotalBiomassIncludingCleanerFish(): number {
    return Number(this.totalBiomassKg || 0) + Number(this.cleanerFishBiomassKg || 0);
  }

  /**
   * Cleaner fish oranı (cleaner fish / production fish)
   */
  getCleanerFishRatio(): number {
    if (this.totalQuantity <= 0) return 0;
    return (this.cleanerFishQuantity || 0) / this.totalQuantity;
  }
}
