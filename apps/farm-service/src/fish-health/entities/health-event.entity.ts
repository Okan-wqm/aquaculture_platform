/**
 * HealthEvent Entity - Sağlık Olayları
 *
 * Balık sağlığı ile ilgili tüm olayların kaydı.
 * Hastalık, tedavi, muayene ve gözlemler.
 *
 * Özellikler:
 * - Hastalık/belirti kayıtları
 * - Tedavi protokolleri
 * - İlaç uygulamaları
 * - Karantina takibi
 * - Veteriner konsültasyonları
 *
 * @module FishHealth
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

// ============================================================================
// ENUMS
// ============================================================================

/**
 * Sağlık olayı tipi
 */
export enum HealthEventType {
  DISEASE_OUTBREAK = 'disease_outbreak',     // Hastalık patlaması
  SYMPTOM_OBSERVED = 'symptom_observed',     // Belirti gözlemi
  ROUTINE_INSPECTION = 'routine_inspection', // Rutin muayene
  TREATMENT_START = 'treatment_start',       // Tedavi başlangıcı
  TREATMENT_END = 'treatment_end',           // Tedavi bitişi
  VACCINATION = 'vaccination',               // Aşılama
  QUARANTINE_START = 'quarantine_start',     // Karantina başlangıcı
  QUARANTINE_END = 'quarantine_end',         // Karantina bitişi
  MORTALITY_EVENT = 'mortality_event',       // Ölüm olayı
  RECOVERY = 'recovery',                     // İyileşme
  LAB_RESULT = 'lab_result',                 // Laboratuvar sonucu
  VET_CONSULTATION = 'vet_consultation',     // Veteriner konsültasyonu
}

registerEnumType(HealthEventType, {
  name: 'HealthEventType',
  description: 'Sağlık olayı tipi',
});

/**
 * Hastalık kategorisi
 */
export enum DiseaseCategory {
  BACTERIAL = 'bacterial',           // Bakteriyel
  VIRAL = 'viral',                   // Viral
  PARASITIC = 'parasitic',           // Parazitik
  FUNGAL = 'fungal',                 // Fungal
  NUTRITIONAL = 'nutritional',       // Beslenme kaynaklı
  ENVIRONMENTAL = 'environmental',   // Çevresel
  GENETIC = 'genetic',               // Genetik
  UNKNOWN = 'unknown',               // Bilinmiyor
}

registerEnumType(DiseaseCategory, {
  name: 'DiseaseCategory',
  description: 'Hastalık kategorisi',
});

/**
 * Şiddet seviyesi
 */
export enum HealthSeverity {
  MINOR = 'minor',                   // Hafif
  MODERATE = 'moderate',             // Orta
  SEVERE = 'severe',                 // Şiddetli
  CRITICAL = 'critical',             // Kritik
}

registerEnumType(HealthSeverity, {
  name: 'HealthSeverity',
  description: 'Şiddet seviyesi',
});

/**
 * Olay durumu
 */
export enum HealthEventStatus {
  ACTIVE = 'active',                 // Devam ediyor
  MONITORING = 'monitoring',         // İzleme altında
  RESOLVED = 'resolved',             // Çözüldü
  CHRONIC = 'chronic',               // Kronik
  CANCELLED = 'cancelled',           // İptal edildi
}

registerEnumType(HealthEventStatus, {
  name: 'HealthEventStatus',
  description: 'Olay durumu',
});

/**
 * Tedavi yöntemi
 */
export enum TreatmentMethod {
  BATH = 'bath',                     // Banyo tedavisi
  IN_FEED = 'in_feed',               // Yemle verilen
  INJECTION = 'injection',           // Enjeksiyon
  IMMERSION = 'immersion',           // Daldırma
  TOPICAL = 'topical',               // Topikal (yüzeysel)
  ENVIRONMENTAL = 'environmental',   // Çevresel düzenleme
  VACCINATION = 'vaccination',       // Aşı
}

registerEnumType(TreatmentMethod, {
  name: 'TreatmentMethod',
  description: 'Tedavi yöntemi',
});

// ============================================================================
// INTERFACES
// ============================================================================

/**
 * Gözlemlenen belirtiler
 */
export interface ObservedSymptoms {
  behavioral: string[];              // Davranışsal (yüzme bozukluğu, iştahsızlık)
  physical: string[];                // Fiziksel (lezyon, renk değişimi)
  respiratory: string[];             // Solunum (hızlı solungaç hareketi)
  other: string[];
}

/**
 * Tedavi detayları
 */
export interface TreatmentDetails {
  method: TreatmentMethod;
  medication?: {
    name: string;
    activeIngredient: string;
    dosage: number;                  // mg/kg veya mg/L
    dosageUnit: string;
    concentration?: number;
    manufacturer?: string;
    batchNumber?: string;
    expiryDate?: Date;
  };
  duration: {
    startDate: Date;
    endDate?: Date;
    frequency: string;               // "1x daily", "every 12h"
    totalDays?: number;
  };
  withdrawalPeriod?: number;         // Gün (hasat öncesi bekleme)
  instructions?: string;
  cost?: number;
  currency?: string;
}

/**
 * Laboratuvar sonuçları
 */
export interface LabResults {
  sampleType: 'tissue' | 'water' | 'mucus' | 'blood' | 'other';
  sampleDate: Date;
  labName?: string;
  testType: string;
  results: {
    parameter: string;
    value: string;
    unit?: string;
    reference?: string;
    interpretation: 'normal' | 'abnormal' | 'positive' | 'negative';
  }[];
  conclusion?: string;
  recommendations?: string;
}

/**
 * Etkilenen popülasyon
 */
export interface AffectedPopulation {
  estimatedAffected: number;         // Tahmini etkilenen adet
  affectedPercent: number;           // %
  mortalityCount?: number;           // Bu olayla ilişkili ölüm
  mortalityPercent?: number;
  spreadRate?: 'slow' | 'moderate' | 'fast' | 'contained';
}

/**
 * Veteriner notları
 */
export interface VetConsultation {
  vetName: string;
  vetLicense?: string;
  consultationDate: Date;
  diagnosis?: string;
  differentialDiagnosis?: string[];
  recommendedTreatment?: string;
  followUpRequired: boolean;
  followUpDate?: Date;
  notes?: string;
}

/**
 * Su kalitesi anlık görüntüsü
 */
export interface WaterQualitySnapshot {
  temperature?: number;
  dissolvedOxygen?: number;
  pH?: number;
  ammonia?: number;
  nitrite?: number;
}

// ============================================================================
// ENTITY
// ============================================================================

@ObjectType()
@Entity('health_events')
@Index(['tenantId', 'batchId', 'eventDate'])
@Index(['tenantId', 'eventType', 'status'])
@Index(['tenantId', 'eventDate'])
@Index(['batchId', 'status'])
@Index(['diseaseCategory', 'tenantId'])
export class HealthEvent {
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
  batch: any;

  // -------------------------------------------------------------------------
  // LOKASYON
  // -------------------------------------------------------------------------

  @Field({ nullable: true })
  @Column('uuid', { nullable: true })
  @Index()
  tankId?: string;

  @ManyToOne('Tank', { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'tankId' })
  tank?: any;

  @Field({ nullable: true })
  @Column('uuid', { nullable: true })
  pondId?: string;

  // -------------------------------------------------------------------------
  // OLAY BİLGİLERİ
  // -------------------------------------------------------------------------

  @Field()
  @Column({ length: 200 })
  title: string;                     // Kısa başlık

  @Field({ nullable: true })
  @Column({ type: 'text', nullable: true })
  description?: string;

  @Field(() => HealthEventType)
  @Column({
    type: 'enum',
    enum: HealthEventType,
  })
  @Index()
  eventType: HealthEventType;

  @Field()
  @Column({ type: 'date' })
  @Index()
  eventDate: Date;

  @Field({ nullable: true })
  @Column({ length: 10, nullable: true })
  eventTime?: string;                // "08:30"

  // -------------------------------------------------------------------------
  // HASTALIK BİLGİLERİ
  // -------------------------------------------------------------------------

  @Field(() => DiseaseCategory, { nullable: true })
  @Column({
    type: 'enum',
    enum: DiseaseCategory,
    nullable: true,
  })
  diseaseCategory?: DiseaseCategory;

  @Field({ nullable: true })
  @Column({ length: 200, nullable: true })
  diseaseName?: string;              // Örn: "Columnaris", "IHN", "Saprolegnia"

  @Field(() => HealthSeverity)
  @Column({
    type: 'enum',
    enum: HealthSeverity,
    default: HealthSeverity.MODERATE,
  })
  severity: HealthSeverity;

  // -------------------------------------------------------------------------
  // BELİRTİLER
  // -------------------------------------------------------------------------

  @Field(() => GraphQLJSON, { nullable: true })
  @Column({ type: 'jsonb', nullable: true })
  symptoms?: ObservedSymptoms;

  // -------------------------------------------------------------------------
  // ETKİLENEN POPÜLASYON
  // -------------------------------------------------------------------------

  @Field(() => GraphQLJSON, { nullable: true })
  @Column({ type: 'jsonb', nullable: true })
  affectedPopulation?: AffectedPopulation;

  // -------------------------------------------------------------------------
  // TEDAVİ
  // -------------------------------------------------------------------------

  @Field(() => GraphQLJSON, { nullable: true })
  @Column({ type: 'jsonb', nullable: true })
  treatment?: TreatmentDetails;

  @Field()
  @Column({ default: false })
  isUnderTreatment: boolean;

  @Field({ nullable: true })
  @Column({ type: 'date', nullable: true })
  treatmentEndDate?: Date;

  @Field(() => Int, { nullable: true })
  @Column({ type: 'int', nullable: true })
  withdrawalPeriodDays?: number;     // Hasat öncesi bekleme

  @Field({ nullable: true })
  @Column({ type: 'date', nullable: true })
  earliestHarvestDate?: Date;        // En erken hasat tarihi

  // -------------------------------------------------------------------------
  // KARANTİNA
  // -------------------------------------------------------------------------

  @Field()
  @Column({ default: false })
  isQuarantined: boolean;

  @Field({ nullable: true })
  @Column({ type: 'date', nullable: true })
  quarantineStartDate?: Date;

  @Field({ nullable: true })
  @Column({ type: 'date', nullable: true })
  quarantineEndDate?: Date;

  @Field({ nullable: true })
  @Column('uuid', { nullable: true })
  quarantineTankId?: string;         // Karantina tankı

  // -------------------------------------------------------------------------
  // LABORATUVAR
  // -------------------------------------------------------------------------

  @Field(() => GraphQLJSON, { nullable: true })
  @Column({ type: 'jsonb', nullable: true })
  labResults?: LabResults;

  @Field()
  @Column({ default: false })
  labConfirmed: boolean;             // Lab ile doğrulandı mı

  // -------------------------------------------------------------------------
  // VETERİNER
  // -------------------------------------------------------------------------

  @Field(() => GraphQLJSON, { nullable: true })
  @Column({ type: 'jsonb', nullable: true })
  vetConsultation?: VetConsultation;

  @Field()
  @Column({ default: false })
  vetNotified: boolean;

  // -------------------------------------------------------------------------
  // SU KALİTESİ
  // -------------------------------------------------------------------------

  @Field(() => GraphQLJSON, { nullable: true })
  @Column({ type: 'jsonb', nullable: true })
  waterQualitySnapshot?: WaterQualitySnapshot;

  @Field({ nullable: true })
  @Column('uuid', { nullable: true })
  relatedWaterQualityMeasurementId?: string;

  // -------------------------------------------------------------------------
  // DURUM
  // -------------------------------------------------------------------------

  @Field(() => HealthEventStatus)
  @Column({
    type: 'enum',
    enum: HealthEventStatus,
    default: HealthEventStatus.ACTIVE,
  })
  @Index()
  status: HealthEventStatus;

  @Field({ nullable: true })
  @Column({ type: 'date', nullable: true })
  resolvedDate?: Date;

  @Field({ nullable: true })
  @Column({ type: 'text', nullable: true })
  resolutionNotes?: string;

  // -------------------------------------------------------------------------
  // İLİŞKİLİ OLAYLAR
  // -------------------------------------------------------------------------

  @Field({ nullable: true })
  @Column('uuid', { nullable: true })
  parentEventId?: string;            // Bağlı olduğu ana olay

  @Field({ nullable: true })
  @Column('uuid', { nullable: true })
  alertIncidentId?: string;          // İlişkili alarm

  // -------------------------------------------------------------------------
  // MALİYET
  // -------------------------------------------------------------------------

  @Field(() => Float, { nullable: true })
  @Column({ type: 'decimal', precision: 15, scale: 2, nullable: true })
  estimatedCost?: number;

  @Field({ nullable: true })
  @Column({ length: 3, nullable: true })
  currency?: string;

  // -------------------------------------------------------------------------
  // KULLANICI BİLGİLERİ
  // -------------------------------------------------------------------------

  @Field()
  @Column('uuid')
  reportedBy: string;

  @Field({ nullable: true })
  @Column({ type: 'text', nullable: true })
  notes?: string;

  @Field(() => [String], { nullable: true })
  @Column({ type: 'simple-array', nullable: true })
  attachments?: string[];            // Fotoğraf/video URL'leri

  // -------------------------------------------------------------------------
  // TAKİP
  // -------------------------------------------------------------------------

  @Field()
  @Column({ default: false })
  followUpRequired: boolean;

  @Field({ nullable: true })
  @Column({ type: 'date', nullable: true })
  nextFollowUpDate?: Date;

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
   * Tedavi başlat
   */
  startTreatment(treatment: TreatmentDetails): void {
    this.treatment = treatment;
    this.isUnderTreatment = true;
    if (treatment.duration.endDate) {
      this.treatmentEndDate = treatment.duration.endDate;
    }
    if (treatment.withdrawalPeriod) {
      this.withdrawalPeriodDays = treatment.withdrawalPeriod;
      const endDate = this.treatmentEndDate || new Date();
      this.earliestHarvestDate = new Date(
        new Date(endDate).getTime() + treatment.withdrawalPeriod * 24 * 60 * 60 * 1000
      );
    }
    this.status = HealthEventStatus.ACTIVE;
  }

  /**
   * Tedavi bitir
   */
  endTreatment(notes?: string): void {
    this.isUnderTreatment = false;
    this.treatmentEndDate = new Date();
    if (notes) {
      this.resolutionNotes = notes;
    }
    this.status = HealthEventStatus.MONITORING;
  }

  /**
   * Karantinaya al
   */
  startQuarantine(quarantineTankId?: string): void {
    this.isQuarantined = true;
    this.quarantineStartDate = new Date();
    if (quarantineTankId) {
      this.quarantineTankId = quarantineTankId;
    }
  }

  /**
   * Karantinayı bitir
   */
  endQuarantine(): void {
    this.isQuarantined = false;
    this.quarantineEndDate = new Date();
    this.quarantineTankId = undefined;
  }

  /**
   * Olayı çözümle
   */
  resolve(notes?: string): void {
    this.status = HealthEventStatus.RESOLVED;
    this.resolvedDate = new Date();
    this.isUnderTreatment = false;
    this.isQuarantined = false;
    if (notes) {
      this.resolutionNotes = notes;
    }
  }

  /**
   * Kritik mi?
   */
  isCritical(): boolean {
    return this.severity === HealthSeverity.CRITICAL ||
           this.severity === HealthSeverity.SEVERE;
  }

  /**
   * Hasat için uygun mu?
   */
  canHarvest(): boolean {
    if (this.isQuarantined) return false;
    if (this.isUnderTreatment) return false;
    if (this.earliestHarvestDate && new Date() < new Date(this.earliestHarvestDate)) {
      return false;
    }
    return true;
  }

  /**
   * Hasat için beklenecek gün sayısı
   */
  getDaysUntilHarvestAllowed(): number {
    if (!this.earliestHarvestDate) return 0;
    const diff = new Date(this.earliestHarvestDate).getTime() - new Date().getTime();
    return Math.max(0, Math.ceil(diff / (24 * 60 * 60 * 1000)));
  }

  /**
   * Aktif olay mı?
   */
  isActive(): boolean {
    return this.status === HealthEventStatus.ACTIVE ||
           this.status === HealthEventStatus.MONITORING;
  }

  /**
   * Takip gerekiyor mu ve tarihi geçmiş mi?
   */
  isFollowUpOverdue(): boolean {
    if (!this.followUpRequired || !this.nextFollowUpDate) return false;
    return new Date() > new Date(this.nextFollowUpDate);
  }
}
