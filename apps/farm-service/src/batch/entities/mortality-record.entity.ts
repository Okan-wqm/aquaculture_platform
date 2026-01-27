/**
 * MortalityRecord Entity - Ölüm Kayıtları
 *
 * Batch'lerdeki ölüm olaylarını detaylı takip eder.
 * Her ölüm kaydı:
 * - Tarih, miktar, neden
 * - Lokasyon bilgisi
 * - İsteğe bağlı fotoğraf/belge
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
import { Batch } from './batch.entity';
// Note: Tank is referenced via string to avoid circular dependency
// Type-only import for TypeScript type checking
import type { Equipment } from '../../equipment/entities/equipment.entity';

// ============================================================================
// ENUMS
// ============================================================================

/**
 * Ölüm nedeni kategorileri
 */
export enum MortalityCause {
  DISEASE = 'disease',                   // Hastalık
  WATER_QUALITY = 'water_quality',       // Su kalitesi sorunu
  STRESS = 'stress',                     // Stres
  HANDLING = 'handling',                 // Handling kaynaklı
  PREDATION = 'predation',               // Yırtıcı saldırısı
  CANNIBALISM = 'cannibalism',           // Yamyamlık
  STARVATION = 'starvation',             // Açlık
  TEMPERATURE = 'temperature',           // Sıcaklık şoku
  OXYGEN = 'oxygen',                     // Oksijen yetersizliği
  AMMONIA = 'ammonia',                   // Amonyak zehirlenmesi
  GENETIC = 'genetic',                   // Genetik
  UNKNOWN = 'unknown',                   // Bilinmiyor
  OTHER = 'other',
}

registerEnumType(MortalityCause, {
  name: 'MortalityCause',
  description: 'Ölüm nedeni',
});

/**
 * Ölüm ciddiyet seviyesi
 */
export enum MortalitySeverity {
  NORMAL = 'normal',                     // Normal (< 0.5% / gün)
  ELEVATED = 'elevated',                 // Yüksek (0.5-1% / gün)
  HIGH = 'high',                         // Çok yüksek (1-5% / gün)
  CRITICAL = 'critical',                 // Kritik (> 5% / gün)
  MASS = 'mass',                         // Toplu ölüm (> 10% / gün)
}

registerEnumType(MortalitySeverity, {
  name: 'MortalitySeverity',
  description: 'Ölüm ciddiyet seviyesi',
});

// ============================================================================
// INTERFACES
// ============================================================================

/**
 * Su kalitesi snapshot (ölüm anında)
 */
export interface WaterQualitySnapshot {
  temperature?: number;
  ph?: number;
  dissolvedOxygen?: number;
  ammonia?: number;
  nitrite?: number;
  salinity?: number;
}

/**
 * İlişkili belgeler
 */
export interface MortalityDocument {
  id: string;
  name: string;
  type: 'photo' | 'lab_report' | 'necropsy' | 'other';
  url: string;
  uploadedAt: Date;
  uploadedBy: string;
}

// ============================================================================
// ENTITY
// ============================================================================

@ObjectType()
@Entity('mortality_records')
@Index(['tenantId', 'batchId', 'recordDate'])
@Index(['tenantId', 'cause'])
@Index(['tenantId', 'severity'])
@Index(['batchId', 'recordDate'])
@Index(['tankId', 'recordDate'])
export class MortalityRecord {
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

  @ManyToOne(() => Batch, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'batchId' })
  batch: Batch;

  // -------------------------------------------------------------------------
  // LOKASYON (Opsiyonel - hangi tank/pond'da oldu)
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
  // ÖLÜM DETAYLARI
  // -------------------------------------------------------------------------

  @Field()
  @Column({ type: 'date' })
  recordDate: Date;                      // Ölüm tarihi

  @Field(() => Int)
  @Column({ type: 'int' })
  count: number;                         // Ölüm adedi

  @Field(() => Float, { nullable: true })
  @Column({ type: 'decimal', precision: 10, scale: 2, nullable: true })
  estimatedBiomassLoss?: number;         // Tahmini biomass kaybı (kg)

  @Field(() => Float, { nullable: true })
  @Column({ type: 'decimal', precision: 5, scale: 2, nullable: true })
  dailyMortalityRate?: number;           // Günlük ölüm oranı (%)

  // -------------------------------------------------------------------------
  // NEDEN VE CİDDİYET
  // -------------------------------------------------------------------------

  @Field(() => MortalityCause)
  @Column({
    type: 'enum',
    enum: MortalityCause,
    default: MortalityCause.UNKNOWN,
  })
  cause: MortalityCause;

  @Field({ nullable: true })
  @Column({ length: 255, nullable: true })
  causeDetail?: string;                  // Neden detayı

  @Field(() => MortalitySeverity)
  @Column({
    type: 'enum',
    enum: MortalitySeverity,
    default: MortalitySeverity.NORMAL,
  })
  severity: MortalitySeverity;

  // -------------------------------------------------------------------------
  // SU KALİTESİ SNAPSHOT
  // -------------------------------------------------------------------------

  @Field(() => GraphQLJSON, { nullable: true })
  @Column({ type: 'jsonb', nullable: true })
  waterQualitySnapshot?: WaterQualitySnapshot;

  // -------------------------------------------------------------------------
  // GÖZLEMLER
  // -------------------------------------------------------------------------

  @Field({ nullable: true })
  @Column({ type: 'text', nullable: true })
  symptoms?: string;                     // Gözlemlenen belirtiler

  @Field({ nullable: true })
  @Column({ type: 'text', nullable: true })
  behaviorObservations?: string;         // Davranış gözlemleri

  @Field({ nullable: true })
  @Column({ type: 'text', nullable: true })
  physicalCondition?: string;            // Fiziksel durum

  // -------------------------------------------------------------------------
  // AKSİYONLAR
  // -------------------------------------------------------------------------

  @Field({ nullable: true })
  @Column({ type: 'text', nullable: true })
  actionsTaken?: string;                 // Alınan önlemler

  @Field({ nullable: true })
  @Column({ type: 'text', nullable: true })
  recommendations?: string;              // Öneriler

  @Field({ nullable: true })
  @Column({ type: 'boolean', default: false })
  labSampleTaken?: boolean;              // Lab örneği alındı mı?

  @Field({ nullable: true })
  @Column({ type: 'text', nullable: true })
  labResults?: string;                   // Lab sonuçları

  // -------------------------------------------------------------------------
  // BELGELER
  // -------------------------------------------------------------------------

  @Field(() => GraphQLJSON, { nullable: true })
  @Column({ type: 'jsonb', nullable: true })
  documents?: MortalityDocument[];

  // -------------------------------------------------------------------------
  // KAYIT BİLGİLERİ
  // -------------------------------------------------------------------------

  @Field()
  @Column('uuid')
  recordedBy: string;                    // Kaydeden kullanıcı

  @Field({ nullable: true })
  @Column('uuid', { nullable: true })
  verifiedBy?: string;                   // Doğrulayan (supervisor)

  @Field({ nullable: true })
  @Column({ type: 'timestamptz', nullable: true })
  verifiedAt?: Date;

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

  // -------------------------------------------------------------------------
  // BUSINESS METHODS
  // -------------------------------------------------------------------------

  /**
   * Severity'yi günlük ölüm oranına göre hesaplar
   */
  static calculateSeverity(dailyRate: number): MortalitySeverity {
    if (dailyRate >= 10) return MortalitySeverity.MASS;
    if (dailyRate >= 5) return MortalitySeverity.CRITICAL;
    if (dailyRate >= 1) return MortalitySeverity.HIGH;
    if (dailyRate >= 0.5) return MortalitySeverity.ELEVATED;
    return MortalitySeverity.NORMAL;
  }

  /**
   * Ölüm kaydı kritik mi?
   */
  isCritical(): boolean {
    return [
      MortalitySeverity.CRITICAL,
      MortalitySeverity.MASS,
    ].includes(this.severity);
  }

  /**
   * Hastalık kaynaklı mı?
   */
  isDiseaseRelated(): boolean {
    return this.cause === MortalityCause.DISEASE;
  }

  /**
   * Su kalitesi kaynaklı mı?
   */
  isWaterQualityRelated(): boolean {
    return [
      MortalityCause.WATER_QUALITY,
      MortalityCause.TEMPERATURE,
      MortalityCause.OXYGEN,
      MortalityCause.AMMONIA,
    ].includes(this.cause);
  }
}
