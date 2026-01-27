/**
 * FeedingRecord Entity - Günlük Yemleme Kayıtları
 *
 * Her yemleme olayının detaylı kaydı. Planlanan vs gerçekleşen
 * miktarları takip eder.
 *
 * Özellikler:
 * - Günlük/öğün bazında yemleme kaydı
 * - Planlanan vs gerçek karşılaştırması
 * - Çevresel koşullar (sıcaklık, DO)
 * - Balık davranışı gözlemleri
 * - Maliyet takibi
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
import {
  ObjectType,
  Field,
  ID,
  Float,
  Int,
  registerEnumType,
} from '@nestjs/graphql';
import GraphQLJSON from 'graphql-type-json';
// Note: Batch, Feed, and Tank are referenced via string in decorator to avoid circular dependency
// Type-only imports for TypeScript type checking
import type { Batch } from '../../batch/entities/batch.entity';
import type { Feed } from '../../feed/entities/feed.entity';
import type { Equipment } from '../../equipment/entities/equipment.entity';

// ============================================================================
// ENUMS
// ============================================================================

/**
 * Yemleme metodu
 */
export enum FeedingMethod {
  MANUAL = 'manual',               // Manuel (elle)
  AUTOMATIC = 'automatic',         // Otomatik yemleme sistemi
  DEMAND = 'demand',               // Talep bazlı (sensörlü)
  BROADCAST = 'broadcast',         // Yayılarak
  SPOT = 'spot',                   // Nokta besleme
}

registerEnumType(FeedingMethod, {
  name: 'FeedingMethod',
  description: 'Yemleme metodu',
});

/**
 * Balık iştahı
 */
export enum FishAppetite {
  EXCELLENT = 'excellent',         // Mükemmel (hızlı tüketim)
  GOOD = 'good',                   // İyi
  MODERATE = 'moderate',           // Orta
  POOR = 'poor',                   // Zayıf
  NONE = 'none',                   // Yemiyor
}

registerEnumType(FishAppetite, {
  name: 'FishAppetite',
  description: 'Balık iştahı',
});

// ============================================================================
// INTERFACES
// ============================================================================

/**
 * Çevresel koşullar (yemleme anında)
 */
export interface FeedingEnvironment {
  waterTemp?: number;              // °C
  dissolvedOxygen?: number;        // mg/L
  weather?: 'sunny' | 'cloudy' | 'rainy' | 'stormy';
  windLevel?: 'calm' | 'light' | 'moderate' | 'strong';
  visibility?: 'clear' | 'turbid' | 'very_turbid';
}

/**
 * Balık davranışı gözlemi
 */
export interface FishBehavior {
  appetite: FishAppetite;
  feedingIntensity: number;        // 1-10 arası
  surfaceActivity?: 'normal' | 'high' | 'low' | 'none';
  schoolingBehavior?: 'normal' | 'scattered' | 'tight';
  abnormalBehavior?: string;
}

// ============================================================================
// ENTITY
// ============================================================================

@ObjectType()
@Entity('feeding_records')
@Index(['tenantId', 'batchId', 'feedingDate'])
@Index(['tenantId', 'tankId', 'feedingDate'])
@Index(['tenantId', 'feedingDate'])
@Index(['batchId', 'feedingDate', 'feedingSequence'])
export class FeedingRecord {
  @Field(() => ID)
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Field()
  @Column('uuid')
  @Index()
  tenantId: string;

  // -------------------------------------------------------------------------
  // BATCH İLİŞKİSİ
  // -------------------------------------------------------------------------

  @Field()
  @Column('uuid')
  @Index()
  batchId: string;

  @ManyToOne('Batch', { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'batchId' })
  batch?: Batch;

  // -------------------------------------------------------------------------
  // LOKASYON
  // -------------------------------------------------------------------------

  @Field({ nullable: true })
  @Column('uuid', { nullable: true })
  @Index()
  tankId?: string;

  @ManyToOne('Tank', { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'tankId' })
  tank?: Equipment;

  @Field({ nullable: true })
  @Column('uuid', { nullable: true })
  pondId?: string;

  @Field({ nullable: true })
  @Column('uuid', { nullable: true })
  batchLocationId?: string;        // İlgili BatchLocation

  // -------------------------------------------------------------------------
  // YEMLEME BİLGİLERİ
  // -------------------------------------------------------------------------

  @Field()
  @Column({ type: 'date' })
  @Index()
  feedingDate: Date;

  @Field()
  @Column({ length: 10 })
  feedingTime: string;             // "08:00", "12:00", etc.

  @Field(() => Int)
  @Column({ type: 'int', default: 1 })
  feedingSequence: number;         // Günün kaçıncı öğünü (1, 2, 3...)

  @Field(() => Int)
  @Column({ type: 'int', default: 1 })
  totalMealsToday: number;         // Bugün toplam kaç öğün

  // -------------------------------------------------------------------------
  // FEED İLİŞKİSİ
  // -------------------------------------------------------------------------

  @Field()
  @Column('uuid')
  feedId: string;

  @ManyToOne('Feed', { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'feedId' })
  feed?: Feed;

  @Field({ nullable: true })
  @Column({ length: 100, nullable: true })
  feedBatchNumber?: string;        // Yem parti numarası (traceability)

  // -------------------------------------------------------------------------
  // MİKTARLAR
  // -------------------------------------------------------------------------

  @Field(() => Float)
  @Column({ type: 'decimal', precision: 10, scale: 3 })
  plannedAmount: number;           // Planlanan miktar (kg)

  @Field(() => Float)
  @Column({ type: 'decimal', precision: 10, scale: 3 })
  actualAmount: number;            // Gerçek verilen miktar (kg)

  @Field(() => Float)
  @Column({ type: 'decimal', precision: 10, scale: 3, default: 0 })
  variance: number;                // Fark (actual - planned)

  @Field(() => Float)
  @Column({ type: 'decimal', precision: 5, scale: 2, default: 0 })
  variancePercent: number;         // Fark yüzdesi

  @Field(() => Float, { nullable: true })
  @Column({ type: 'decimal', precision: 10, scale: 3, nullable: true })
  wasteAmount?: number;            // Yenilmeyen/atık miktar (kg)

  // -------------------------------------------------------------------------
  // ÇEVRESEL KOŞULLAR
  // -------------------------------------------------------------------------

  @Field(() => GraphQLJSON, { nullable: true })
  @Column({ type: 'jsonb', nullable: true })
  environment?: FeedingEnvironment;

  // -------------------------------------------------------------------------
  // BALIK DAVRANIŞI
  // -------------------------------------------------------------------------

  @Field(() => GraphQLJSON, { nullable: true })
  @Column({ type: 'jsonb', nullable: true })
  fishBehavior?: FishBehavior;

  // -------------------------------------------------------------------------
  // YEMLEME DETAYLARI
  // -------------------------------------------------------------------------

  @Field(() => FeedingMethod)
  @Column({
    type: 'enum',
    enum: FeedingMethod,
    default: FeedingMethod.MANUAL,
  })
  feedingMethod: FeedingMethod;

  @Field({ nullable: true })
  @Column('uuid', { nullable: true })
  equipmentId?: string;            // Kullanılan ekipman (otomatik ise)

  @Field(() => Int, { nullable: true })
  @Column({ type: 'int', nullable: true })
  feedingDurationMinutes?: number; // Yemleme süresi

  // -------------------------------------------------------------------------
  // MALİYET
  // -------------------------------------------------------------------------

  @Field(() => Float, { nullable: true })
  @Column({ type: 'decimal', precision: 15, scale: 2, nullable: true })
  feedCost?: number;               // Yem maliyeti (TL)

  @Field({ nullable: true })
  @Column({ length: 3, nullable: true })
  currency?: string;

  // -------------------------------------------------------------------------
  // KULLANICI BİLGİLERİ
  // -------------------------------------------------------------------------

  @Field()
  @Column('uuid')
  fedBy: string;                   // Yemlemeyi yapan kullanıcı

  @Field({ nullable: true })
  @Column('uuid', { nullable: true })
  verifiedBy?: string;             // Doğrulayan (varsa)

  @Field({ nullable: true })
  @Column({ type: 'timestamptz', nullable: true })
  verifiedAt?: Date;

  // -------------------------------------------------------------------------
  // NOTLAR
  // -------------------------------------------------------------------------

  @Field({ nullable: true })
  @Column({ type: 'text', nullable: true })
  notes?: string;

  @Field({ nullable: true })
  @Column({ type: 'text', nullable: true })
  skipReason?: string;             // Yemleme atlandıysa neden

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
   * Yemleme varyansını hesaplar
   */
  calculateVariance(): void {
    this.variance = Number(this.actualAmount) - Number(this.plannedAmount);
    if (this.plannedAmount > 0) {
      this.variancePercent = (this.variance / Number(this.plannedAmount)) * 100;
    }
  }

  /**
   * Yemleme planın altında mı?
   */
  isBelowPlan(): boolean {
    return this.variance < 0;
  }

  /**
   * Yemleme planın üstünde mi?
   */
  isAbovePlan(): boolean {
    return this.variance > 0;
  }

  /**
   * Varyans kabul edilebilir aralıkta mı? (default ±10%)
   */
  isVarianceAcceptable(threshold: number = 10): boolean {
    return Math.abs(this.variancePercent) <= threshold;
  }

  /**
   * Balık iştahı iyi mi?
   */
  hasGoodAppetite(): boolean {
    return [FishAppetite.EXCELLENT, FishAppetite.GOOD].includes(
      this.fishBehavior?.appetite || FishAppetite.MODERATE,
    );
  }

  /**
   * Çevresel koşullar yemleme için uygun mu?
   */
  hasOptimalConditions(minDO: number = 5): boolean {
    if (!this.environment) return true;

    // Düşük oksijen kontrolü
    if (this.environment.dissolvedOxygen && this.environment.dissolvedOxygen < minDO) {
      return false;
    }

    // Fırtına kontrolü
    if (this.environment.weather === 'stormy') {
      return false;
    }

    return true;
  }
}
