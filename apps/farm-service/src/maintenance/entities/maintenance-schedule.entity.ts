/**
 * MaintenanceSchedule Entity - Bakım Planı
 *
 * Önleyici bakım planlaması ve tekrarlayan iş emirleri.
 * Ekipman/tank bazında bakım takvimi.
 *
 * Özellikler:
 * - Tekrarlayan bakım planları
 * - Esnek zamanlama (günlük, haftalık, aylık, vb.)
 * - Otomatik iş emri oluşturma
 * - Bakım geçmişi takibi
 * - Uyarı ve hatırlatmalar
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
import { AssetType } from './work-order.entity';

// ============================================================================
// ENUMS
// ============================================================================

/**
 * Bakım plan durumu
 */
export enum MaintenanceScheduleStatus {
  ACTIVE = 'active',
  PAUSED = 'paused',
  COMPLETED = 'completed',
  EXPIRED = 'expired',
}

registerEnumType(MaintenanceScheduleStatus, {
  name: 'MaintenanceScheduleStatus',
  description: 'Bakım plan durumu',
});

/**
 * Tekrar sıklığı tipi
 */
export enum RecurrenceType {
  DAILY = 'daily',
  WEEKLY = 'weekly',
  BIWEEKLY = 'biweekly',
  MONTHLY = 'monthly',
  QUARTERLY = 'quarterly',
  SEMIANNUALLY = 'semiannually',
  ANNUALLY = 'annually',
  CUSTOM = 'custom',
  METER_BASED = 'meter_based',       // Sayaç bazlı (çalışma saati)
}

registerEnumType(RecurrenceType, {
  name: 'RecurrenceType',
  description: 'Tekrar sıklığı tipi',
});

/**
 * Bakım kategorisi
 */
export enum MaintenanceCategory {
  MECHANICAL = 'mechanical',         // Mekanik
  ELECTRICAL = 'electrical',         // Elektrik
  PLUMBING = 'plumbing',             // Tesisat
  CLEANING = 'cleaning',             // Temizlik
  LUBRICATION = 'lubrication',       // Yağlama
  INSPECTION = 'inspection',         // Denetim
  CALIBRATION = 'calibration',       // Kalibrasyon
  FILTER_CHANGE = 'filter_change',   // Filtre değişimi
  SAFETY = 'safety',                 // Güvenlik
  GENERAL = 'general',               // Genel
}

registerEnumType(MaintenanceCategory, {
  name: 'MaintenanceCategory',
  description: 'Bakım kategorisi',
});

// ============================================================================
// INTERFACES
// ============================================================================

/**
 * Tekrar kuralı
 */
export interface RecurrenceRule {
  type: RecurrenceType;
  interval?: number;                 // Her X günde/haftada/ayda (custom için)
  daysOfWeek?: number[];             // 0-6 (Pazar-Cumartesi)
  dayOfMonth?: number;               // 1-31
  monthsOfYear?: number[];           // 1-12
  endDate?: Date;                    // Bitiş tarihi (varsa)
  maxOccurrences?: number;           // Maksimum tekrar sayısı

  // Meter bazlı için
  meterType?: 'hours' | 'cycles' | 'km';
  meterInterval?: number;            // Her X saatte/döngüde
}

/**
 * Standart checklist şablonu
 */
export interface ChecklistTemplate {
  items: {
    id: string;
    description: string;
    isRequired: boolean;
    category?: string;
    estimatedMinutes?: number;
  }[];
}

/**
 * Gerekli malzemeler
 */
export interface RequiredMaterial {
  materialId?: string;
  name: string;
  quantity: number;
  unit: string;
  estimatedCost?: number;
}

/**
 * Uyarı ayarları
 */
export interface AlertSettings {
  daysBeforeDue: number;             // Kaç gün önce uyar
  notifyAssignee: boolean;
  notifyManager: boolean;
  emailNotification: boolean;
  smsNotification: boolean;
}

/**
 * Performans metrikleri
 */
export interface ScheduleMetrics {
  totalExecutions: number;
  completedOnTime: number;
  completedLate: number;
  missed: number;
  avgCompletionTime?: number;        // dakika
  avgCost?: number;
  complianceRate: number;            // %
  lastExecutionDate?: Date;
  nextDueDate?: Date;
}

// ============================================================================
// ENTITY
// ============================================================================

@ObjectType()
@Entity('maintenance_schedules')
@Index(['tenantId', 'status'])
@Index(['tenantId', 'scheduleCode'], { unique: true })
@Index(['tenantId', 'assetType', 'assetId'])
@Index(['tenantId', 'nextDueDate'])
@Index(['tenantId', 'category'])
export class MaintenanceSchedule {
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
  scheduleCode: string;              // MS-2024-00001

  @Field()
  @Column({ length: 200 })
  name: string;

  @Field({ nullable: true })
  @Column({ type: 'text', nullable: true })
  description?: string;

  @Field(() => MaintenanceCategory)
  @Column({
    type: 'enum',
    enum: MaintenanceCategory,
    default: MaintenanceCategory.GENERAL,
  })
  @Index()
  category: MaintenanceCategory;

  @Field(() => MaintenanceScheduleStatus)
  @Column({
    type: 'enum',
    enum: MaintenanceScheduleStatus,
    default: MaintenanceScheduleStatus.ACTIVE,
  })
  @Index()
  status: MaintenanceScheduleStatus;

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

  @Field({ nullable: true })
  @Column({ length: 100, nullable: true })
  assetName?: string;

  // -------------------------------------------------------------------------
  // ZAMANLAMA
  // -------------------------------------------------------------------------

  @Field(() => GraphQLJSON)
  @Column({ type: 'jsonb' })
  recurrenceRule: RecurrenceRule;

  @Field()
  @Column({ type: 'date' })
  startDate: Date;

  @Field({ nullable: true })
  @Column({ type: 'date', nullable: true })
  endDate?: Date;

  @Field({ nullable: true })
  @Column({ type: 'date', nullable: true })
  @Index()
  nextDueDate?: Date;

  @Field({ nullable: true })
  @Column({ type: 'date', nullable: true })
  lastExecutedDate?: Date;

  // -------------------------------------------------------------------------
  // METER BAZLI (opsiyonel)
  // -------------------------------------------------------------------------

  @Field(() => Float, { nullable: true })
  @Column({ type: 'decimal', precision: 15, scale: 2, nullable: true })
  currentMeterReading?: number;

  @Field(() => Float, { nullable: true })
  @Column({ type: 'decimal', precision: 15, scale: 2, nullable: true })
  lastMaintenanceMeterReading?: number;

  @Field(() => Float, { nullable: true })
  @Column({ type: 'decimal', precision: 15, scale: 2, nullable: true })
  nextMaintenanceMeterReading?: number;

  // -------------------------------------------------------------------------
  // İŞ EMRİ ŞABLONU
  // -------------------------------------------------------------------------

  @Field(() => Int, { nullable: true })
  @Column({ type: 'int', nullable: true })
  estimatedDurationMinutes?: number;

  @Field(() => Float, { nullable: true })
  @Column({ type: 'decimal', precision: 15, scale: 2, nullable: true })
  estimatedCost?: number;

  @Field({ nullable: true })
  @Column({ length: 3, nullable: true })
  currency?: string;

  @Field(() => GraphQLJSON, { nullable: true })
  @Column({ type: 'jsonb', nullable: true })
  checklistTemplate?: ChecklistTemplate;

  @Field(() => GraphQLJSON, { nullable: true })
  @Column({ type: 'jsonb', nullable: true })
  requiredMaterials?: RequiredMaterial[];

  @Field({ nullable: true })
  @Column({ type: 'text', nullable: true })
  instructions?: string;

  // -------------------------------------------------------------------------
  // ATAMA
  // -------------------------------------------------------------------------

  @Field({ nullable: true })
  @Column('uuid', { nullable: true })
  defaultAssigneeId?: string;        // Varsayılan sorumlu

  @Field({ nullable: true })
  @Column('uuid', { nullable: true })
  defaultTeamId?: string;            // Varsayılan ekip

  // -------------------------------------------------------------------------
  // UYARI AYARLARI
  // -------------------------------------------------------------------------

  @Field(() => GraphQLJSON, { nullable: true })
  @Column({ type: 'jsonb', nullable: true })
  alertSettings?: AlertSettings;

  // -------------------------------------------------------------------------
  // METRİKLER
  // -------------------------------------------------------------------------

  @Field(() => GraphQLJSON, { nullable: true })
  @Column({ type: 'jsonb', nullable: true })
  metrics?: ScheduleMetrics;

  @Field(() => Int)
  @Column({ type: 'int', default: 0 })
  executionCount: number;

  // -------------------------------------------------------------------------
  // OTOMATİK İŞ EMRİ
  // -------------------------------------------------------------------------

  @Field()
  @Column({ default: true })
  autoGenerateWorkOrder: boolean;

  @Field(() => Int)
  @Column({ type: 'int', default: 7 })
  generateDaysBefore: number;        // Due date'den kaç gün önce oluştur

  // -------------------------------------------------------------------------
  // NOTLAR
  // -------------------------------------------------------------------------

  @Field({ nullable: true })
  @Column({ type: 'text', nullable: true })
  notes?: string;

  // -------------------------------------------------------------------------
  // AUDIT FIELDS
  // -------------------------------------------------------------------------

  @Field()
  @Column('uuid')
  createdBy: string;

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
   * Sonraki due date'i hesaplar
   */
  calculateNextDueDate(fromDate?: Date): Date {
    const baseDate = fromDate || this.lastExecutedDate || this.startDate;
    const base = new Date(baseDate);
    const rule = this.recurrenceRule;

    switch (rule.type) {
      case RecurrenceType.DAILY:
        base.setDate(base.getDate() + (rule.interval || 1));
        break;

      case RecurrenceType.WEEKLY:
        base.setDate(base.getDate() + (rule.interval || 1) * 7);
        break;

      case RecurrenceType.BIWEEKLY:
        base.setDate(base.getDate() + 14);
        break;

      case RecurrenceType.MONTHLY:
        base.setMonth(base.getMonth() + (rule.interval || 1));
        break;

      case RecurrenceType.QUARTERLY:
        base.setMonth(base.getMonth() + 3);
        break;

      case RecurrenceType.SEMIANNUALLY:
        base.setMonth(base.getMonth() + 6);
        break;

      case RecurrenceType.ANNUALLY:
        base.setFullYear(base.getFullYear() + 1);
        break;

      case RecurrenceType.CUSTOM:
        if (rule.interval) {
          base.setDate(base.getDate() + rule.interval);
        }
        break;

      case RecurrenceType.METER_BASED:
        // Meter bazlı için sayaç değerine göre hesaplanır
        // nextDueDate burada hesaplanmaz
        return base;
    }

    // End date kontrolü
    if (this.endDate && base > new Date(this.endDate)) {
      this.status = MaintenanceScheduleStatus.EXPIRED;
    }

    return base;
  }

  /**
   * Bakım tamamlandı olarak işaretle
   */
  markCompleted(meterReading?: number): void {
    this.lastExecutedDate = new Date();
    this.executionCount++;

    if (meterReading !== undefined) {
      this.lastMaintenanceMeterReading = meterReading;
      this.currentMeterReading = meterReading;

      if (this.recurrenceRule.type === RecurrenceType.METER_BASED &&
          this.recurrenceRule.meterInterval) {
        this.nextMaintenanceMeterReading = meterReading + this.recurrenceRule.meterInterval;
      }
    }

    // Sonraki due date'i hesapla
    this.nextDueDate = this.calculateNextDueDate();

    // Metrikleri güncelle
    this.updateMetrics(true);
  }

  /**
   * Metrikleri güncelle
   */
  updateMetrics(wasOnTime: boolean): void {
    if (!this.metrics) {
      this.metrics = {
        totalExecutions: 0,
        completedOnTime: 0,
        completedLate: 0,
        missed: 0,
        complianceRate: 100,
        lastExecutionDate: undefined,
        nextDueDate: undefined,
      };
    }

    this.metrics.totalExecutions++;
    if (wasOnTime) {
      this.metrics.completedOnTime++;
    } else {
      this.metrics.completedLate++;
    }

    this.metrics.complianceRate = Math.round(
      (this.metrics.completedOnTime / this.metrics.totalExecutions) * 100
    );
    this.metrics.lastExecutionDate = this.lastExecutedDate;
    this.metrics.nextDueDate = this.nextDueDate;
  }

  /**
   * Gecikmiş mi?
   */
  isOverdue(): boolean {
    if (this.status !== MaintenanceScheduleStatus.ACTIVE) return false;
    if (!this.nextDueDate) return false;
    return new Date() > new Date(this.nextDueDate);
  }

  /**
   * Meter bazlı bakım gerekli mi?
   */
  isMeterBasedMaintenanceDue(): boolean {
    if (this.recurrenceRule.type !== RecurrenceType.METER_BASED) return false;
    if (!this.currentMeterReading || !this.nextMaintenanceMeterReading) return false;
    return this.currentMeterReading >= this.nextMaintenanceMeterReading;
  }

  /**
   * Planı duraklat
   */
  pause(): void {
    this.status = MaintenanceScheduleStatus.PAUSED;
  }

  /**
   * Planı devam ettir
   */
  resume(): void {
    this.status = MaintenanceScheduleStatus.ACTIVE;
    // Gerekirse nextDueDate'i yeniden hesapla
    if (!this.nextDueDate || new Date(this.nextDueDate) < new Date()) {
      this.nextDueDate = this.calculateNextDueDate(new Date());
    }
  }

  /**
   * Uyarı zamanı geldi mi?
   */
  shouldAlert(): boolean {
    if (!this.alertSettings || !this.nextDueDate) return false;

    const now = new Date();
    const dueDate = new Date(this.nextDueDate);
    const alertDate = new Date(dueDate);
    alertDate.setDate(alertDate.getDate() - this.alertSettings.daysBeforeDue);

    return now >= alertDate && now < dueDate;
  }

  /**
   * Kalan gün sayısı
   */
  getDaysUntilDue(): number {
    if (!this.nextDueDate) return -1;
    const diff = new Date(this.nextDueDate).getTime() - new Date().getTime();
    return Math.ceil(diff / (24 * 60 * 60 * 1000));
  }
}
