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
import { DecimalTransformer } from '@aquaculture/backend-common/database';
import { DecimalScalar } from '@aquaculture/backend-common/graphql';
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
  id!: string;

  @Field()
  @Column('uuid')
  @Index()
  tenantId!: string;

  // -------------------------------------------------------------------------
  // BATCH İLİŞKİSİ
  // -------------------------------------------------------------------------

  @Field()
  @Column('uuid')
  @Index()
  batchId!: string;

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
  feedingDate!: Date;

  // WHY VARCHAR(10) instead of PostgreSQL TIME: The feedingTime field stores
  // user-entered schedule labels like "08:00" and "12:00". It intentionally
  // uses VARCHAR because: (1) the mobile app sends time as a formatted string,
  // (2) the value is used primarily for display and grouping, not for
  // database-level time arithmetic, and (3) TIME type would require timezone
  // handling that adds complexity without benefit for meal scheduling.
  // A future migration to TIME is possible if DB-level time comparisons become needed.
  @Field()
  @Column({ length: 10 })
  feedingTime!: string;

  @Field(() => Int)
  @Column({ type: 'int', default: 1 })
  feedingSequence!: number;         // Günün kaçıncı öğünü (1, 2, 3...)

  @Field(() => Int)
  @Column({ type: 'int', default: 1 })
  totalMealsToday!: number;         // Bugün toplam kaç öğün

  // -------------------------------------------------------------------------
  // FEED İLİŞKİSİ
  // -------------------------------------------------------------------------

  @Field()
  @Column('uuid')
  feedId!: string;

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
  @Column({ type: 'decimal', precision: 10, scale: 3, transformer: new DecimalTransformer() })
  plannedAmount!: number;           // Planlanan miktar (kg)

  @Field(() => Float)
  @Column({ type: 'decimal', precision: 10, scale: 3, transformer: new DecimalTransformer() })
  actualAmount!: number;            // Gerçek verilen miktar (kg)

  @Field(() => Float)
  @Column({ type: 'decimal', precision: 10, scale: 3, default: 0, transformer: new DecimalTransformer() })
  variance!: number;                // Fark (actual - planned)

  @Field(() => Float)
  @Column({ type: 'decimal', precision: 5, scale: 2, default: 0, transformer: new DecimalTransformer() })
  variancePercent!: number;         // Fark yüzdesi

  @Field(() => Float, { nullable: true })
  @Column({ type: 'decimal', precision: 10, scale: 3, nullable: true, transformer: new DecimalTransformer() })
  wasteAmount?: number;            // Yenilmeyen/atık miktar (kg)

  // -------------------------------------------------------------------------
  // ÖĞÜN MOTORU v2 BAĞLARI (Faz 5 — soft ref'ler, FK yok [K-16])
  // Bir döküm = bir kayıt; tekillik (mealId, pourIndex) unique partial
  // indeksle YAPISAL (P-05). sourceExecutionId Faz 6 tarihsel backfill'inin
  // idempotency anahtarıdır.
  // -------------------------------------------------------------------------

  @Field(() => ID, { nullable: true })
  @Column('uuid', { nullable: true })
  mealId?: string;

  @Field(() => Int, { nullable: true })
  @Column({ type: 'int', nullable: true })
  pourIndex?: number;

  @Field(() => ID, { nullable: true })
  @Column('uuid', { nullable: true })
  dayPlanId?: string;

  @Column('uuid', { nullable: true })
  sourceExecutionId?: string;

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
  feedingMethod!: FeedingMethod;

  @Field({ nullable: true })
  @Column('uuid', { nullable: true })
  equipmentId?: string;            // Kullanılan ekipman (otomatik ise)

  @Field(() => Int, { nullable: true })
  @Column({ type: 'int', nullable: true })
  feedingDurationMinutes?: number; // Yemleme süresi

  // -------------------------------------------------------------------------
  // MALİYET
  // -------------------------------------------------------------------------

  @Field(() => Float, {
    nullable: true,
    deprecationReason: 'Use feedCostDecimal (exact decimal string, ADR-0004).',
  })
  @Column({ type: 'decimal', precision: 15, scale: 2, nullable: true, transformer: new DecimalTransformer() })
  feedCost?: number;               // Yem maliyeti (TL)

  /** Same value as `feedCost`, on the wire as an exact decimal string (ADR-0004 /
   *  DATA-MEDIUM-009). A getter (not a column) so TypeORM ignores it. */
  @Field(() => DecimalScalar, { nullable: true })
  get feedCostDecimal(): number | null {
    return this.feedCost ?? null;
  }

  @Field({ nullable: true })
  @Column({ length: 3, nullable: true })
  currency?: string;

  // -------------------------------------------------------------------------
  // KULLANICI BİLGİLERİ
  // -------------------------------------------------------------------------

  @Field()
  @Column('uuid')
  fedBy!: string;                   // Yemlemeyi yapan kullanıcı

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
  createdAt!: Date;

  @Field()
  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;

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
