/**
 * HarvestRecord Entity - Hasat Kaydı
 *
 * Gerçekleşen hasat operasyonunun detaylı kaydı.
 * Kalite kontrolü, lot takibi ve izlenebilirlik.
 *
 * Özellikler:
 * - Detaylı hasat verisi
 * - Lot/parti numarası oluşturma
 * - Kalite kontrol kayıtları
 * - Boy sınıflandırması
 * - Müşteri sevkiyat bilgileri
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
// Note: Batch and Tank are referenced via string to avoid circular dependency
// Type-only imports for TypeScript type checking
import type { Batch } from '../../batch/entities/batch.entity';
import type { Equipment } from '../../equipment/entities/equipment.entity';
import { HarvestPlan, HarvestMethod, ProductForm } from './harvest-plan.entity';

// ============================================================================
// ENUMS
// ============================================================================

/**
 * Hasat durumu
 */
export enum HarvestRecordStatus {
  IN_PROGRESS = 'in_progress',
  COMPLETED = 'completed',
  QUALITY_CHECK = 'quality_check',
  DISPATCHED = 'dispatched',
  DELIVERED = 'delivered',
  CANCELLED = 'cancelled',
}

registerEnumType(HarvestRecordStatus, {
  name: 'HarvestRecordStatus',
  description: 'Hasat kaydı durumu',
});

/**
 * Boy sınıfı
 */
export enum SizeGrade {
  EXTRA_SMALL = 'xs',                // < 200g
  SMALL = 's',                       // 200-300g
  MEDIUM = 'm',                      // 300-400g
  LARGE = 'l',                       // 400-500g
  EXTRA_LARGE = 'xl',                // 500-700g
  JUMBO = 'xxl',                     // > 700g
}

registerEnumType(SizeGrade, {
  name: 'SizeGrade',
  description: 'Boy sınıfı',
});

/**
 * Kalite sınıfı
 */
export enum QualityGrade {
  PREMIUM = 'premium',               // En üst kalite
  GRADE_A = 'grade_a',               // A kalite
  GRADE_B = 'grade_b',               // B kalite
  GRADE_C = 'grade_c',               // C kalite
  REJECT = 'reject',                 // Red
}

registerEnumType(QualityGrade, {
  name: 'QualityGrade',
  description: 'Kalite sınıfı',
});

/**
 * Norwegian official slaughter quality class (kvalitetsklasse) — the taxonomy
 * the Mattilsynet slakt report requires and, since Phase 4 (RPT-007), the SOLE
 * stored quality taxonomy on harvest_records.
 *
 * The retired 5-level `qualityGrade` column was dropped
 * (DropHarvestQualityGrade1804300000000); `qualityGrade` survives only as a
 * DERIVED read alias (classToDisplayGrade). The grade→class map is lossy
 * (PREMIUM and GRADE_A both collapse to SUPERIOR), so the historical
 * Premium/Grade-A distinction is not recoverable — this was the accepted
 * tradeoff of the operator decision to make the regulator format the SSoT.
 */
export enum QualityClass {
  SUPERIOR = 'superior',
  ORDINAER = 'ordinaer',
  PRODUKSJONSFISK = 'produksjonsfisk',
  UTKAST = 'utkast',
}

registerEnumType(QualityClass, {
  name: 'QualityClass',
  description: 'Norwegian official slaughter quality class (kvalitetsklasse)',
});

/**
 * Deterministic map from the platform's display grade to the official quality
 * class — the SSoT shared by the create handler and the migration backfill
 * (the migration mirrors this exact mapping in SQL). The 5→4 collapse is
 * intentional: Superior is the premium export grade, Utkast the reject.
 */
export const QUALITY_GRADE_TO_CLASS: Readonly<Record<QualityGrade, QualityClass>> = Object.freeze({
  [QualityGrade.PREMIUM]: QualityClass.SUPERIOR,
  [QualityGrade.GRADE_A]: QualityClass.SUPERIOR,
  [QualityGrade.GRADE_B]: QualityClass.ORDINAER,
  [QualityGrade.GRADE_C]: QualityClass.PRODUKSJONSFISK,
  [QualityGrade.REJECT]: QualityClass.UTKAST,
});

export function qualityGradeToClass(grade: QualityGrade): QualityClass {
  return QUALITY_GRADE_TO_CLASS[grade] ?? QualityClass.ORDINAER;
}

/**
 * Representative display grade per quality class — the lossy inverse used to
 * render the retired 5-level `qualityGrade` as a DERIVED display alias now that
 * `quality_class` is the sole stored taxonomy (RPT-007, Phase 4). PREMIUM is
 * unreachable by construction (SUPERIOR maps back to GRADE_A) — accepted, since
 * the class cannot distinguish premium from A.
 */
export const CLASS_TO_DISPLAY_GRADE: Readonly<Record<QualityClass, QualityGrade>> = Object.freeze({
  [QualityClass.SUPERIOR]: QualityGrade.GRADE_A,
  [QualityClass.ORDINAER]: QualityGrade.GRADE_B,
  [QualityClass.PRODUKSJONSFISK]: QualityGrade.GRADE_C,
  [QualityClass.UTKAST]: QualityGrade.REJECT,
});

export function classToDisplayGrade(qualityClass: QualityClass): QualityGrade {
  return CLASS_TO_DISPLAY_GRADE[qualityClass] ?? QualityGrade.GRADE_B;
}

// ============================================================================
// INTERFACES
// ============================================================================

/**
 * Hasat operasyon detayları
 */
export interface HarvestOperation {
  startTime: Date;
  endTime?: Date;
  durationMinutes?: number;
  method: HarvestMethod;
  equipmentUsed?: string[];
  personnel?: {
    userId: string;
    userName?: string;
    role: 'supervisor' | 'operator' | 'helper';
  }[];
  waterConditions?: {
    temperature?: number;
    dissolvedOxygen?: number;
  };
  weatherConditions?: string;
}

/**
 * Boy dağılımı
 */
export interface SizeDistribution {
  grade: SizeGrade;
  quantity: number;
  percentage: number;
  avgWeight: number;                 // gram
  totalWeight: number;               // kg
}

/**
 * Kalite kontrol sonuçları
 */
export interface QualityControlResults {
  inspectionDate: Date;
  inspectorId: string;
  inspectorName?: string;

  // Fiziksel kontrol
  overallGrade: QualityGrade;
  appearance: 'excellent' | 'good' | 'acceptable' | 'poor';
  freshness: 'excellent' | 'good' | 'acceptable' | 'poor';
  texture: 'excellent' | 'good' | 'acceptable' | 'poor';
  odor: 'normal' | 'slight_off' | 'off';

  // Defektler
  defects?: {
    type: string;
    count: number;
    percentage: number;
  }[];
  totalDefectPercentage?: number;

  // Sertifikasyon kontrolleri
  certificationChecks?: {
    certification: string;
    passed: boolean;
    notes?: string;
  }[];

  // Notlar
  notes?: string;
  passed: boolean;
}

/**
 * Lot/parti bilgileri
 */
export interface LotInfo {
  lotNumber: string;                 // LOT-2024-00001
  traceabilityCode?: string;         // Benzersiz izlenebilirlik kodu
  productionDate: Date;
  bestBeforeDate?: Date;
  storageConditions?: string;
  packagingType?: string;
  packagingUnit?: string;
  unitsPerPackage?: number;
  totalPackages?: number;
}

/**
 * Sevkiyat bilgileri
 */
export interface ShipmentInfo {
  shipmentId?: string;
  dispatchDate?: Date;
  dispatchTime?: string;
  carrier?: string;
  vehiclePlate?: string;
  driverName?: string;
  driverPhone?: string;
  destination: string;
  expectedArrival?: Date;
  actualArrival?: Date;
  temperatureAtDispatch?: number;
  temperatureAtArrival?: number;
  notes?: string;
}

/**
 * Müşteri sevkiyat
 */
export interface CustomerDelivery {
  customerId: string;
  customerName: string;
  orderId?: string;
  quantity: number;
  quantityUnit: 'kg' | 'pieces';
  unitPrice: number;
  totalValue: number;
  currency: string;
  invoiceNumber?: string;
  deliveryStatus: 'pending' | 'dispatched' | 'delivered' | 'rejected';
  rejectionReason?: string;
}

/**
 * Verim hesaplama
 */
export interface YieldCalculation {
  grossWeight: number;               // kg (işlenmemiş)
  netWeight: number;                 // kg (işlenmiş)
  yieldPercentage: number;           // %
  byProductWeight?: number;          // kg (yan ürün)
  wasteWeight?: number;              // kg (atık)
}

// ============================================================================
// ENTITY
// ============================================================================

@ObjectType()
@Entity('harvest_records')
@Index(['tenantId', 'batchId', 'harvestDate'])
@Index(['tenantId', 'recordCode'], { unique: true })
@Index(['tenantId', 'lotNumber'], { unique: true })
@Index(['tenantId', 'harvestDate'])
@Index(['tenantId', 'status'])
@Index(['batchId', 'harvestDate'])
export class HarvestRecord {
  @Field(() => ID)
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Field()
  @Column('uuid')
  @Index()
  tenantId!: string;

  // -------------------------------------------------------------------------
  // TEMEL BİLGİLER
  // -------------------------------------------------------------------------

  @Field()
  @Column({ length: 50 })
  @Index()
  recordCode!: string;                // HR-2024-00001

  @Field()
  @Column({ length: 50 })
  @Index()
  lotNumber!: string;                 // LOT-2024-00001

  // -------------------------------------------------------------------------
  // BATCH & PLAN İLİŞKİSİ
  // -------------------------------------------------------------------------

  @Field()
  @Column('uuid')
  @Index()
  batchId!: string;

  @ManyToOne('Batch', { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'batchId' })
  batch?: Batch;

  @Field({ nullable: true })
  @Column('uuid', { nullable: true })
  harvestPlanId?: string;

  @ManyToOne(() => HarvestPlan, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'harvestPlanId' })
  harvestPlan?: HarvestPlan;

  // -------------------------------------------------------------------------
  // LOKASYON
  // -------------------------------------------------------------------------

  @Field({ nullable: true })
  @Column('uuid', { nullable: true })
  tankId?: string;

  @ManyToOne('Tank', { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'tankId' })
  tank?: Equipment;

  @Field({ nullable: true })
  @Column('uuid', { nullable: true })
  pondId?: string;

  // -------------------------------------------------------------------------
  // DURUM
  // -------------------------------------------------------------------------

  @Field(() => HarvestRecordStatus)
  @Column({
    type: 'enum',
    enum: HarvestRecordStatus,
    default: HarvestRecordStatus.IN_PROGRESS,
  })
  @Index()
  status!: HarvestRecordStatus;

  // -------------------------------------------------------------------------
  // HASAT TARİHİ VE OPERASYON
  // -------------------------------------------------------------------------

  @Field()
  @Column({ type: 'date' })
  @Index()
  harvestDate!: Date;

  @Field(() => GraphQLJSON)
  @Column({ type: 'jsonb' })
  operation!: HarvestOperation;

  @Field(() => HarvestMethod)
  @Column({
    type: 'enum',
    enum: HarvestMethod,
    default: HarvestMethod.NET,
  })
  method!: HarvestMethod;

  // -------------------------------------------------------------------------
  // MİKTAR BİLGİLERİ
  // -------------------------------------------------------------------------

  @Field(() => Int)
  @Column({ type: 'int' })
  quantityHarvested!: number;         // Adet

  @Field(() => Float)
  @Column({ type: 'decimal', precision: 12, scale: 2, transformer: new DecimalTransformer() })
  totalBiomass!: number;              // kg (brüt)

  @Field(() => Float)
  @Column({ type: 'decimal', precision: 10, scale: 2, transformer: new DecimalTransformer() })
  averageWeight!: number;             // gram

  @Field(() => Float, { nullable: true })
  @Column({ type: 'decimal', precision: 10, scale: 2, nullable: true, transformer: new DecimalTransformer() })
  minWeight?: number;                // gram

  @Field(() => Float, { nullable: true })
  @Column({ type: 'decimal', precision: 10, scale: 2, nullable: true, transformer: new DecimalTransformer() })
  maxWeight?: number;                // gram

  // -------------------------------------------------------------------------
  // BOY DAĞILIMI
  // -------------------------------------------------------------------------

  @Field(() => GraphQLJSON, { nullable: true })
  @Column({ type: 'jsonb', nullable: true })
  sizeDistribution?: SizeDistribution[];

  // -------------------------------------------------------------------------
  // ÜRÜN BİLGİLERİ
  // -------------------------------------------------------------------------

  @Field(() => ProductForm)
  @Column({
    type: 'enum',
    enum: ProductForm,
    default: ProductForm.FRESH_WHOLE,
  })
  productForm!: ProductForm;

  /**
   * Official Norwegian quality class (kvalitetsklasse) — the sole stored quality
   * taxonomy and the slakt-report truth (RPT-007). The retired 5-level
   * `qualityGrade` column was dropped in Phase 4
   * (DropHarvestQualityGrade1804300000000); operators now select the class
   * directly.
   */
  @Field(() => QualityClass)
  @Column({
    type: 'enum',
    enum: QualityClass,
    default: QualityClass.ORDINAER,
  })
  qualityClass!: QualityClass;

  /**
   * Retired 5-level display grade, now DERIVED (not stored) from qualityClass
   * so existing read clients keep a `qualityGrade` field. Lossy alias: SUPERIOR
   * renders as GRADE_A (PREMIUM is unreachable). No @Column — never persisted.
   */
  @Field(() => QualityGrade, {
    description: 'DEPRECATED display alias derived from qualityClass; use qualityClass.',
  })
  get qualityGrade(): QualityGrade {
    return classToDisplayGrade(this.qualityClass);
  }

  // -------------------------------------------------------------------------
  // KALİTE KONTROL
  // -------------------------------------------------------------------------

  @Field(() => GraphQLJSON, { nullable: true })
  @Column({ type: 'jsonb', nullable: true })
  qualityControl?: QualityControlResults;

  @Field()
  @Column({ default: false })
  qualityApproved!: boolean;

  // -------------------------------------------------------------------------
  // LOT BİLGİLERİ
  // -------------------------------------------------------------------------

  @Field(() => GraphQLJSON)
  @Column({ type: 'jsonb' })
  lotInfo!: LotInfo;

  // -------------------------------------------------------------------------
  // VERİM
  // -------------------------------------------------------------------------

  @Field(() => GraphQLJSON, { nullable: true })
  @Column({ type: 'jsonb', nullable: true })
  yieldCalculation?: YieldCalculation;

  // -------------------------------------------------------------------------
  // SEVKİYAT
  // -------------------------------------------------------------------------

  @Field(() => GraphQLJSON, { nullable: true })
  @Column({ type: 'jsonb', nullable: true })
  shipment?: ShipmentInfo;

  @Field(() => GraphQLJSON, { nullable: true })
  @Column({ type: 'jsonb', nullable: true })
  customerDeliveries?: CustomerDelivery[];

  // -------------------------------------------------------------------------
  // FİNANSAL
  // -------------------------------------------------------------------------

  @Field(() => Float, {
    nullable: true,
    deprecationReason: 'Use totalRevenueDecimal (exact decimal string, ADR-0004).',
  })
  @Column({ type: 'decimal', precision: 15, scale: 2, nullable: true, transformer: new DecimalTransformer() })
  totalRevenue?: number;

  /** Exact-decimal wire form of `totalRevenue` (ADR-0004 / DATA-MEDIUM-009). */
  @Field(() => DecimalScalar, { nullable: true })
  get totalRevenueDecimal(): number | null {
    return this.totalRevenue ?? null;
  }

  @Field(() => Float, {
    nullable: true,
    deprecationReason: 'Use harvestCostDecimal (exact decimal string, ADR-0004).',
  })
  @Column({ type: 'decimal', precision: 15, scale: 2, nullable: true, transformer: new DecimalTransformer() })
  harvestCost?: number;

  /** Exact-decimal wire form of `harvestCost` (ADR-0004 / DATA-MEDIUM-009). */
  @Field(() => DecimalScalar, { nullable: true })
  get harvestCostDecimal(): number | null {
    return this.harvestCost ?? null;
  }

  @Field({ nullable: true })
  @Column({ length: 3, nullable: true })
  currency?: string;

  // -------------------------------------------------------------------------
  // MORTALITY & WASTE
  // -------------------------------------------------------------------------

  @Field(() => Int, { nullable: true })
  @Column({ type: 'int', nullable: true })
  mortalityDuringHarvest?: number;   // Hasat sırasında ölen

  @Field(() => Float, { nullable: true })
  @Column({ type: 'decimal', precision: 10, scale: 2, nullable: true, transformer: new DecimalTransformer() })
  rejectedQuantity?: number;         // Reddedilen kg

  @Field({ nullable: true })
  @Column({ type: 'text', nullable: true })
  rejectionReason?: string;

  // -------------------------------------------------------------------------
  // KULLANICI BİLGİLERİ
  // -------------------------------------------------------------------------

  @Field()
  @Column('uuid')
  supervisorId!: string;              // Hasat sorumlusu

  @Field({ nullable: true })
  @Column('uuid', { nullable: true })
  approvedBy?: string;

  @Field({ nullable: true })
  @Column({ type: 'timestamptz', nullable: true })
  approvedAt?: Date;

  @Field({ nullable: true })
  @Column({ type: 'text', nullable: true })
  notes?: string;

  @Field(() => [String], { nullable: true })
  @Column({ type: 'simple-array', nullable: true })
  attachments?: string[];            // Fotoğraflar

  // -------------------------------------------------------------------------
  // AUDIT FIELDS
  // -------------------------------------------------------------------------

  @Field({ nullable: true, description: 'User ID who last updated this record (regulatory audit trail)' })
  @Column({ type: 'uuid', nullable: true })
  updatedBy?: string;

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
   * Kalite kontrolünü onayla
   */
  approveQuality(approvedBy: string): void {
    this.qualityApproved = true;
    this.approvedBy = approvedBy;
    this.approvedAt = new Date();
    this.status = HarvestRecordStatus.QUALITY_CHECK;
  }

  /**
   * Sevkiyata hazırla
   */
  prepareForShipment(shipment: ShipmentInfo): void {
    this.shipment = shipment;
    this.status = HarvestRecordStatus.DISPATCHED;
  }

  /**
   * Teslim edildi olarak işaretle
   */
  markDelivered(): void {
    this.status = HarvestRecordStatus.DELIVERED;
    if (this.shipment) {
      this.shipment.actualArrival = new Date();
    }
  }

  /**
   * Hasatı tamamla
   */
  complete(): void {
    this.status = HarvestRecordStatus.COMPLETED;
    if (this.operation && !this.operation.endTime) {
      this.operation.endTime = new Date();
      this.operation.durationMinutes = Math.round(
        (this.operation.endTime.getTime() - new Date(this.operation.startTime).getTime()) / 60000
      );
    }
  }

  /**
   * Verim hesapla
   */
  calculateYield(processedWeight: number): void {
    this.yieldCalculation = {
      grossWeight: this.totalBiomass,
      netWeight: processedWeight,
      yieldPercentage: (processedWeight / this.totalBiomass) * 100,
      wasteWeight: this.totalBiomass - processedWeight,
    };
  }

  /**
   * Ortalama fiyat hesapla
   */
  calculateAveragePrice(): number | null {
    if (!this.totalRevenue || !this.totalBiomass) return null;
    return this.totalRevenue / this.totalBiomass;
  }

  /**
   * Müşteri bazlı toplam geliri hesapla
   */
  calculateTotalCustomerRevenue(): number {
    if (!this.customerDeliveries) return 0;
    return this.customerDeliveries.reduce(
      (sum, delivery) => sum + delivery.totalValue,
      0
    );
  }

  /**
   * Boy dağılımı istatistiklerini hesapla
   */
  calculateSizeStats(): { predominantGrade: SizeGrade; uniformity: number } | null {
    if (!this.sizeDistribution || this.sizeDistribution.length === 0) {
      return null;
    }

    // En çok olan grade
    const firstDist = this.sizeDistribution[0];
    if (!firstDist) return null;

    const predominantGrade = this.sizeDistribution.reduce(
      (max, dist) => dist.percentage > max.percentage ? dist : max,
      firstDist
    ).grade;

    // Uniformity (en büyük grubun yüzdesi)
    const uniformity = Math.max(...this.sizeDistribution.map(d => d.percentage));

    return { predominantGrade, uniformity };
  }
}
