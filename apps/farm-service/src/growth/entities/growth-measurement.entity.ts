/**
 * GrowthMeasurement Entity - Büyüme Ölçümleri
 *
 * Batch'lerin periyodik ağırlık ve boy ölçümleri. Sample-based
 * istatistiksel analiz yapılır ve FCR hesaplaması tetiklenir.
 *
 * Özellikler:
 * - Sample-based ölçüm (n adet balık)
 * - İstatistiksel hesaplamalar (avg, stdDev, CV, CI)
 * - Theoretical vs Actual karşılaştırması
 * - FCR analizi ve trendi
 * - Önerilen aksiyonlar
 *
 * @module Growth
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
  BeforeInsert,
  BeforeUpdate,
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
// Note: Batch is referenced via string to avoid circular dependency
// Type-only import for TypeScript type checking
import type { Batch } from '../../batch/entities/batch.entity';

// ============================================================================
// ENUMS
// ============================================================================

/**
 * Ölçüm tipi
 */
export enum MeasurementType {
  ROUTINE = 'routine',               // Rutin (haftalık/iki haftalık)
  TRANSFER = 'transfer',             // Transfer öncesi
  GRADING = 'grading',               // Grade işlemi sırasında
  HARVEST = 'harvest',               // Hasat öncesi
  HEALTH_CHECK = 'health_check',     // Sağlık kontrolü
  SPOT_CHECK = 'spot_check',         // Anlık kontrol
}

registerEnumType(MeasurementType, {
  name: 'MeasurementType',
  description: 'Ölçüm tipi',
});

/**
 * Ölçüm metodu
 */
export enum MeasurementMethod {
  MANUAL_SCALE = 'manual_scale',     // Manuel tartı
  AUTOMATED_SCALE = 'automated_scale', // Otomatik tartı sistemi
  IMAGE_ANALYSIS = 'image_analysis', // Görüntü analizi
  SONAR = 'sonar',                   // Sonar/akustik
  ESTIMATED = 'estimated',           // Tahmin
}

registerEnumType(MeasurementMethod, {
  name: 'MeasurementMethod',
  description: 'Ölçüm metodu',
});

/**
 * Büyüme performansı değerlendirmesi
 */
export enum GrowthPerformance {
  EXCELLENT = 'excellent',           // Mükemmel (>10% over target)
  GOOD = 'good',                     // İyi (±5% of target)
  AVERAGE = 'average',               // Ortalama (±10% of target)
  BELOW_AVERAGE = 'below_average',   // Ortalamanın altında (10-20% below)
  POOR = 'poor',                     // Zayıf (>20% below target)
}

registerEnumType(GrowthPerformance, {
  name: 'GrowthPerformance',
  description: 'Büyüme performansı değerlendirmesi',
});

// ============================================================================
// INTERFACES
// ============================================================================

/**
 * Bireysel ölçüm verisi
 */
export interface IndividualMeasurement {
  sampleNumber: number;              // Örnek numarası (1, 2, 3...)
  weight: number;                    // gram
  length?: number;                   // cm (total length)
  width?: number;                    // cm (body width)
  notes?: string;                    // Gözlem (deformite, lezyon vs)
}

/**
 * İstatistiksel özet
 */
export interface StatisticalSummary {
  // Ağırlık istatistikleri
  weight: {
    min: number;                     // gram
    max: number;                     // gram
    mean: number;                    // gram
    median: number;                  // gram
    stdDev: number;                  // gram
    cv: number;                      // Coefficient of Variation (%)
    confidenceInterval: {            // 95% CI
      lower: number;
      upper: number;
    };
  };

  // Boy istatistikleri (opsiyonel)
  length?: {
    min: number;                     // cm
    max: number;                     // cm
    mean: number;                    // cm
    stdDev: number;                  // cm
    cv: number;
  };

  // Kondüsyon faktörü
  conditionFactor?: {
    mean: number;                    // K = 100 * W / L^3
    stdDev: number;
  };
}

/**
 * Büyüme karşılaştırması
 */
export interface GrowthComparison {
  // Teorik vs Gerçek
  theoreticalWeight: number;         // Beklenen ağırlık (g)
  actualWeight: number;              // Ölçülen ağırlık (g)
  variance: number;                  // Fark (g)
  variancePercent: number;           // Fark (%)

  // Önceki ölçüme göre
  previousMeasurementId?: string;
  daysSincePrevious?: number;
  dailyGrowthRate?: number;          // g/gün (ADG - Average Daily Growth)
  specificGrowthRate?: number;       // % / gün (SGR)

  // Hedef karşılaştırması
  targetWeight?: number;             // Hedef ağırlık (g)
  targetVariance?: number;           // Hedefe göre sapma (%)
}

/**
 * FCR analizi
 */
export interface FCRAnalysis {
  // Periyod FCR
  periodFeedGiven: number;           // Bu periyotta verilen yem (kg)
  periodGrowth: number;              // Bu periyotta büyüme (kg)
  periodFCR: number;                 // Periyod FCR

  // Kümülatif FCR
  cumulativeFeedGiven: number;       // Toplam verilen yem (kg)
  cumulativeGrowth: number;          // Toplam büyüme (kg)
  cumulativeFCR: number;             // Kümülatif FCR

  // Hedef karşılaştırması
  targetFCR: number;                 // Hedef FCR
  fcrVariance: number;               // FCR sapması (%)
  fcrTrend: 'improving' | 'stable' | 'declining';
}

/**
 * Önerilen aksiyonlar
 */
export interface SuggestedActions {
  priority: 'high' | 'medium' | 'low';
  actions: {
    type: 'feeding' | 'health' | 'environment' | 'grading' | 'other';
    description: string;
    reason: string;
  }[];
}

/**
 * Ölçüm koşulları
 */
export interface MeasurementConditions {
  waterTemp?: number;                // °C
  dissolvedOxygen?: number;          // mg/L
  feedingStatus: 'fed' | 'fasted_12h' | 'fasted_24h' | 'unknown';
  timeOfDay: string;                 // "08:00", "14:00" etc.
  weatherConditions?: string;
}

// ============================================================================
// ENTITY
// ============================================================================

@ObjectType()
@Entity('growth_measurements')
@Index(['tenantId', 'batchId', 'measurementDate'])
@Index(['tenantId', 'measurementDate'])
@Index(['batchId', 'measurementDate'])
@Index(['batchId', 'measurementType'])
export class GrowthMeasurement {
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
  // LOKASYON (opsiyonel - hangi tank/havuzda ölçüldü)
  // -------------------------------------------------------------------------

  @Field({ nullable: true })
  @Column('uuid', { nullable: true })
  tankId?: string;

  @Field({ nullable: true })
  @Column('uuid', { nullable: true })
  pondId?: string;

  // -------------------------------------------------------------------------
  // ÖLÇÜM BİLGİLERİ
  // -------------------------------------------------------------------------

  @Field()
  @Column({ type: 'date' })
  @Index()
  measurementDate: Date;

  @Field(() => MeasurementType)
  @Column({
    type: 'enum',
    enum: MeasurementType,
    default: MeasurementType.ROUTINE,
  })
  measurementType: MeasurementType;

  @Field(() => MeasurementMethod)
  @Column({
    type: 'enum',
    enum: MeasurementMethod,
    default: MeasurementMethod.MANUAL_SCALE,
  })
  measurementMethod: MeasurementMethod;

  // -------------------------------------------------------------------------
  // ÖRNEK BİLGİLERİ
  // -------------------------------------------------------------------------

  @Field(() => Int)
  @Column({ type: 'int' })
  sampleSize: number;                // Kaç balık ölçüldü

  @Field(() => Int)
  @Column({ type: 'int' })
  populationSize: number;            // Batch toplam adet

  @Field(() => Float)
  @Column({ type: 'decimal', precision: 5, scale: 2 })
  samplePercent: number;             // Örnekleme oranı (%)

  // -------------------------------------------------------------------------
  // BİREYSEL ÖLÇÜMLER
  // -------------------------------------------------------------------------

  @Field(() => GraphQLJSON)
  @Column({ type: 'jsonb' })
  individualMeasurements: IndividualMeasurement[];

  // -------------------------------------------------------------------------
  // İSTATİSTİKSEL ÖZET
  // -------------------------------------------------------------------------

  @Field(() => GraphQLJSON)
  @Column({ type: 'jsonb' })
  statistics: StatisticalSummary;

  // -------------------------------------------------------------------------
  // ANA SONUÇLAR (quick access)
  // -------------------------------------------------------------------------

  @Field(() => Float)
  @Column({ type: 'decimal', precision: 10, scale: 2 })
  averageWeight: number;             // Ortalama ağırlık (g)

  @Field(() => Float, { nullable: true })
  @Column({ type: 'decimal', precision: 6, scale: 2, nullable: true })
  averageLength?: number;            // Ortalama boy (cm)

  @Field(() => Float)
  @Column({ type: 'decimal', precision: 6, scale: 2 })
  weightCV: number;                  // Weight CV (%)

  @Field(() => Float, { nullable: true })
  @Column({ type: 'decimal', precision: 6, scale: 3, nullable: true })
  conditionFactor?: number;          // Ortalama K faktörü

  // -------------------------------------------------------------------------
  // BÜYÜME KARŞILAŞTIRMASI
  // -------------------------------------------------------------------------

  @Field(() => GraphQLJSON, { nullable: true })
  @Column({ type: 'jsonb', nullable: true })
  growthComparison?: GrowthComparison;

  @Field(() => GrowthPerformance, { nullable: true })
  @Column({
    type: 'enum',
    enum: GrowthPerformance,
    nullable: true,
  })
  performance?: GrowthPerformance;

  // -------------------------------------------------------------------------
  // FCR ANALİZİ
  // -------------------------------------------------------------------------

  @Field(() => GraphQLJSON, { nullable: true })
  @Column({ type: 'jsonb', nullable: true })
  fcrAnalysis?: FCRAnalysis;

  // -------------------------------------------------------------------------
  // BİOMASS TAHMİNİ
  // -------------------------------------------------------------------------

  @Field(() => Float)
  @Column({ type: 'decimal', precision: 12, scale: 2 })
  estimatedBiomass: number;          // Tahmini toplam biomass (kg)

  @Field(() => Float, { nullable: true })
  @Column({ type: 'decimal', precision: 12, scale: 2, nullable: true })
  previousBiomass?: number;          // Önceki biomass (kg)

  @Field(() => Float, { nullable: true })
  @Column({ type: 'decimal', precision: 10, scale: 2, nullable: true })
  biomassGain?: number;              // Biomass artışı (kg)

  // -------------------------------------------------------------------------
  // ÖNERİLEN AKSİYONLAR
  // -------------------------------------------------------------------------

  @Field(() => GraphQLJSON, { nullable: true })
  @Column({ type: 'jsonb', nullable: true })
  suggestedActions?: SuggestedActions;

  // -------------------------------------------------------------------------
  // ÖLÇÜM KOŞULLARI
  // -------------------------------------------------------------------------

  @Field(() => GraphQLJSON, { nullable: true })
  @Column({ type: 'jsonb', nullable: true })
  conditions?: MeasurementConditions;

  // -------------------------------------------------------------------------
  // DOĞRULAMA
  // -------------------------------------------------------------------------

  @Field()
  @Column({ default: false })
  isVerified: boolean;

  @Field({ nullable: true })
  @Column('uuid', { nullable: true })
  verifiedBy?: string;

  @Field({ nullable: true })
  @Column({ type: 'timestamptz', nullable: true })
  verifiedAt?: Date;

  // -------------------------------------------------------------------------
  // KULLANICI BİLGİLERİ
  // -------------------------------------------------------------------------

  @Field()
  @Column('uuid')
  measuredBy: string;                // Ölçümü yapan

  @Field({ nullable: true })
  @Column({ type: 'text', nullable: true })
  notes?: string;

  // -------------------------------------------------------------------------
  // BATCH GÜNCELLEMESİ
  // -------------------------------------------------------------------------

  @Field()
  @Column({ default: true })
  updateBatchWeight: boolean;        // Batch ağırlığını güncelle

  @Field()
  @Column({ default: false })
  isProcessed: boolean;              // Batch'e işlendi mi

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
  // COMPUTED FIELDS
  // -------------------------------------------------------------------------

  @BeforeInsert()
  @BeforeUpdate()
  calculateDerivedFields(): void {
    // Sample percent hesapla
    if (this.populationSize > 0) {
      this.samplePercent = (this.sampleSize / this.populationSize) * 100;
    }

    // Biomass hesapla
    this.estimatedBiomass = (this.averageWeight * this.populationSize) / 1000;

    // Biomass gain hesapla
    if (this.previousBiomass !== undefined && this.previousBiomass !== null) {
      this.biomassGain = this.estimatedBiomass - this.previousBiomass;
    }
  }

  // -------------------------------------------------------------------------
  // BUSINESS METHODS
  // -------------------------------------------------------------------------

  /**
   * İstatistikleri hesaplar
   */
  calculateStatistics(): void {
    if (!this.individualMeasurements || this.individualMeasurements.length === 0) {
      return;
    }

    const weights = this.individualMeasurements.map(m => m.weight);
    const n = weights.length;

    // Temel istatistikler
    const sum = weights.reduce((a, b) => a + b, 0);
    const mean = sum / n;
    const sorted = [...weights].sort((a, b) => a - b);
    const median = n % 2 === 0
      ? (sorted[n / 2 - 1]! + sorted[n / 2]!) / 2
      : sorted[Math.floor(n / 2)]!;
    const min = sorted[0]!;
    const max = sorted[n - 1]!;

    // Standart sapma
    const squaredDiffs = weights.map(w => Math.pow(w - mean, 2));
    const variance = squaredDiffs.reduce((a, b) => a + b, 0) / (n - 1);
    const stdDev = Math.sqrt(variance);

    // CV (Coefficient of Variation)
    const cv = (stdDev / mean) * 100;

    // 95% Confidence Interval
    const tValue = this.getTValue(n - 1); // t-distribution değeri
    const marginOfError = tValue * (stdDev / Math.sqrt(n));
    const ciLower = mean - marginOfError;
    const ciUpper = mean + marginOfError;

    // Ana değerleri güncelle
    this.averageWeight = mean;
    this.weightCV = cv;

    // İstatistik özeti oluştur
    this.statistics = {
      weight: {
        min,
        max,
        mean,
        median,
        stdDev,
        cv,
        confidenceInterval: {
          lower: ciLower,
          upper: ciUpper,
        },
      },
    };

    // Boy ölçümleri varsa
    const lengths = this.individualMeasurements
      .filter(m => m.length !== undefined)
      .map(m => m.length!);

    if (lengths.length > 0) {
      const lengthSum = lengths.reduce((a, b) => a + b, 0);
      const lengthMean = lengthSum / lengths.length;
      const lengthSorted = [...lengths].sort((a, b) => a - b);
      const lengthSquaredDiffs = lengths.map(l => Math.pow(l - lengthMean, 2));
      const lengthVariance = lengthSquaredDiffs.reduce((a, b) => a + b, 0) / (lengths.length - 1);
      const lengthStdDev = Math.sqrt(lengthVariance);
      const lengthCV = (lengthStdDev / lengthMean) * 100;

      this.averageLength = lengthMean;
      this.statistics.length = {
        min: lengthSorted[0] ?? 0,
        max: lengthSorted[lengths.length - 1] ?? 0,
        mean: lengthMean,
        stdDev: lengthStdDev,
        cv: lengthCV,
      };

      // Kondüsyon faktörü (K = 100 * W / L^3)
      const kFactors = this.individualMeasurements
        .filter(m => m.length !== undefined && m.length > 0)
        .map(m => 100 * m.weight / Math.pow(m.length!, 3));

      if (kFactors.length > 0) {
        const kSum = kFactors.reduce((a, b) => a + b, 0);
        const kMean = kSum / kFactors.length;
        const kSquaredDiffs = kFactors.map(k => Math.pow(k - kMean, 2));
        const kVariance = kSquaredDiffs.reduce((a, b) => a + b, 0) / (kFactors.length - 1);
        const kStdDev = Math.sqrt(kVariance);

        this.conditionFactor = kMean;
        this.statistics.conditionFactor = {
          mean: kMean,
          stdDev: kStdDev,
        };
      }
    }
  }

  /**
   * Performans değerlendirmesi yapar
   */
  evaluatePerformance(): void {
    if (!this.growthComparison) return;

    const variancePercent = Math.abs(this.growthComparison.variancePercent);

    if (this.growthComparison.variancePercent > 10) {
      this.performance = GrowthPerformance.EXCELLENT;
    } else if (variancePercent <= 5) {
      this.performance = GrowthPerformance.GOOD;
    } else if (variancePercent <= 10) {
      this.performance = GrowthPerformance.AVERAGE;
    } else if (variancePercent <= 20) {
      this.performance = GrowthPerformance.BELOW_AVERAGE;
    } else {
      this.performance = GrowthPerformance.POOR;
    }
  }

  /**
   * CV kabul edilebilir mi? (genelde %15-20 altı iyi)
   */
  isUniformGrowth(threshold: number = 20): boolean {
    return this.weightCV <= threshold;
  }

  /**
   * Grading gerekli mi?
   */
  needsGrading(cvThreshold: number = 25): boolean {
    return this.weightCV > cvThreshold;
  }

  /**
   * Büyüme hedefte mi?
   */
  isOnTarget(tolerance: number = 10): boolean {
    if (!this.growthComparison) return true;
    return Math.abs(this.growthComparison.variancePercent) <= tolerance;
  }

  /**
   * FCR hedefte mi?
   */
  isFCROnTarget(tolerance: number = 10): boolean {
    if (!this.fcrAnalysis) return true;
    return Math.abs(this.fcrAnalysis.fcrVariance) <= tolerance;
  }

  /**
   * Önerilen aksiyonları oluşturur
   */
  generateSuggestedActions(): void {
    const actions: SuggestedActions['actions'] = [];
    let priority: 'high' | 'medium' | 'low' = 'low';

    // CV yüksekse grading öner
    if (this.needsGrading()) {
      actions.push({
        type: 'grading',
        description: 'Grade işlemi yapılmalı',
        reason: `Ağırlık CV'si yüksek: ${this.weightCV.toFixed(1)}%`,
      });
      priority = 'medium';
    }

    // Büyüme hedefin altındaysa
    if (this.growthComparison && this.growthComparison.variancePercent < -15) {
      actions.push({
        type: 'feeding',
        description: 'Yemleme programı gözden geçirilmeli',
        reason: `Büyüme hedefin ${Math.abs(this.growthComparison.variancePercent).toFixed(1)}% altında`,
      });
      if (this.growthComparison.variancePercent < -20) {
        priority = 'high';
      } else {
        priority = priority === 'low' ? 'medium' : priority;
      }
    }

    // FCR kötüyse
    if (this.fcrAnalysis && this.fcrAnalysis.fcrVariance > 15) {
      actions.push({
        type: 'feeding',
        description: 'Yem kalitesi ve miktarı kontrol edilmeli',
        reason: `FCR hedefin ${this.fcrAnalysis.fcrVariance.toFixed(1)}% üstünde`,
      });
      priority = priority === 'low' ? 'medium' : priority;
    }

    // FCR kötüleşiyorsa
    if (this.fcrAnalysis && this.fcrAnalysis.fcrTrend === 'declining') {
      actions.push({
        type: 'health',
        description: 'Sağlık kontrolü yapılmalı',
        reason: 'FCR trendi kötüleşiyor',
      });
      priority = 'high';
    }

    // Kondüsyon faktörü düşükse
    if (this.conditionFactor && this.conditionFactor < 0.8) {
      actions.push({
        type: 'health',
        description: 'Balık kondüsyonu düşük, sağlık kontrolü',
        reason: `Kondüsyon faktörü: ${this.conditionFactor.toFixed(2)}`,
      });
      priority = 'high';
    }

    if (actions.length > 0) {
      this.suggestedActions = { priority, actions };
    }
  }

  /**
   * t-distribution değerini döner (95% CI için)
   */
  private getTValue(df: number): number {
    // Basitleştirilmiş t-değerleri (95% CI)
    const tValues: Record<number, number> = {
      1: 12.706, 2: 4.303, 3: 3.182, 4: 2.776, 5: 2.571,
      6: 2.447, 7: 2.365, 8: 2.306, 9: 2.262, 10: 2.228,
      15: 2.131, 20: 2.086, 25: 2.060, 30: 2.042, 40: 2.021,
      50: 2.009, 60: 2.000, 80: 1.990, 100: 1.984,
    };

    if (df <= 0) return 1.96;
    if (tValues[df]) return tValues[df];

    // En yakın değeri bul
    const keys = Object.keys(tValues).map(Number).sort((a, b) => a - b);
    for (let i = 0; i < keys.length - 1; i++) {
      const currentKey = keys[i];
      const nextKey = keys[i + 1];
      if (currentKey !== undefined && nextKey !== undefined && df > currentKey && df < nextKey) {
        // Lineer interpolasyon
        const ratio = (df - currentKey) / (nextKey - currentKey);
        const currentVal = tValues[currentKey] ?? 1.96;
        const nextVal = tValues[nextKey] ?? 1.96;
        return currentVal + ratio * (nextVal - currentVal);
      }
    }

    return 1.96; // df > 100 için yaklaşık z-değeri
  }
}
