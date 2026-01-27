/**
 * FeedingTable Entity - Yemleme Programı
 *
 * Her batch için otomatik hesaplanan veya manuel oluşturulan
 * günlük yemleme programı. FCR bazlı hesaplama yapar.
 *
 * Özellikler:
 * - FCR bazlı günlük yem miktarı hesaplama
 * - Sıcaklık düzeltmesi
 * - Version kontrolü (regeneration sonrası)
 * - Aktif/Superseded durumu
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
  VersionColumn,
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
// Note: Batch and Feed are referenced via string to avoid circular dependency
// Type-only imports for TypeScript type checking
import type { Batch } from '../../batch/entities/batch.entity';
import type { Feed } from '../../feed/entities/feed.entity';

// ============================================================================
// ENUMS
// ============================================================================

/**
 * Yemleme tablosu durumu
 */
export enum FeedingTableStatus {
  DRAFT = 'draft',                 // Taslak
  ACTIVE = 'active',               // Aktif
  SUPERSEDED = 'superseded',       // Yeni version ile değiştirildi
  ARCHIVED = 'archived',           // Arşivlendi
}

registerEnumType(FeedingTableStatus, {
  name: 'FeedingTableStatus',
  description: 'Yemleme tablosu durumu',
});

/**
 * Hesaplama metodu
 */
export enum CalculationMethod {
  FCR_BASED = 'fcr_based',         // FCR bazlı hesaplama
  BODY_WEIGHT_PERCENT = 'body_weight_percent', // % vücut ağırlığı
  FIXED_AMOUNT = 'fixed_amount',   // Sabit miktar
  MANUAL = 'manual',               // Manuel giriş
}

registerEnumType(CalculationMethod, {
  name: 'CalculationMethod',
  description: 'Hesaplama metodu',
});

// ============================================================================
// INTERFACES
// ============================================================================

/**
 * Hesaplama parametreleri
 */
export interface FeedingTableParameters {
  feedId: string;
  feedName: string;
  feedCode: string;
  targetFCR: number;

  baseData: {
    startDate: Date;
    endDate: Date;
    startWeight: number;           // g - Başlangıç ortalama ağırlık
    targetWeight: number;          // g - Hedef ortalama ağırlık
    currentQuantity: number;       // Başlangıç adet
    estimatedMortalityPercent: number; // Tahmini mortality (%)
  };

  environmentalFactors: {
    avgWaterTemp: number;          // °C
    tempAdjustmentFactor: number;  // Sıcaklık düzeltme katsayısı
  };

  calculationMethod: CalculationMethod;
}

/**
 * Günlük yemleme schedule satırı
 */
export interface FeedingScheduleEntry {
  day: number;                     // Gün numarası (1, 2, 3...)
  date: Date;

  // Tahminler
  estimatedQuantity: number;       // Tahmini canlı adet
  estimatedAvgWeight: number;      // Tahmini ortalama ağırlık (g)
  estimatedBiomass: number;        // Tahmini biomass (kg)

  // Yemleme
  feedAmount: number;              // Günlük yem miktarı (kg)
  feedingFrequency: number;        // Günlük öğün sayısı
  perFeedingAmount: number;        // Öğün başına miktar (kg)
  feedingRatePercent: number;      // % body weight

  // Kümülatif
  cumulativeFeed: number;          // Toplam verilen yem (kg)
  cumulativeGrowth: number;        // Toplam büyüme (kg)

  // FCR
  dailyFCR: number;                // Günlük FCR
  cumulativeFCR: number;           // Kümülatif FCR

  // Notlar
  notes?: string;
}

/**
 * Yemleme özeti
 */
export interface FeedingTableSummary {
  totalDays: number;
  totalFeedRequired: number;       // kg
  totalGrowthExpected: number;     // kg
  avgDailyGrowth: number;          // g/gün
  avgDailyFeed: number;            // kg/gün
  estimatedFinalFCR: number;
  estimatedCost: number;           // TL
  estimatedFinalWeight: number;    // g
  estimatedFinalBiomass: number;   // kg
}

// ============================================================================
// ENTITY
// ============================================================================

@ObjectType()
@Entity('feeding_tables')
@Index(['tenantId', 'batchId', 'version'], { unique: true })
@Index(['tenantId', 'batchId', 'status'])
@Index(['tenantId', 'status'])
@Index(['batchId', 'isActive'])
export class FeedingTable {
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
  // FEED İLİŞKİSİ
  // -------------------------------------------------------------------------

  @Field()
  @Column('uuid')
  feedId: string;

  @ManyToOne('Feed', { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'feedId' })
  feed?: Feed;

  // -------------------------------------------------------------------------
  // VERSİYON KONTROLÜ
  // -------------------------------------------------------------------------

  @Field(() => Int)
  @Column({ type: 'int', default: 1 })
  version: number;                 // Her regeneration'da +1

  @Field({ nullable: true })
  @Column('uuid', { nullable: true })
  previousVersionId?: string;      // Önceki version ID

  @Field({ nullable: true })
  @Column({ type: 'text', nullable: true })
  recalculationReason?: string;    // Neden yeniden hesaplandı

  // -------------------------------------------------------------------------
  // PARAMETRELER
  // -------------------------------------------------------------------------

  @Field(() => GraphQLJSON)
  @Column({ type: 'jsonb' })
  parameters: FeedingTableParameters;

  // -------------------------------------------------------------------------
  // SCHEDULE
  // -------------------------------------------------------------------------

  @Field(() => GraphQLJSON)
  @Column({ type: 'jsonb' })
  schedule: FeedingScheduleEntry[];

  // -------------------------------------------------------------------------
  // ÖZET
  // -------------------------------------------------------------------------

  @Field(() => GraphQLJSON)
  @Column({ type: 'jsonb' })
  summary: FeedingTableSummary;

  // -------------------------------------------------------------------------
  // FCR BİLGİLERİ
  // -------------------------------------------------------------------------

  @Field(() => Float)
  @Column({ type: 'decimal', precision: 5, scale: 3 })
  targetFCR: number;

  @Field(() => Float, { nullable: true })
  @Column({ type: 'decimal', precision: 5, scale: 3, nullable: true })
  actualFCR?: number;              // Gerçekleşen FCR (update edilir)

  // -------------------------------------------------------------------------
  // TARİH ARALIĞI
  // -------------------------------------------------------------------------

  @Field()
  @Column({ type: 'date' })
  startDate: Date;

  @Field()
  @Column({ type: 'date' })
  endDate: Date;

  // -------------------------------------------------------------------------
  // DURUM
  // -------------------------------------------------------------------------

  @Field(() => FeedingTableStatus)
  @Column({
    type: 'enum',
    enum: FeedingTableStatus,
    default: FeedingTableStatus.DRAFT,
  })
  status: FeedingTableStatus;

  @Field()
  @Column({ default: false })
  @Index()
  isActive: boolean;               // Aktif yemleme tablosu mu

  @Field({ nullable: true })
  @Column({ type: 'text', nullable: true })
  notes?: string;

  // -------------------------------------------------------------------------
  // HESAPLAMA BİLGİLERİ
  // -------------------------------------------------------------------------

  @Field()
  @Column({ type: 'timestamptz' })
  calculatedAt: Date;

  @Field()
  @Column('uuid')
  calculatedBy: string;

  // -------------------------------------------------------------------------
  // AUDIT FIELDS
  // -------------------------------------------------------------------------

  @Field()
  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @Field()
  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;

  @VersionColumn()
  entityVersion: number;

  // -------------------------------------------------------------------------
  // BUSINESS METHODS
  // -------------------------------------------------------------------------

  /**
   * Belirli bir gün için schedule'ı döner
   */
  getScheduleForDay(dayNumber: number): FeedingScheduleEntry | undefined {
    return this.schedule.find((s) => s.day === dayNumber);
  }

  /**
   * Belirli bir tarih için schedule'ı döner
   */
  getScheduleForDate(date: Date): FeedingScheduleEntry | undefined {
    const targetDate = new Date(date).toISOString().split('T')[0];
    return this.schedule.find((s) => {
      const scheduleDate = new Date(s.date).toISOString().split('T')[0];
      return scheduleDate === targetDate;
    });
  }

  /**
   * Bugün için schedule'ı döner
   */
  getTodaySchedule(): FeedingScheduleEntry | undefined {
    return this.getScheduleForDate(new Date());
  }

  /**
   * Kalan gün sayısını hesaplar
   */
  getRemainingDays(): number {
    const today = new Date();
    const end = new Date(this.endDate);
    const diffTime = end.getTime() - today.getTime();
    return Math.max(0, Math.ceil(diffTime / (1000 * 60 * 60 * 24)));
  }

  /**
   * İlerleme yüzdesini hesaplar
   */
  getProgressPercent(): number {
    const totalDays = this.summary.totalDays;
    const remainingDays = this.getRemainingDays();
    const completedDays = totalDays - remainingDays;
    return Math.min(100, (completedDays / totalDays) * 100);
  }

  /**
   * Tabloyu supersede et (yeni version geldiğinde)
   */
  supersede(): void {
    this.status = FeedingTableStatus.SUPERSEDED;
    this.isActive = false;
  }

  /**
   * Tabloyu aktive et
   */
  activate(): void {
    this.status = FeedingTableStatus.ACTIVE;
    this.isActive = true;
  }
}
