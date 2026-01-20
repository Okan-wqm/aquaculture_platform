/**
 * FeedTypeSpecies Entity - Yem-Tür İlişkisi (N:M Junction Table)
 *
 * Hangi yem türünün hangi balık türleri için uygun olduğunu belirler.
 * Ağırlık aralığı bazlı eşleştirme yapar.
 *
 * Kullanım senaryoları:
 * - Batch oluşturulurken uygun yem önerisi
 * - Yemleme planı hazırlanırken doğru yem seçimi
 * - Stok yönetiminde tür bazlı yem takibi
 *
 * @module Feed
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
  Unique,
  VersionColumn,
} from 'typeorm';
import {
  ObjectType,
  Field,
  ID,
  Float,
  registerEnumType,
} from '@nestjs/graphql';
import GraphQLJSON from 'graphql-type-json';
import { Feed } from './feed.entity';
// Note: Species is referenced via string to avoid circular dependency

// ============================================================================
// ENUMS
// ============================================================================

/**
 * Öneri seviyesi - Bu yem-tür kombinasyonu ne kadar uygun
 */
export enum FeedSpeciesRecommendation {
  HIGHLY_RECOMMENDED = 'highly_recommended',   // Çok önerilir
  RECOMMENDED = 'recommended',                  // Önerilir
  SUITABLE = 'suitable',                        // Uygun
  CONDITIONAL = 'conditional',                  // Koşullu (belirli durumlar için)
  NOT_RECOMMENDED = 'not_recommended',          // Önerilmez
}

registerEnumType(FeedSpeciesRecommendation, {
  name: 'FeedSpeciesRecommendation',
  description: 'Yem-tür uyumluluk seviyesi',
});

/**
 * Büyüme aşaması - Hangi aşamada bu yem uygun
 */
export enum FeedGrowthStage {
  ALL = 'all',                    // Tüm aşamalar
  LARVAE = 'larvae',              // Larva
  FRY = 'fry',                    // Yavru
  FINGERLING = 'fingerling',      // Parmak boy
  JUVENILE = 'juvenile',          // Genç
  GROWER = 'grower',              // Büyütme
  PRE_ADULT = 'pre_adult',        // Erişkin öncesi
  ADULT = 'adult',                // Erişkin
  BROODSTOCK = 'broodstock',      // Anaç
}

registerEnumType(FeedGrowthStage, {
  name: 'FeedGrowthStage',
  description: 'Yemleme için büyüme aşaması',
});

// ============================================================================
// INTERFACES
// ============================================================================

/**
 * Yemleme oranları - Sıcaklık ve ağırlık bazlı
 */
export interface FeedingRateConfig {
  temperatureRanges?: Array<{
    minTemp: number;
    maxTemp: number;
    feedingRatePercent: number;       // Vücut ağırlığının %'si
    feedingFrequency: number;         // Günlük öğün sayısı
  }>;
  defaultFeedingRatePercent: number;  // Varsayılan oran
  defaultFeedingFrequency: number;    // Varsayılan öğün sayısı
  notes?: string;
}

/**
 * Performans beklentileri
 */
export interface ExpectedPerformance {
  targetFCR?: number;                 // Hedef FCR
  minFCR?: number;                    // En iyi FCR
  maxFCR?: number;                    // Kabul edilebilir maksimum
  expectedSGR?: number;               // Beklenen spesifik büyüme oranı
  survivalRateImpact?: 'positive' | 'neutral' | 'negative';
  notes?: string;
}

// ============================================================================
// ENTITY
// ============================================================================

@ObjectType()
@Entity('feed_type_species')
@Unique(['tenantId', 'feedId', 'speciesId', 'growthStage'])
@Index(['tenantId', 'feedId'])
@Index(['tenantId', 'speciesId'])
@Index(['tenantId', 'growthStage'])
@Index(['tenantId', 'recommendation'])
@Index(['tenantId', 'isActive'])
export class FeedTypeSpecies {
  @Field(() => ID)
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Field()
  @Column('uuid')
  @Index()
  tenantId: string;

  // -------------------------------------------------------------------------
  // İLİŞKİLER
  // -------------------------------------------------------------------------

  @Field()
  @Column('uuid')
  feedId: string;

  @ManyToOne(() => Feed, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'feedId' })
  feed: Feed;

  @Field()
  @Column('uuid')
  speciesId: string;

  @ManyToOne('Species', { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'speciesId' })
  species: any;

  // -------------------------------------------------------------------------
  // BÜYÜME AŞAMASI
  // -------------------------------------------------------------------------

  @Field(() => FeedGrowthStage)
  @Column({
    type: 'enum',
    enum: FeedGrowthStage,
    default: FeedGrowthStage.ALL,
  })
  growthStage: FeedGrowthStage;

  // -------------------------------------------------------------------------
  // AĞIRLIK ARALIĞI
  // -------------------------------------------------------------------------

  @Field(() => Float, { nullable: true })
  @Column({ type: 'decimal', precision: 10, scale: 2, nullable: true })
  recommendedWeightMinG?: number;     // Önerilen minimum ağırlık (gram)

  @Field(() => Float, { nullable: true })
  @Column({ type: 'decimal', precision: 10, scale: 2, nullable: true })
  recommendedWeightMaxG?: number;     // Önerilen maksimum ağırlık (gram)

  // -------------------------------------------------------------------------
  // YEMLEME ORANLARI
  // -------------------------------------------------------------------------

  @Field(() => Float, { nullable: true })
  @Column({ type: 'decimal', precision: 5, scale: 2, nullable: true })
  feedingRatePercent?: number;        // Vücut ağırlığının %'si

  @Field(() => Float, { nullable: true })
  @Column({ type: 'int', nullable: true })
  feedingFrequencyPerDay?: number;    // Günlük öğün sayısı

  @Field(() => GraphQLJSON, { nullable: true })
  @Column({ type: 'jsonb', nullable: true })
  feedingRateConfig?: FeedingRateConfig;

  // -------------------------------------------------------------------------
  // ÖNERİ SEVİYESİ
  // -------------------------------------------------------------------------

  @Field(() => FeedSpeciesRecommendation)
  @Column({
    type: 'enum',
    enum: FeedSpeciesRecommendation,
    default: FeedSpeciesRecommendation.RECOMMENDED,
  })
  recommendation: FeedSpeciesRecommendation;

  @Field({ nullable: true })
  @Column({ type: 'int', nullable: true })
  priority?: number;                  // 1-10 arası öncelik (yüksek = daha tercih edilir)

  // -------------------------------------------------------------------------
  // PERFORMANS BEKLENTİLERİ
  // -------------------------------------------------------------------------

  @Field(() => GraphQLJSON, { nullable: true })
  @Column({ type: 'jsonb', nullable: true })
  expectedPerformance?: ExpectedPerformance;

  // -------------------------------------------------------------------------
  // DURUM
  // -------------------------------------------------------------------------

  @Field()
  @Column({ default: true })
  @Index()
  isActive: boolean;

  @Field({ nullable: true })
  @Column({ type: 'text', nullable: true })
  notes?: string;

  @Field(() => GraphQLJSON, { nullable: true })
  @Column({ type: 'jsonb', nullable: true })
  metadata?: Record<string, unknown>;

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
  // SOFT DELETE
  // -------------------------------------------------------------------------

  @Field()
  @Column({ default: false })
  @Index()
  isDeleted: boolean;

  @Field({ nullable: true })
  @Column({ type: 'timestamptz', nullable: true })
  deletedAt?: Date;

  @Field({ nullable: true })
  @Column('uuid', { nullable: true })
  deletedBy?: string;

  // -------------------------------------------------------------------------
  // BUSINESS METHODS
  // -------------------------------------------------------------------------

  /**
   * Verilen ağırlık bu yem için uygun mu?
   */
  isWeightInRange(weightG: number): boolean {
    if (this.recommendedWeightMinG === undefined && this.recommendedWeightMaxG === undefined) {
      return true; // Ağırlık kısıtlaması yok
    }

    const minOk = this.recommendedWeightMinG === undefined || weightG >= this.recommendedWeightMinG;
    const maxOk = this.recommendedWeightMaxG === undefined || weightG <= this.recommendedWeightMaxG;

    return minOk && maxOk;
  }

  /**
   * Verilen sıcaklık için yemleme oranını hesaplar
   */
  getFeedingRateForTemperature(temperature: number): number {
    if (!this.feedingRateConfig?.temperatureRanges?.length) {
      return this.feedingRatePercent || this.feedingRateConfig?.defaultFeedingRatePercent || 3;
    }

    const matchingRange = this.feedingRateConfig.temperatureRanges.find(
      (range) => temperature >= range.minTemp && temperature <= range.maxTemp
    );

    if (matchingRange) {
      return matchingRange.feedingRatePercent;
    }

    return this.feedingRateConfig.defaultFeedingRatePercent;
  }

  /**
   * Verilen sıcaklık için yemleme sıklığını hesaplar
   */
  getFeedingFrequencyForTemperature(temperature: number): number {
    if (!this.feedingRateConfig?.temperatureRanges?.length) {
      return this.feedingFrequencyPerDay || this.feedingRateConfig?.defaultFeedingFrequency || 2;
    }

    const matchingRange = this.feedingRateConfig.temperatureRanges.find(
      (range) => temperature >= range.minTemp && temperature <= range.maxTemp
    );

    if (matchingRange) {
      return matchingRange.feedingFrequency;
    }

    return this.feedingRateConfig.defaultFeedingFrequency;
  }

  /**
   * Günlük yem miktarını hesaplar (kg)
   */
  calculateDailyFeed(biomassKg: number, temperature?: number): number {
    const feedingRate = temperature
      ? this.getFeedingRateForTemperature(temperature)
      : this.feedingRatePercent || 3;

    return (biomassKg * feedingRate) / 100;
  }

  /**
   * Bu kombinasyon öneriliyor mu?
   */
  isRecommended(): boolean {
    return [
      FeedSpeciesRecommendation.HIGHLY_RECOMMENDED,
      FeedSpeciesRecommendation.RECOMMENDED,
      FeedSpeciesRecommendation.SUITABLE,
    ].includes(this.recommendation);
  }

  /**
   * Soft delete işlemi
   */
  softDelete(deletedBy?: string): void {
    this.isDeleted = true;
    this.deletedAt = new Date();
    this.deletedBy = deletedBy;
    this.isActive = false;
  }

  /**
   * Soft delete geri alma
   */
  restore(): void {
    this.isDeleted = false;
    this.deletedAt = undefined;
    this.deletedBy = undefined;
    this.isActive = true;
  }
}
