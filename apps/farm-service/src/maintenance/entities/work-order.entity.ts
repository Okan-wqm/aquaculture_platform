/**
 * WorkOrder Entity - İş Emirleri
 *
 * Bakım, onarım ve rutin işlerin takibi.
 * Önleyici ve düzeltici bakım yönetimi.
 *
 * Özellikler:
 * - İş emri oluşturma ve atama
 * - Öncelik ve deadline yönetimi
 * - Kaynak ve malzeme takibi
 * - İş süresi ve maliyet hesaplama
 * - Onay akışı
 *
 * @module Maintenance
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

// ============================================================================
// ENUMS
// ============================================================================

/**
 * İş emri tipi
 */
export enum WorkOrderType {
  PREVENTIVE = 'preventive',         // Önleyici bakım
  CORRECTIVE = 'corrective',         // Düzeltici (arıza)
  EMERGENCY = 'emergency',           // Acil
  INSPECTION = 'inspection',         // Denetim/kontrol
  CALIBRATION = 'calibration',       // Kalibrasyon
  CLEANING = 'cleaning',             // Temizlik
  INSTALLATION = 'installation',     // Kurulum
  UPGRADE = 'upgrade',               // Yükseltme
  ROUTINE = 'routine',               // Rutin iş
}

registerEnumType(WorkOrderType, {
  name: 'WorkOrderType',
  description: 'İş emri tipi',
});

/**
 * İş emri durumu
 */
export enum WorkOrderStatus {
  DRAFT = 'draft',                   // Taslak
  PENDING_APPROVAL = 'pending_approval', // Onay bekliyor
  APPROVED = 'approved',             // Onaylandı
  SCHEDULED = 'scheduled',           // Planlandı
  IN_PROGRESS = 'in_progress',       // Devam ediyor
  ON_HOLD = 'on_hold',               // Beklemede
  COMPLETED = 'completed',           // Tamamlandı
  VERIFIED = 'verified',             // Doğrulandı
  CANCELLED = 'cancelled',           // İptal
}

registerEnumType(WorkOrderStatus, {
  name: 'WorkOrderStatus',
  description: 'İş emri durumu',
});

/**
 * Öncelik seviyesi
 */
export enum WorkOrderPriority {
  LOW = 'low',
  MEDIUM = 'medium',
  HIGH = 'high',
  CRITICAL = 'critical',
}

registerEnumType(WorkOrderPriority, {
  name: 'WorkOrderPriority',
  description: 'Öncelik seviyesi',
});

/**
 * Varlık tipi (iş emrinin ilişkili olduğu)
 */
export enum AssetType {
  TANK = 'tank',
  POND = 'pond',
  EQUIPMENT = 'equipment',
  BUILDING = 'building',
  VEHICLE = 'vehicle',
  SENSOR = 'sensor',
  PUMP = 'pump',
  FEEDER = 'feeder',
  AERATOR = 'aerator',
  GENERATOR = 'generator',
  OTHER = 'other',
}

registerEnumType(AssetType, {
  name: 'AssetType',
  description: 'Varlık tipi',
});

// ============================================================================
// INTERFACES
// ============================================================================

/**
 * Checklist öğesi
 */
export interface ChecklistItem {
  id: string;
  description: string;
  isCompleted: boolean;
  completedAt?: Date;
  completedBy?: string;
  notes?: string;
  isRequired: boolean;
}

/**
 * Kullanılan malzeme
 */
export interface UsedMaterial {
  materialId?: string;
  name: string;
  quantity: number;
  unit: string;
  unitCost?: number;
  totalCost?: number;
  batchNumber?: string;
}

/**
 * İşçilik kaydı
 */
export interface LaborRecord {
  userId: string;
  userName?: string;
  startTime: Date;
  endTime?: Date;
  durationMinutes?: number;
  hourlyRate?: number;
  totalCost?: number;
  notes?: string;
}

/**
 * Maliyet özeti
 */
export interface CostSummary {
  laborCost: number;
  materialCost: number;
  externalServiceCost: number;
  otherCosts: number;
  totalCost: number;
  currency: string;
}

/**
 * İlişkili varlık
 */
export interface RelatedAsset {
  assetType: AssetType;
  assetId: string;
  assetCode?: string;
  assetName?: string;
}

// ============================================================================
// ENTITY
// ============================================================================

@ObjectType()
@Entity('work_orders')
@Index(['tenantId', 'status', 'priority'])
@Index(['tenantId', 'workOrderCode'], { unique: true })
@Index(['tenantId', 'assignedTo', 'status'])
@Index(['tenantId', 'dueDate'])
@Index(['tenantId', 'type'])
@Index(['assetType', 'assetId', 'tenantId'])
export class WorkOrder {
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
  workOrderCode: string;             // WO-2024-00001

  @Field()
  @Column({ length: 200 })
  title: string;

  @Field({ nullable: true })
  @Column({ type: 'text', nullable: true })
  description?: string;

  @Field(() => WorkOrderType)
  @Column({
    type: 'enum',
    enum: WorkOrderType,
    default: WorkOrderType.CORRECTIVE,
  })
  @Index()
  type: WorkOrderType;

  @Field(() => WorkOrderStatus)
  @Column({
    type: 'enum',
    enum: WorkOrderStatus,
    default: WorkOrderStatus.DRAFT,
  })
  @Index()
  status: WorkOrderStatus;

  @Field(() => WorkOrderPriority)
  @Column({
    type: 'enum',
    enum: WorkOrderPriority,
    default: WorkOrderPriority.MEDIUM,
  })
  @Index()
  priority: WorkOrderPriority;

  // -------------------------------------------------------------------------
  // İLİŞKİLİ VARLIK
  // -------------------------------------------------------------------------

  @Field(() => AssetType, { nullable: true })
  @Column({
    type: 'enum',
    enum: AssetType,
    nullable: true,
  })
  @Index()
  assetType?: AssetType;

  @Field({ nullable: true })
  @Column('uuid', { nullable: true })
  @Index()
  assetId?: string;

  @Field(() => GraphQLJSON, { nullable: true })
  @Column({ type: 'jsonb', nullable: true })
  relatedAsset?: RelatedAsset;

  // -------------------------------------------------------------------------
  // PLANLAMA
  // -------------------------------------------------------------------------

  @Field({ nullable: true })
  @Column({ type: 'date', nullable: true })
  @Index()
  plannedStartDate?: Date;

  @Field({ nullable: true })
  @Column({ type: 'date', nullable: true })
  @Index()
  dueDate?: Date;

  @Field(() => Int, { nullable: true })
  @Column({ type: 'int', nullable: true })
  estimatedDurationMinutes?: number;

  // -------------------------------------------------------------------------
  // GERÇEKLEŞEN
  // -------------------------------------------------------------------------

  @Field({ nullable: true })
  @Column({ type: 'timestamptz', nullable: true })
  actualStartTime?: Date;

  @Field({ nullable: true })
  @Column({ type: 'timestamptz', nullable: true })
  actualEndTime?: Date;

  @Field(() => Int, { nullable: true })
  @Column({ type: 'int', nullable: true })
  actualDurationMinutes?: number;

  // -------------------------------------------------------------------------
  // ATAMA
  // -------------------------------------------------------------------------

  @Field({ nullable: true })
  @Column('uuid', { nullable: true })
  @Index()
  assignedTo?: string;               // Atanan kullanıcı

  @Field({ nullable: true })
  @Column('uuid', { nullable: true })
  assignedTeamId?: string;           // Atanan ekip

  @Field()
  @Column('uuid')
  createdBy: string;

  @Field({ nullable: true })
  @Column('uuid', { nullable: true })
  approvedBy?: string;

  @Field({ nullable: true })
  @Column({ type: 'timestamptz', nullable: true })
  approvedAt?: Date;

  // -------------------------------------------------------------------------
  // CHECKLIST
  // -------------------------------------------------------------------------

  @Field(() => GraphQLJSON, { nullable: true })
  @Column({ type: 'jsonb', nullable: true })
  checklist?: ChecklistItem[];

  @Field(() => Int, { nullable: true })
  @Column({ type: 'int', nullable: true })
  checklistProgress?: number;        // % tamamlanan

  // -------------------------------------------------------------------------
  // MALZEME VE İŞÇİLİK
  // -------------------------------------------------------------------------

  @Field(() => GraphQLJSON, { nullable: true })
  @Column({ type: 'jsonb', nullable: true })
  usedMaterials?: UsedMaterial[];

  @Field(() => GraphQLJSON, { nullable: true })
  @Column({ type: 'jsonb', nullable: true })
  laborRecords?: LaborRecord[];

  // -------------------------------------------------------------------------
  // MALİYET
  // -------------------------------------------------------------------------

  @Field(() => Float, { nullable: true })
  @Column({ type: 'decimal', precision: 15, scale: 2, nullable: true })
  estimatedCost?: number;

  @Field(() => GraphQLJSON, { nullable: true })
  @Column({ type: 'jsonb', nullable: true })
  costSummary?: CostSummary;

  @Field({ nullable: true })
  @Column({ length: 3, nullable: true })
  currency?: string;

  // -------------------------------------------------------------------------
  // BAKIM SCHEDULE İLİŞKİSİ
  // -------------------------------------------------------------------------

  @Field({ nullable: true })
  @Column('uuid', { nullable: true })
  maintenanceScheduleId?: string;    // Bağlı bakım planı

  @Field()
  @Column({ default: false })
  isRecurring: boolean;              // Tekrarlayan mı

  // -------------------------------------------------------------------------
  // TAMAMLAMA
  // -------------------------------------------------------------------------

  @Field({ nullable: true })
  @Column({ type: 'text', nullable: true })
  completionNotes?: string;

  @Field({ nullable: true })
  @Column('uuid', { nullable: true })
  completedBy?: string;

  @Field({ nullable: true })
  @Column({ type: 'timestamptz', nullable: true })
  completedAt?: Date;

  @Field({ nullable: true })
  @Column('uuid', { nullable: true })
  verifiedBy?: string;

  @Field({ nullable: true })
  @Column({ type: 'timestamptz', nullable: true })
  verifiedAt?: Date;

  // -------------------------------------------------------------------------
  // İLİŞKİLİ OLAYLAR
  // -------------------------------------------------------------------------

  @Field({ nullable: true })
  @Column('uuid', { nullable: true })
  relatedHealthEventId?: string;     // İlişkili sağlık olayı

  @Field({ nullable: true })
  @Column('uuid', { nullable: true })
  relatedAlertIncidentId?: string;   // İlişkili alarm

  // -------------------------------------------------------------------------
  // NOTLAR VE EKLER
  // -------------------------------------------------------------------------

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
   * İş emrini başlat
   */
  start(): void {
    this.status = WorkOrderStatus.IN_PROGRESS;
    this.actualStartTime = new Date();
  }

  /**
   * İş emrini tamamla
   */
  complete(completedBy: string, notes?: string): void {
    this.status = WorkOrderStatus.COMPLETED;
    this.actualEndTime = new Date();
    this.completedBy = completedBy;
    this.completedAt = new Date();
    if (notes) {
      this.completionNotes = notes;
    }

    // Süre hesapla
    if (this.actualStartTime) {
      this.actualDurationMinutes = Math.round(
        (this.actualEndTime.getTime() - this.actualStartTime.getTime()) / 60000
      );
    }
  }

  /**
   * İş emrini doğrula
   */
  verify(verifiedBy: string): void {
    this.status = WorkOrderStatus.VERIFIED;
    this.verifiedBy = verifiedBy;
    this.verifiedAt = new Date();
  }

  /**
   * İş emrini iptal et
   */
  cancel(): void {
    this.status = WorkOrderStatus.CANCELLED;
  }

  /**
   * Beklemede olarak işaretle
   */
  putOnHold(): void {
    this.status = WorkOrderStatus.ON_HOLD;
  }

  /**
   * Checklist ilerlemesini hesapla
   */
  calculateChecklistProgress(): void {
    if (!this.checklist || this.checklist.length === 0) {
      this.checklistProgress = 100;
      return;
    }

    const completed = this.checklist.filter(item => item.isCompleted).length;
    this.checklistProgress = Math.round((completed / this.checklist.length) * 100);
  }

  /**
   * Maliyet özetini hesapla
   */
  calculateCostSummary(): void {
    const laborCost = this.laborRecords?.reduce(
      (sum, record) => sum + (record.totalCost || 0),
      0
    ) || 0;

    const materialCost = this.usedMaterials?.reduce(
      (sum, material) => sum + (material.totalCost || 0),
      0
    ) || 0;

    this.costSummary = {
      laborCost,
      materialCost,
      externalServiceCost: 0,
      otherCosts: 0,
      totalCost: laborCost + materialCost,
      currency: this.currency || 'TRY',
    };
  }

  /**
   * Gecikmiş mi?
   */
  isOverdue(): boolean {
    if (!this.dueDate) return false;
    if (this.status === WorkOrderStatus.COMPLETED ||
        this.status === WorkOrderStatus.VERIFIED ||
        this.status === WorkOrderStatus.CANCELLED) {
      return false;
    }
    return new Date() > new Date(this.dueDate);
  }

  /**
   * Onay gerekli mi?
   */
  requiresApproval(): boolean {
    return this.priority === WorkOrderPriority.CRITICAL ||
           this.priority === WorkOrderPriority.HIGH ||
           this.type === WorkOrderType.EMERGENCY;
  }

  /**
   * Acil mi?
   */
  isUrgent(): boolean {
    return this.priority === WorkOrderPriority.CRITICAL ||
           this.type === WorkOrderType.EMERGENCY;
  }

  /**
   * Aktif mi?
   */
  isActive(): boolean {
    return this.status === WorkOrderStatus.IN_PROGRESS ||
           this.status === WorkOrderStatus.SCHEDULED ||
           this.status === WorkOrderStatus.APPROVED;
  }
}
