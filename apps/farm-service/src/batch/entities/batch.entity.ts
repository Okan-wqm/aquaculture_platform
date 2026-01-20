/**
 * Batch Entity - Üretim Partileri
 *
 * Akuakültür tesislerinde yetiştirilen canlı grupları temsil eder.
 * Bir batch:
 * - Aynı türden oluşur (speciesId)
 * - Birden fazla tank/pond'da bulunabilir (BatchLocation M2M)
 * - Dual weight tracking (theoretical vs actual)
 * - FCR takibi
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
  VersionColumn,
  ManyToOne,
  OneToMany,
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
// Note: Species is referenced via string to avoid circular dependency

// ============================================================================
// ENUMS
// ============================================================================

/**
 * Batch durumu
 */
export enum BatchStatus {
  QUARANTINE = 'QUARANTINE',       // Karantinada
  ACTIVE = 'ACTIVE',               // Aktif üretimde
  GROWING = 'GROWING',             // Büyüme aşamasında
  PRE_HARVEST = 'PRE_HARVEST',     // Hasat öncesi
  HARVESTING = 'HARVESTING',       // Hasat yapılıyor
  HARVESTED = 'HARVESTED',         // Hasat tamamlandı
  TRANSFERRED = 'TRANSFERRED',     // Transfer edildi
  FAILED = 'FAILED',               // Başarısız (toplu ölüm vb.)
  CLOSED = 'CLOSED',               // Kapatıldı
}

registerEnumType(BatchStatus, {
  name: 'BatchStatus',
  description: 'Batch durumu',
});

/**
 * Girdi tipi - Batch'in başlangıç formu
 */
export enum BatchInputType {
  EGGS = 'EGGS',                   // Yumurta
  LARVAE = 'LARVAE',               // Larva
  POST_LARVAE = 'POST_LARVAE',     // Post-larva
  FRY = 'FRY',                     // Yavru
  FINGERLINGS = 'FINGERLINGS',     // Parmak boy
  JUVENILES = 'JUVENILES',         // Genç
  ADULTS = 'ADULTS',               // Yetişkin
  BROODSTOCK = 'BROODSTOCK',       // Anaç
}

registerEnumType(BatchInputType, {
  name: 'BatchInputType',
  description: 'Batch girdi tipi',
});

/**
 * Arrival Method - Batch'in tesise ulaşım şekli
 */
export enum ArrivalMethod {
  AIR_CARGO = 'AIR_CARGO',
  TRUCK = 'TRUCK',
  BOAT = 'BOAT',
  RAIL = 'RAIL',
  LOCAL_PICKUP = 'LOCAL_PICKUP',
  OTHER = 'OTHER',
}

registerEnumType(ArrivalMethod, {
  name: 'ArrivalMethod',
  description: 'Batch arrival/transport method',
});

/**
 * Batch tipi - Production (üretim) veya Cleaner Fish
 */
export enum BatchType {
  PRODUCTION = 'production',      // Normal üretim batch'i
  CLEANER_FISH = 'cleaner_fish',  // Cleaner fish batch'i (lumpfish, wrasse)
}

registerEnumType(BatchType, {
  name: 'BatchType',
  description: 'Batch tipi - üretim veya cleaner fish',
});

// ============================================================================
// INTERFACES
// ============================================================================

/**
 * Ağırlık takibi - Çift kayıt sistemi
 */
export interface BatchWeight {
  initial: {
    avgWeight: number;             // g - Başlangıç ortalama ağırlık
    totalBiomass: number;          // kg - Başlangıç toplam biomass
    measuredAt: Date;
  };

  theoretical: {
    avgWeight: number;             // g - Teorik ortalama ağırlık
    totalBiomass: number;          // kg - Teorik toplam biomass
    lastCalculatedAt: Date;
    basedOnFCR: number;            // Hesaplamada kullanılan FCR
  };

  actual: {
    avgWeight: number;             // g - Gerçek ortalama ağırlık
    totalBiomass: number;          // kg - Gerçek toplam biomass
    lastMeasuredAt: Date;
    sampleSize: number;            // Örnek sayısı
    confidencePercent: number;     // Güven yüzdesi
  };

  variance: {
    weightDifference: number;      // g (actual - theoretical)
    percentageDifference: number;  // %
    isSignificant: boolean;        // |%| > threshold
  };
}

/**
 * FCR (Feed Conversion Ratio) takibi
 */
export interface BatchFCR {
  target: number;                  // Hedef FCR
  actual: number;                  // Gerçek FCR
  theoretical: number;             // Teorik FCR
  isUserOverride: boolean;         // Kullanıcı tarafından override edildi mi
  lastUpdatedAt: Date;
}

/**
 * Yemleme özeti
 */
export interface BatchFeedingSummary {
  currentFeedId?: string;
  currentFeedName?: string;
  totalFeedGiven: number;          // kg - Toplam verilen yem
  totalFeedCost: number;           // TL - Toplam yem maliyeti
  lastFeedingAt?: Date;
  avgDailyFeed?: number;           // kg/gün
}

/**
 * Büyüme metrikleri
 */
export interface BatchGrowthMetrics {
  currentGrowthStage?: string;     // Mevcut büyüme aşaması

  growthRate: {
    actual: number;                // g/gün - Gerçek büyüme hızı
    target: number;                // g/gün - Hedef büyüme hızı
    variancePercent: number;       // % - Sapma
  };

  specificGrowthRate?: number;     // SGR - Spesifik büyüme oranı

  daysInProduction: number;        // Üretimde geçen gün

  projections: {
    harvestDate?: Date;
    harvestWeight?: number;        // g
    harvestBiomass?: number;       // kg
    confidenceLevel: 'high' | 'medium' | 'low';
  };
}

/**
 * Mortality özeti
 */
export interface BatchMortalitySummary {
  totalMortality: number;          // Toplam ölüm adedi
  mortalityRate: number;           // %
  lastMortalityAt?: Date;
  mainCause?: string;
}

// ============================================================================
// ENTITY
// ============================================================================

@ObjectType()
@Entity('batches_v2')
@Index(['tenantId', 'batchNumber'], { unique: true })
@Index(['tenantId', 'speciesId'])
@Index(['tenantId', 'status'])
@Index(['tenantId', 'stockedAt'])
@Index(['tenantId', 'isActive'])
@Index(['tenantId', 'batchType'])
export class Batch {
  @Field(() => ID)
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Field()
  @Column('uuid')
  @Index()
  tenantId: string;

  // -------------------------------------------------------------------------
  // TEMEL BİLGİLER
  // -------------------------------------------------------------------------

  @Field()
  @Column({ length: 50 })
  batchNumber: string;             // B-2024-00001

  @Field({ nullable: true })
  @Column({ length: 255, nullable: true })
  name?: string;                   // Opsiyonel görüntüleme adı

  @Field({ nullable: true })
  @Column({ type: 'text', nullable: true })
  description?: string;

  // -------------------------------------------------------------------------
  // TÜR BİLGİLERİ
  // -------------------------------------------------------------------------

  @Field()
  @Column('uuid')
  speciesId: string;

  @ManyToOne('Species', { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'speciesId' })
  species: any;

  @Field({ nullable: true })
  @Column({ length: 100, nullable: true })
  strain?: string;                 // Irk/çeşit

  @Field(() => BatchInputType)
  @Column({
    type: 'enum',
    enum: BatchInputType,
    default: BatchInputType.FRY,
  })
  inputType: BatchInputType;

  // -------------------------------------------------------------------------
  // BATCH TİPİ (Production vs Cleaner Fish)
  // -------------------------------------------------------------------------

  @Field(() => BatchType)
  @Column({
    type: 'enum',
    enum: BatchType,
    default: BatchType.PRODUCTION,
  })
  batchType: BatchType;

  /**
   * Cleaner fish kaynak tipi
   * 'farmed' - çiftlik üretimi
   * 'wild_caught' - doğadan yakalanan
   */
  @Field({ nullable: true })
  @Column({ type: 'varchar', length: 50, nullable: true })
  sourceType?: string;

  /**
   * Cleaner fish kaynak lokasyonu
   * Yakalama veya tedarik noktası
   */
  @Field({ nullable: true })
  @Column({ type: 'text', nullable: true })
  sourceLocation?: string;

  // -------------------------------------------------------------------------
  // MİKTAR TAKİBİ
  // -------------------------------------------------------------------------

  @Field(() => Int)
  @Column({ type: 'int' })
  initialQuantity: number;         // Başlangıç adedi

  @Field(() => Int)
  @Column({ type: 'int' })
  currentQuantity: number;         // Mevcut adet (mortality düşülmüş)

  @Field(() => Int)
  @Column({ type: 'int', default: 0 })
  totalMortality: number;          // Toplam ölüm adedi

  @Field(() => Int, { nullable: true })
  @Column({ type: 'int', nullable: true })
  harvestedQuantity?: number;      // Hasat edilen adet

  @Field(() => Int)
  @Column({ type: 'int', default: 0 })
  cullCount: number;               // Ayıklama sayısı (cull)

  @Field(() => Float)
  @Column({ type: 'decimal', precision: 15, scale: 2, default: 0 })
  totalFeedConsumed: number;       // Toplam yem tüketimi (kg)

  @Field(() => Float)
  @Column({ type: 'decimal', precision: 15, scale: 2, default: 0 })
  totalFeedCost: number;           // Toplam yem maliyeti

  @Field(() => Float, { nullable: true })
  @Column({ type: 'decimal', precision: 5, scale: 2, nullable: true })
  retentionRate?: number;          // Tutma oranı (%) - mortality + cull dahil

  @Field(() => Float, { nullable: true })
  @Column({ type: 'decimal', precision: 5, scale: 4, nullable: true })
  sgr?: number;                    // Spesifik büyüme oranı (SGR)

  @Field(() => Float, { nullable: true })
  @Column({ type: 'decimal', precision: 10, scale: 2, nullable: true })
  costPerKg?: number;              // kg başına maliyet

  // -------------------------------------------------------------------------
  // AĞIRLIK TAKİBİ - ÇİFT KAYIT
  // -------------------------------------------------------------------------

  @Field(() => GraphQLJSON)
  @Column({ type: 'jsonb' })
  weight: BatchWeight;

  // -------------------------------------------------------------------------
  // FCR TAKİBİ
  // -------------------------------------------------------------------------

  @Field(() => GraphQLJSON)
  @Column({ type: 'jsonb' })
  fcr: BatchFCR;

  // -------------------------------------------------------------------------
  // YEMLEME ÖZETİ
  // -------------------------------------------------------------------------

  @Field(() => GraphQLJSON)
  @Column({ type: 'jsonb' })
  feedingSummary: BatchFeedingSummary;

  // -------------------------------------------------------------------------
  // BÜYÜME METRİKLERİ
  // -------------------------------------------------------------------------

  @Field(() => GraphQLJSON)
  @Column({ type: 'jsonb' })
  growthMetrics: BatchGrowthMetrics;

  // -------------------------------------------------------------------------
  // MORTALITY ÖZETİ
  // -------------------------------------------------------------------------

  @Field(() => GraphQLJSON)
  @Column({ type: 'jsonb' })
  mortalitySummary: BatchMortalitySummary;

  // -------------------------------------------------------------------------
  // TARİHLER
  // -------------------------------------------------------------------------

  @Field()
  @Column({ type: 'date' })
  stockedAt: Date;                 // Stoklama tarihi

  @Field({ nullable: true })
  @Column({ type: 'date', nullable: true })
  expectedHarvestDate?: Date;

  @Field({ nullable: true })
  @Column({ type: 'date', nullable: true })
  actualHarvestDate?: Date;

  // -------------------------------------------------------------------------
  // TEDARİKÇİ BİLGİLERİ
  // -------------------------------------------------------------------------

  @Field({ nullable: true })
  @Column('uuid', { nullable: true })
  supplierId?: string;

  @Field({ nullable: true })
  @Column({ length: 100, nullable: true })
  supplierBatchNumber?: string;    // Tedarikçi parti numarası

  @Field(() => Float, { nullable: true })
  @Column({ type: 'decimal', precision: 15, scale: 2, nullable: true })
  purchaseCost?: number;           // Satın alma maliyeti

  @Field({ nullable: true })
  @Column({ length: 3, nullable: true })
  currency?: string;

  // -------------------------------------------------------------------------
  // ULAŞIM BİLGİLERİ
  // -------------------------------------------------------------------------

  @Field(() => ArrivalMethod, { nullable: true })
  @Column({
    type: 'enum',
    enum: ArrivalMethod,
    nullable: true,
  })
  arrivalMethod?: ArrivalMethod;

  // -------------------------------------------------------------------------
  // DURUM
  // -------------------------------------------------------------------------

  @Field(() => BatchStatus)
  @Column({
    type: 'enum',
    enum: BatchStatus,
    default: BatchStatus.QUARANTINE,
  })
  status: BatchStatus;

  @Field({ nullable: true })
  @Column({ type: 'timestamptz', nullable: true })
  statusChangedAt?: Date;

  @Field({ nullable: true })
  @Column({ type: 'text', nullable: true })
  statusReason?: string;

  @Field()
  @Column({ default: true })
  @Index()
  isActive: boolean;

  @Field({ nullable: true })
  @Column({ type: 'text', nullable: true })
  notes?: string;

  // -------------------------------------------------------------------------
  // AUDIT FIELDS
  // -------------------------------------------------------------------------

  @Field()
  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @Field()
  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;

  @Field({ nullable: true })
  @Column('uuid', { nullable: true })
  createdBy?: string;

  @Field({ nullable: true })
  @Column('uuid', { nullable: true })
  updatedBy?: string;

  @VersionColumn()
  version: number;

  // -------------------------------------------------------------------------
  // İLİŞKİLER
  // -------------------------------------------------------------------------

  @OneToMany('BatchDocument', 'batch')
  documents?: any[];

  // @OneToMany(() => BatchLocation, (bl) => bl.batch)
  // locations?: BatchLocation[];

  // @OneToMany(() => MortalityRecord, (mr) => mr.batch)
  // mortalityRecords?: MortalityRecord[];

  // @OneToMany(() => FeedingRecord, (fr) => fr.batch)
  // feedingRecords?: FeedingRecord[];

  // @OneToMany(() => GrowthMeasurement, (gm) => gm.batch)
  // growthMeasurements?: GrowthMeasurement[];

  // -------------------------------------------------------------------------
  // BUSINESS METHODS
  // -------------------------------------------------------------------------

  /**
   * Mevcut biomass'ı hesaplar (kg)
   */
  getCurrentBiomass(): number {
    // Önce actual, yoksa theoretical
    if (this.weight?.actual?.totalBiomass) {
      return this.weight.actual.totalBiomass;
    }
    if (this.weight?.theoretical?.totalBiomass) {
      return this.weight.theoretical.totalBiomass;
    }
    // Fallback: initial
    return this.weight?.initial?.totalBiomass || 0;
  }

  /**
   * Mevcut ortalama ağırlığı döner (g)
   */
  getCurrentAvgWeight(): number {
    if (this.weight?.actual?.avgWeight) {
      return this.weight.actual.avgWeight;
    }
    if (this.weight?.theoretical?.avgWeight) {
      return this.weight.theoretical.avgWeight;
    }
    return this.weight?.initial?.avgWeight || 0;
  }

  /**
   * Mortality oranını hesaplar (%)
   */
  getMortalityRate(): number {
    if (this.initialQuantity <= 0) return 0;
    return (this.totalMortality / this.initialQuantity) * 100;
  }

  /**
   * Hayatta kalma oranını hesaplar (%) - SADECE doğal ölüm
   * Survival Rate = ((initialQty - mortalityCount) / initialQty) * 100
   */
  getSurvivalRate(): number {
    if (this.initialQuantity <= 0) return 100;
    return ((this.initialQuantity - this.totalMortality) / this.initialQuantity) * 100;
  }

  /**
   * Retention rate hesaplar (%) - mortality + cull dahil
   * Retention Rate = (currentQty / initialQty) * 100
   */
  getRetentionRate(): number {
    if (this.initialQuantity <= 0) return 100;
    return (this.currentQuantity / this.initialQuantity) * 100;
  }

  /**
   * FCR hesaplar (Feed Conversion Ratio)
   * FCR = totalFeedConsumed / weightGain
   * weightGain = finalBiomass - initialBiomass + mortalityBiomass
   */
  calculateFCR(mortalityBiomass: number = 0): number {
    const initialBiomass = this.weight?.initial?.totalBiomass || 0;
    const currentBiomass = this.getCurrentBiomass();
    const weightGain = currentBiomass - initialBiomass + mortalityBiomass;

    if (weightGain <= 0 || this.totalFeedConsumed <= 0) return 0;
    return this.totalFeedConsumed / weightGain;
  }

  /**
   * SGR hesaplar (Specific Growth Rate)
   * SGR = ((ln(finalWeight) - ln(initialWeight)) / days) * 100
   */
  calculateSGR(): number {
    const initialWeight = this.weight?.initial?.avgWeight || 0;
    const currentWeight = this.getCurrentAvgWeight();
    const days = this.getDaysInProduction();

    if (initialWeight <= 0 || currentWeight <= 0 || days <= 0) return 0;
    return ((Math.log(currentWeight) - Math.log(initialWeight)) / days) * 100;
  }

  /**
   * Üretimdeki gün sayısını hesaplar
   */
  getDaysInProduction(): number {
    const stockDate = new Date(this.stockedAt);
    const endDate = this.actualHarvestDate
      ? new Date(this.actualHarvestDate)
      : new Date();
    const diffTime = Math.abs(endDate.getTime() - stockDate.getTime());
    return Math.ceil(diffTime / (1000 * 60 * 60 * 24));
  }

  /**
   * Status geçişi valid mi kontrol eder
   */
  canTransitionTo(newStatus: BatchStatus): boolean {
    const validTransitions: Record<BatchStatus, BatchStatus[]> = {
      [BatchStatus.QUARANTINE]: [BatchStatus.ACTIVE, BatchStatus.FAILED],
      [BatchStatus.ACTIVE]: [
        BatchStatus.GROWING,
        BatchStatus.TRANSFERRED,
        BatchStatus.FAILED,
      ],
      [BatchStatus.GROWING]: [
        BatchStatus.PRE_HARVEST,
        BatchStatus.TRANSFERRED,
        BatchStatus.FAILED,
      ],
      [BatchStatus.PRE_HARVEST]: [
        BatchStatus.HARVESTING,
        BatchStatus.GROWING,
        BatchStatus.FAILED,
      ],
      [BatchStatus.HARVESTING]: [
        BatchStatus.HARVESTED,
        BatchStatus.FAILED,
      ],
      [BatchStatus.HARVESTED]: [BatchStatus.CLOSED],
      [BatchStatus.TRANSFERRED]: [BatchStatus.CLOSED],
      [BatchStatus.FAILED]: [BatchStatus.CLOSED],
      [BatchStatus.CLOSED]: [],
    };

    return validTransitions[this.status]?.includes(newStatus) ?? false;
  }

  /**
   * Batch aktif mi?
   */
  isOperational(): boolean {
    return [
      BatchStatus.ACTIVE,
      BatchStatus.GROWING,
      BatchStatus.PRE_HARVEST,
      BatchStatus.HARVESTING,
    ].includes(this.status);
  }

  /**
   * Bu batch cleaner fish batch'i mi?
   */
  isCleanerFishBatch(): boolean {
    return this.batchType === BatchType.CLEANER_FISH;
  }

  /**
   * Bu batch production batch'i mi?
   */
  isProductionBatch(): boolean {
    return this.batchType === BatchType.PRODUCTION;
  }
}
