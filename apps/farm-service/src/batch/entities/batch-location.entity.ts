/**
 * BatchLocation Entity - Batch-Tank/Pond M2M İlişkisi
 *
 * Bir batch birden fazla tank veya pond'da bulunabilir.
 * Bu entity batch'in hangi konteyner'da ne kadar olduğunu takip eder.
 *
 * Özellikler:
 * - Multi-location batch tracking
 * - Location history (taşıma geçmişi)
 * - Quantity ve biomass per location
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
import { Batch } from './batch.entity';
// Note: Tank is referenced via string to avoid circular dependency

// ============================================================================
// ENUMS
// ============================================================================

/**
 * Lokasyon tipi
 */
export enum LocationType {
  TANK = 'tank',
  POND = 'pond',
}

registerEnumType(LocationType, {
  name: 'LocationType',
  description: 'Konteyner tipi',
});

/**
 * Transfer nedeni
 */
export enum TransferReason {
  INITIAL_STOCKING = 'initial_stocking',   // İlk stoklama
  SPLIT = 'split',                         // Bölme (aşırı yoğunluk)
  MERGE = 'merge',                         // Birleştirme
  GRADING = 'grading',                     // Grading sonrası
  GROWTH_STAGE = 'growth_stage',           // Büyüme aşaması değişimi
  WATER_QUALITY = 'water_quality',         // Su kalitesi sorunu
  HEALTH_ISSUE = 'health_issue',           // Sağlık sorunu
  MAINTENANCE = 'maintenance',             // Tank bakımı
  HARVEST_PREP = 'harvest_prep',           // Hasat hazırlığı
  OTHER = 'other',
}

registerEnumType(TransferReason, {
  name: 'TransferReason',
  description: 'Transfer nedeni',
});

// ============================================================================
// ENTITY
// ============================================================================

@ObjectType()
@Entity('batch_locations')
@Index(['tenantId', 'batchId', 'isCurrentLocation'])
@Index(['tenantId', 'tankId', 'isCurrentLocation'])
@Index(['tenantId', 'pondId', 'isCurrentLocation'])
@Index(['batchId', 'movedAt'])
export class BatchLocation {
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
  // LOKASYON BİLGİLERİ
  // -------------------------------------------------------------------------

  @Field(() => LocationType)
  @Column({
    type: 'enum',
    enum: LocationType,
  })
  locationType: LocationType;

  @Field({ nullable: true })
  @Column('uuid', { nullable: true })
  tankId?: string;

  @ManyToOne('Tank', { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'tankId' })
  tank?: any;

  @Field({ nullable: true })
  @Column('uuid', { nullable: true })
  pondId?: string;

  // Pond entity ile ilişki (mevcut pond entity varsa)
  // @ManyToOne(() => Pond, { nullable: true, onDelete: 'SET NULL' })
  // @JoinColumn({ name: 'pondId' })
  // pond?: Pond;

  // -------------------------------------------------------------------------
  // MİKTAR VE BIOMASS
  // -------------------------------------------------------------------------

  @Field(() => Int)
  @Column({ type: 'int' })
  quantity: number;                // Bu lokasyondaki adet

  @Field(() => Float)
  @Column({ type: 'decimal', precision: 15, scale: 2 })
  biomass: number;                 // Bu lokasyondaki biomass (kg)

  @Field(() => Float, { nullable: true })
  @Column({ type: 'decimal', precision: 10, scale: 2, nullable: true })
  avgWeight?: number;              // Bu lokasyondaki ortalama ağırlık (g)

  // -------------------------------------------------------------------------
  // TRANSFER BİLGİLERİ
  // -------------------------------------------------------------------------

  @Field()
  @Column({ type: 'timestamptz' })
  movedAt: Date;                   // Bu lokasyona taşınma tarihi

  @Field({ nullable: true })
  @Column('uuid', { nullable: true })
  movedBy?: string;                // Taşıyan kullanıcı

  @Field(() => TransferReason, { nullable: true })
  @Column({
    type: 'enum',
    enum: TransferReason,
    nullable: true,
  })
  transferReason?: TransferReason;

  @Field({ nullable: true })
  @Column('uuid', { nullable: true })
  previousLocationId?: string;     // Önceki lokasyon ID'si (history için)

  // -------------------------------------------------------------------------
  // DURUM
  // -------------------------------------------------------------------------

  @Field()
  @Column({ default: true })
  @Index()
  isCurrentLocation: boolean;      // Mevcut aktif lokasyon mu?

  @Field({ nullable: true })
  @Column({ type: 'timestamptz', nullable: true })
  exitedAt?: Date;                 // Bu lokasyondan çıkış tarihi

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
   * Yoğunluğu hesaplar (volume bilgisi varsa)
   */
  getDensity(containerVolume: number): number {
    if (!containerVolume || containerVolume <= 0) return 0;
    return this.biomass / containerVolume;
  }

  /**
   * Lokasyonu kapat (başka lokasyona transfer edildiğinde)
   */
  close(): void {
    this.isCurrentLocation = false;
    this.exitedAt = new Date();
  }

  /**
   * Lokasyon display adı
   */
  getLocationDisplayName(): string {
    if (this.locationType === LocationType.TANK) {
      return `Tank ${this.tankId?.substring(0, 8)}...`;
    }
    return `Pond ${this.pondId?.substring(0, 8)}...`;
  }
}
