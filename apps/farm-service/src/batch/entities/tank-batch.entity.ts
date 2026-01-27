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
  id: string;

  @Field()
  @Column('uuid')
  @Index()
  tenantId: string;

  // -------------------------------------------------------------------------
  // TANK İLİŞKİSİ
  // -------------------------------------------------------------------------

  @Field()
  @Column('uuid')
  @Index()
  tankId: string;

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

  @Field(() => Int, { nullable: true })
  @Column({ type: 'int', nullable: true })
  currentQuantity?: number;

  @Field(() => Float, { nullable: true })
  @Column({ type: 'decimal', precision: 15, scale: 2, nullable: true })
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
  totalQuantity: number;                     // Toplam adet

  @Field(() => Float)
  @Column({ type: 'decimal', precision: 10, scale: 2, default: 0 })
  avgWeightG: number;                        // Ortalama ağırlık (g)

  @Field(() => Float)
  @Column({ type: 'decimal', precision: 15, scale: 2, default: 0 })
  totalBiomassKg: number;                    // Toplam biomass (kg)

  @Field(() => Float)
  @Column({ type: 'decimal', precision: 10, scale: 2, default: 0 })
  densityKgM3: number;                       // Yoğunluk (kg/m³)

  // -------------------------------------------------------------------------
  // MİXED BATCH DETAYLARI
  // -------------------------------------------------------------------------

  @Field()
  @Column({ default: false })
  isMixedBatch: boolean;                     // Birden fazla batch var mı?

  @Field(() => GraphQLJSON, { nullable: true })
  @Column({ type: 'jsonb', nullable: true })
  batchDetails?: BatchDetail[];              // Mixed batch durumunda detaylar

  // -------------------------------------------------------------------------
  // CLEANER FISH TAKİBİ
  // -------------------------------------------------------------------------

  /**
   * Tanktaki cleaner fish toplam adedi
   * Production fish'lerden bağımsız takip edilir
   */
  @Field(() => Int, { nullable: true })
  @Column({ type: 'int', default: 0 })
  cleanerFishQuantity: number;

  /**
   * Tanktaki cleaner fish toplam biomass (kg)
   */
  @Field(() => Float, { nullable: true })
  @Column({ type: 'decimal', precision: 10, scale: 2, default: 0 })
  cleanerFishBiomassKg: number;

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
  @Column({ type: 'decimal', precision: 5, scale: 2, nullable: true })
  capacityUsedPercent?: number;              // Kapasite kullanım yüzdesi

  @Field()
  @Column({ default: false })
  isOverCapacity: boolean;                   // Kapasite aşıldı mı?

  // -------------------------------------------------------------------------
  // AUDIT FIELDS
  // -------------------------------------------------------------------------

  @Field()
  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @Field()
  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;

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
