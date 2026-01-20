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
  recordCode: string;                // HR-2024-00001

  @Field()
  @Column({ length: 50 })
  @Index()
  lotNumber: string;                 // LOT-2024-00001

  // -------------------------------------------------------------------------
  // BATCH & PLAN İLİŞKİSİ
  // -------------------------------------------------------------------------

  @Field()
  @Column('uuid')
  @Index()
  batchId: string;

  @ManyToOne('Batch', { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'batchId' })
  batch: any;

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
  tank?: any;

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
  status: HarvestRecordStatus;

  // -------------------------------------------------------------------------
  // HASAT TARİHİ VE OPERASYON
  // -------------------------------------------------------------------------

  @Field()
  @Column({ type: 'date' })
  @Index()
  harvestDate: Date;

  @Field(() => GraphQLJSON)
  @Column({ type: 'jsonb' })
  operation: HarvestOperation;

  @Field(() => HarvestMethod)
  @Column({
    type: 'enum',
    enum: HarvestMethod,
    default: HarvestMethod.NET,
  })
  method: HarvestMethod;

  // -------------------------------------------------------------------------
  // MİKTAR BİLGİLERİ
  // -------------------------------------------------------------------------

  @Field(() => Int)
  @Column({ type: 'int' })
  quantityHarvested: number;         // Adet

  @Field(() => Float)
  @Column({ type: 'decimal', precision: 12, scale: 2 })
  totalBiomass: number;              // kg (brüt)

  @Field(() => Float)
  @Column({ type: 'decimal', precision: 10, scale: 2 })
  averageWeight: number;             // gram

  @Field(() => Float, { nullable: true })
  @Column({ type: 'decimal', precision: 10, scale: 2, nullable: true })
  minWeight?: number;                // gram

  @Field(() => Float, { nullable: true })
  @Column({ type: 'decimal', precision: 10, scale: 2, nullable: true })
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
  productForm: ProductForm;

  @Field(() => QualityGrade)
  @Column({
    type: 'enum',
    enum: QualityGrade,
    default: QualityGrade.GRADE_A,
  })
  qualityGrade: QualityGrade;

  // -------------------------------------------------------------------------
  // KALİTE KONTROL
  // -------------------------------------------------------------------------

  @Field(() => GraphQLJSON, { nullable: true })
  @Column({ type: 'jsonb', nullable: true })
  qualityControl?: QualityControlResults;

  @Field()
  @Column({ default: false })
  qualityApproved: boolean;

  // -------------------------------------------------------------------------
  // LOT BİLGİLERİ
  // -------------------------------------------------------------------------

  @Field(() => GraphQLJSON)
  @Column({ type: 'jsonb' })
  lotInfo: LotInfo;

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

  @Field(() => Float, { nullable: true })
  @Column({ type: 'decimal', precision: 15, scale: 2, nullable: true })
  totalRevenue?: number;

  @Field(() => Float, { nullable: true })
  @Column({ type: 'decimal', precision: 15, scale: 2, nullable: true })
  harvestCost?: number;

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
  @Column({ type: 'decimal', precision: 10, scale: 2, nullable: true })
  rejectedQuantity?: number;         // Reddedilen kg

  @Field({ nullable: true })
  @Column({ type: 'text', nullable: true })
  rejectionReason?: string;

  // -------------------------------------------------------------------------
  // KULLANICI BİLGİLERİ
  // -------------------------------------------------------------------------

  @Field()
  @Column('uuid')
  supervisorId: string;              // Hasat sorumlusu

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
