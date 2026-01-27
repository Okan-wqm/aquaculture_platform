/**
 * HarvestPlan Entity - Hasat Planı
 *
 * Batch bazında hasat planlaması ve tahmini.
 * Pazar koşullarına göre hasat zamanlaması.
 *
 * Özellikler:
 * - Hasat hedefi belirleme
 * - Tahmini tarih ve miktar
 * - Çoklu hasat desteği (partial harvest)
 * - Maliyet ve gelir projeksiyonu
 * - Müşteri/sipariş eşleştirme
 *
 * @module Harvest
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
// Note: Batch is referenced via string to avoid circular dependency
// Type-only import for TypeScript type checking
import type { Batch } from '../../batch/entities/batch.entity';

// ============================================================================
// ENUMS
// ============================================================================

/**
 * Hasat plan durumu
 */
export enum HarvestPlanStatus {
  DRAFT = 'draft',                   // Taslak
  PLANNED = 'planned',               // Planlandı
  APPROVED = 'approved',             // Onaylandı
  SCHEDULED = 'scheduled',           // Zamanlandı (kesin tarih)
  IN_PROGRESS = 'in_progress',       // Hasat devam ediyor
  COMPLETED = 'completed',           // Tamamlandı
  CANCELLED = 'cancelled',           // İptal
  POSTPONED = 'postponed',           // Ertelendi
}

registerEnumType(HarvestPlanStatus, {
  name: 'HarvestPlanStatus',
  description: 'Hasat plan durumu',
});

/**
 * Hasat tipi
 */
export enum HarvestType {
  FULL = 'full',                     // Tam hasat (tüm batch)
  PARTIAL = 'partial',               // Kısmi hasat
  SELECTIVE = 'selective',           // Seçici (belirli boyut/ağırlık)
  EMERGENCY = 'emergency',           // Acil (hastalık/felaket)
  THINNING = 'thinning',             // Seyreltme hasadı
}

registerEnumType(HarvestType, {
  name: 'HarvestType',
  description: 'Hasat tipi',
});

/**
 * Hasat yöntemi
 */
export enum HarvestMethod {
  NET = 'net',                       // Kepçe/ağ
  PUMP = 'pump',                     // Pompa ile
  DRAIN = 'drain',                   // Su boşaltarak
  MANUAL = 'manual',                 // Elle toplama
  CROWDER = 'crowder',               // Sıkıştırma sistemi
}

registerEnumType(HarvestMethod, {
  name: 'HarvestMethod',
  description: 'Hasat yöntemi',
});

/**
 * Ürün formu
 */
export enum ProductForm {
  LIVE = 'live',                     // Canlı
  FRESH_WHOLE = 'fresh_whole',       // Taze bütün
  FRESH_GUTTED = 'fresh_gutted',     // Taze temizlenmiş
  FROZEN_WHOLE = 'frozen_whole',     // Dondurulmuş bütün
  FROZEN_GUTTED = 'frozen_gutted',   // Dondurulmuş temizlenmiş
  FILLET = 'fillet',                 // Fileto
  PROCESSED = 'processed',           // İşlenmiş
}

registerEnumType(ProductForm, {
  name: 'ProductForm',
  description: 'Ürün formu',
});

// ============================================================================
// INTERFACES
// ============================================================================

/**
 * Hasat kriterleri
 */
export interface HarvestCriteria {
  targetWeight: {
    min: number;                     // gram
    max: number;                     // gram
    target: number;                  // gram (ideal)
  };
  targetQuantity?: {
    value: number;
    unit: 'pieces' | 'kg' | 'percent';
  };
  qualityGrade?: string;             // A, B, C veya özel
  minimumConditionFactor?: number;   // Minimum K faktörü
}

/**
 * Tahminler
 */
export interface HarvestEstimates {
  estimatedQuantity: number;         // Adet
  estimatedBiomass: number;          // kg
  estimatedAvgWeight: number;        // gram
  estimatedYield: number;            // % (işleme sonrası)
  confidenceLevel: 'low' | 'medium' | 'high';
  basedOnMeasurementDate?: Date;
}

/**
 * Finansal projeksiyon
 */
export interface FinancialProjection {
  estimatedRevenue: number;
  estimatedPrice: number;            // birim fiyat
  priceUnit: 'per_kg' | 'per_piece';
  estimatedCost: number;
  estimatedProfit: number;
  margin: number;                    // %
  currency: string;
}

/**
 * Lojistik planı
 */
export interface LogisticsPlan {
  harvestStartTime?: string;         // "06:00"
  expectedDuration?: number;         // saat
  requiredEquipment?: string[];
  requiredPersonnel?: number;
  transportType?: 'truck' | 'boat' | 'container';
  transportCapacity?: number;        // kg
  destinationType?: 'processing' | 'market' | 'direct_sale' | 'export';
  destinationAddress?: string;
  coldChainRequired?: boolean;
}

/**
 * Müşteri/sipariş bilgisi
 */
export interface CustomerOrder {
  customerId?: string;
  customerName?: string;
  orderId?: string;
  orderQuantity?: number;
  orderUnit?: string;
  deliveryDate?: Date;
  contractPrice?: number;
}

/**
 * Kalite gereksinimleri
 */
export interface QualityRequirements {
  certifications?: string[];         // MSC, ASC, Organic, etc.
  sizeGrading?: boolean;
  qualityInspection?: boolean;
  traceabilityRequired?: boolean;
  specificRequirements?: string[];
}

// ============================================================================
// ENTITY
// ============================================================================

@ObjectType()
@Entity('harvest_plans')
@Index(['tenantId', 'batchId'])
@Index(['tenantId', 'planCode'], { unique: true })
@Index(['tenantId', 'status'])
@Index(['tenantId', 'plannedDate'])
@Index(['batchId', 'status'])
export class HarvestPlan {
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
  @Index()
  planCode: string;                  // HP-2024-00001

  @Field()
  @Column({ length: 200 })
  name: string;

  @Field({ nullable: true })
  @Column({ type: 'text', nullable: true })
  description?: string;

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
  // DURUM
  // -------------------------------------------------------------------------

  @Field(() => HarvestPlanStatus)
  @Column({
    type: 'enum',
    enum: HarvestPlanStatus,
    default: HarvestPlanStatus.DRAFT,
  })
  @Index()
  status: HarvestPlanStatus;

  @Field(() => HarvestType)
  @Column({
    type: 'enum',
    enum: HarvestType,
    default: HarvestType.FULL,
  })
  harvestType: HarvestType;

  // -------------------------------------------------------------------------
  // TARİHLER
  // -------------------------------------------------------------------------

  @Field()
  @Column({ type: 'date' })
  @Index()
  plannedDate: Date;

  @Field({ nullable: true })
  @Column({ type: 'date', nullable: true })
  confirmedDate?: Date;

  @Field({ nullable: true })
  @Column({ type: 'date', nullable: true })
  windowStartDate?: Date;            // Esnek tarih aralığı başlangıcı

  @Field({ nullable: true })
  @Column({ type: 'date', nullable: true })
  windowEndDate?: Date;              // Esnek tarih aralığı bitişi

  // -------------------------------------------------------------------------
  // HASAT KRİTERLERİ
  // -------------------------------------------------------------------------

  @Field(() => GraphQLJSON)
  @Column({ type: 'jsonb' })
  criteria: HarvestCriteria;

  @Field(() => HarvestMethod, { nullable: true })
  @Column({
    type: 'enum',
    enum: HarvestMethod,
    nullable: true,
  })
  harvestMethod?: HarvestMethod;

  @Field(() => ProductForm)
  @Column({
    type: 'enum',
    enum: ProductForm,
    default: ProductForm.FRESH_WHOLE,
  })
  productForm: ProductForm;

  // -------------------------------------------------------------------------
  // TAHMİNLER
  // -------------------------------------------------------------------------

  @Field(() => GraphQLJSON)
  @Column({ type: 'jsonb' })
  estimates: HarvestEstimates;

  // -------------------------------------------------------------------------
  // FİNANSAL PROJEKSİYON
  // -------------------------------------------------------------------------

  @Field(() => GraphQLJSON, { nullable: true })
  @Column({ type: 'jsonb', nullable: true })
  financialProjection?: FinancialProjection;

  // -------------------------------------------------------------------------
  // LOJİSTİK
  // -------------------------------------------------------------------------

  @Field(() => GraphQLJSON, { nullable: true })
  @Column({ type: 'jsonb', nullable: true })
  logistics?: LogisticsPlan;

  // -------------------------------------------------------------------------
  // MÜŞTERİ/SİPARİŞ
  // -------------------------------------------------------------------------

  @Field(() => GraphQLJSON, { nullable: true })
  @Column({ type: 'jsonb', nullable: true })
  customerOrder?: CustomerOrder;

  // -------------------------------------------------------------------------
  // KALİTE
  // -------------------------------------------------------------------------

  @Field(() => GraphQLJSON, { nullable: true })
  @Column({ type: 'jsonb', nullable: true })
  qualityRequirements?: QualityRequirements;

  // -------------------------------------------------------------------------
  // HASAT SONRASI GÜNCELLEME
  // -------------------------------------------------------------------------

  @Field(() => Int, { nullable: true })
  @Column({ type: 'int', nullable: true })
  actualQuantityHarvested?: number;

  @Field(() => Float, { nullable: true })
  @Column({ type: 'decimal', precision: 12, scale: 2, nullable: true })
  actualBiomassHarvested?: number;

  @Field(() => Float, { nullable: true })
  @Column({ type: 'decimal', precision: 10, scale: 2, nullable: true })
  actualAvgWeight?: number;

  // -------------------------------------------------------------------------
  // ONAY
  // -------------------------------------------------------------------------

  @Field({ nullable: true })
  @Column('uuid', { nullable: true })
  approvedBy?: string;

  @Field({ nullable: true })
  @Column({ type: 'timestamptz', nullable: true })
  approvedAt?: Date;

  // -------------------------------------------------------------------------
  // KULLANICI BİLGİLERİ
  // -------------------------------------------------------------------------

  @Field()
  @Column('uuid')
  createdBy: string;

  @Field({ nullable: true })
  @Column({ type: 'text', nullable: true })
  notes?: string;

  @Field(() => [String], { nullable: true })
  @Column({ type: 'simple-array', nullable: true })
  attachments?: string[];

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
   * Planı onayla
   */
  approve(approvedBy: string): void {
    this.status = HarvestPlanStatus.APPROVED;
    this.approvedBy = approvedBy;
    this.approvedAt = new Date();
  }

  /**
   * Kesin tarih belirle
   */
  schedule(confirmedDate: Date): void {
    this.confirmedDate = confirmedDate;
    this.status = HarvestPlanStatus.SCHEDULED;
  }

  /**
   * Hasatı başlat
   */
  startHarvest(): void {
    this.status = HarvestPlanStatus.IN_PROGRESS;
  }

  /**
   * Hasatı tamamla
   */
  complete(actualQuantity: number, actualBiomass: number, actualAvgWeight: number): void {
    this.status = HarvestPlanStatus.COMPLETED;
    this.actualQuantityHarvested = actualQuantity;
    this.actualBiomassHarvested = actualBiomass;
    this.actualAvgWeight = actualAvgWeight;
  }

  /**
   * Planı iptal et
   */
  cancel(): void {
    this.status = HarvestPlanStatus.CANCELLED;
  }

  /**
   * Planı ertele
   */
  postpone(newDate: Date): void {
    this.status = HarvestPlanStatus.POSTPONED;
    this.plannedDate = newDate;
    this.confirmedDate = undefined;
  }

  /**
   * Hasat için uygun mu? (sağlık kontrolleri)
   */
  isHarvestAllowed(): boolean {
    // Health check'ler yapılmalı
    // Withdrawal period kontrolü
    return true;
  }

  /**
   * Varyansları hesapla
   */
  calculateVariances(): {
    quantityVariance: number;
    biomassVariance: number;
    weightVariance: number;
  } | null {
    if (!this.actualQuantityHarvested || !this.actualBiomassHarvested) {
      return null;
    }

    const quantityVariance = ((this.actualQuantityHarvested - this.estimates.estimatedQuantity) /
      this.estimates.estimatedQuantity) * 100;

    const biomassVariance = ((this.actualBiomassHarvested - this.estimates.estimatedBiomass) /
      this.estimates.estimatedBiomass) * 100;

    const weightVariance = this.actualAvgWeight
      ? ((this.actualAvgWeight - this.estimates.estimatedAvgWeight) /
          this.estimates.estimatedAvgWeight) * 100
      : 0;

    return {
      quantityVariance,
      biomassVariance,
      weightVariance,
    };
  }

  /**
   * Tahmini tarih aralığında mı?
   */
  isWithinWindow(): boolean {
    if (!this.windowStartDate || !this.windowEndDate) return true;

    const now = new Date();
    return now >= new Date(this.windowStartDate) && now <= new Date(this.windowEndDate);
  }

  /**
   * Kalan günler
   */
  getDaysUntilHarvest(): number {
    const targetDate = this.confirmedDate || this.plannedDate;
    const diff = new Date(targetDate).getTime() - new Date().getTime();
    return Math.ceil(diff / (24 * 60 * 60 * 1000));
  }
}
