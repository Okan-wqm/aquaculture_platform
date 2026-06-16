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
  Check,
  ManyToOne,
  JoinColumn,
} from 'typeorm';
import { DecimalTransformer } from '@aquaculture/backend-common/database';
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
/**
 * Composite index for batch history ORDER BY createdAt DESC queries.
 * Without this, the query planner falls back to a sequential scan
 * when sorting mortality records by creation time within a batch.
 * @see DATA-MEDIUM-023
 */
@Index('IDX_mortality_batch_created_desc', ['batchId', 'createdAt'])
// WHY CHECK: a mortality event records at least one dead fish (DTO is @Min(1)).
// DB-level make-impossible mirrors migration 1801500000000; the named
// constraint matches the migration so entity↔DB parity holds.
@Check('CHK_mortality_records_count_positive', '"count" > 0')
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

  // WHY: mortality_records is regulatory mortality data (Mattilsynet reporting)
  // and MUST be retained — never cascade-wiped when a batch goes away. Batches
  // are never hard-deleted (DeleteBatchHandler / BatchService.deleteBatch perform
  // a soft lifecycle close: isActive=false, status=CLOSED), so cascade was never
  // load-bearing.
  // WHAT: onDelete RESTRICT aligns the entity with the DB FK
  // (FK_d916fa21d316a9cf6587c252be6, already ON DELETE RESTRICT in the baseline)
  // — closing the entity↔DB drift with no migration, and RESTRICT is the regen
  // default so a future baseline regen reproduces it unchanged.
  @ManyToOne(() => Batch, { onDelete: 'RESTRICT' })
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
  @Column({ type: 'decimal', precision: 10, scale: 2, nullable: true, transformer: new DecimalTransformer() })
  estimatedBiomassLoss?: number;         // Tahmini biomass kaybı (kg)

  @Field(() => Float, { nullable: true })
  @Column({ type: 'decimal', precision: 5, scale: 2, nullable: true, transformer: new DecimalTransformer() })
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
