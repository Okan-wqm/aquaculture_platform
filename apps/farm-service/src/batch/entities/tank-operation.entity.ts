/**
 * TankOperation Entity - Tank Operasyon Kayıtları
 *
 * Tank bazlı tüm operasyonları kaydeder:
 * - Mortality (doğal ölüm)
 * - Cull (ayıklama)
 * - Transfer
 * - Harvest (hasat)
 * - Sampling (örnekleme)
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

// ============================================================================
// ENUMS
// ============================================================================

/**
 * Operasyon tipi
 */
export enum OperationType {
  // Production fish operasyonları
  MORTALITY = 'mortality',           // Doğal ölüm
  CULL = 'cull',                     // Ayıklama (small, deformed, sick)
  TRANSFER_OUT = 'transfer_out',     // Transfer çıkış
  TRANSFER_IN = 'transfer_in',       // Transfer giriş
  HARVEST = 'harvest',               // Hasat
  SAMPLING = 'sampling',             // Örnekleme
  ADJUSTMENT = 'adjustment',         // Manuel düzeltme

  // Cleaner fish operasyonları
  CLEANER_DEPLOYMENT = 'cleaner_deployment',     // Cleaner fish tanka ekleme
  CLEANER_MORTALITY = 'cleaner_mortality',       // Cleaner fish ölümü
  CLEANER_REMOVAL = 'cleaner_removal',           // Cleaner fish çıkarma (cull/disposal)
  CLEANER_TRANSFER_OUT = 'cleaner_transfer_out', // Cleaner fish transfer çıkış
  CLEANER_TRANSFER_IN = 'cleaner_transfer_in',   // Cleaner fish transfer giriş
}

registerEnumType(OperationType, {
  name: 'OperationType',
  description: 'Operasyon tipi',
});

/**
 * Ayıklama nedeni
 */
export enum CullReason {
  SMALL_SIZE = 'small_size',         // Küçük boy
  DEFORMED = 'deformed',             // Deformasyon
  SICK = 'sick',                     // Hasta
  POOR_GROWTH = 'poor_growth',       // Zayıf büyüme
  GRADING = 'grading',               // Grading sonucu
  OTHER = 'other',
}

// CullReason is registered in batch.resolver.ts

/**
 * Ölüm nedeni
 * Note: Use MortalityReason from record-mortality.command.ts for GraphQL operations
 * This local enum is kept for TypeORM column type compatibility
 */
export enum MortalityReason {
  DISEASE = 'disease',
  WATER_QUALITY = 'water_quality',
  STRESS = 'stress',
  HANDLING = 'handling',
  TEMPERATURE = 'temperature',
  OXYGEN = 'oxygen',
  UNKNOWN = 'unknown',
  OTHER = 'other',
}

// MortalityReason is registered in batch.resolver.ts

// ============================================================================
// INTERFACES
// ============================================================================

/**
 * Operasyon sonrası durum
 */
export interface PostOperationState {
  quantity: number;
  biomassKg: number;
  densityKgM3: number;
}

// ============================================================================
// ENTITY
// ============================================================================

@ObjectType()
@Entity('tank_operations')
@Index(['tenantId', 'tankId', 'operationDate'])
@Index(['tenantId', 'batchId', 'operationDate'])
@Index(['tenantId', 'operationType', 'operationDate'])
@Index(['tankId', 'operationType'])
export class TankOperation {
  @Field(() => ID)
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Field()
  @Column('uuid')
  @Index()
  tenantId: string;

  // -------------------------------------------------------------------------
  // TANK İLİŞKİSİ
  // -------------------------------------------------------------------------

  @Field()
  @Column('uuid')
  @Index()
  tankId: string;

  @ManyToOne('Tank', { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'tankId' })
  tank: any;

  // Denormalized tank name for quick access
  @Field({ nullable: true })
  @Column({ length: 255, nullable: true })
  tankName?: string;

  @Field({ nullable: true })
  @Column({ length: 50, nullable: true })
  tankCode?: string;

  // Source tank for transfer operations
  @Field({ nullable: true })
  @Column('uuid', { nullable: true })
  sourceTankId?: string;

  @ManyToOne('Tank', { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'sourceTankId' })
  sourceTank?: any;

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

  // Denormalized batch number for quick access
  @Field({ nullable: true })
  @Column({ length: 50, nullable: true })
  batchNumber?: string;

  // -------------------------------------------------------------------------
  // OPERASYON BİLGİLERİ
  // -------------------------------------------------------------------------

  @Field(() => OperationType)
  @Column({
    type: 'enum',
    enum: OperationType,
  })
  operationType: OperationType;

  @Field()
  @Column({ type: 'date' })
  operationDate: Date;

  @Field(() => Int)
  @Column({ type: 'int' })
  quantity: number;                        // İşlem adedi

  @Field(() => Float, { nullable: true })
  @Column({ type: 'decimal', precision: 10, scale: 2, nullable: true })
  avgWeightG?: number;                     // Ortalama ağırlık (g)

  @Field(() => Float, { nullable: true })
  @Column({ type: 'decimal', precision: 15, scale: 2, nullable: true })
  biomassKg?: number;                      // Toplam biomass (kg)

  // -------------------------------------------------------------------------
  // MORTALITY DETAYLARI
  // -------------------------------------------------------------------------

  @Field(() => MortalityReason, { nullable: true })
  @Column({
    type: 'enum',
    enum: MortalityReason,
    nullable: true,
  })
  mortalityReason?: MortalityReason;

  @Field({ nullable: true })
  @Column({ type: 'text', nullable: true })
  mortalityDetail?: string;

  // -------------------------------------------------------------------------
  // CULL DETAYLARI
  // -------------------------------------------------------------------------

  @Field(() => CullReason, { nullable: true })
  @Column({
    type: 'enum',
    enum: CullReason,
    nullable: true,
  })
  cullReason?: CullReason;

  @Field({ nullable: true })
  @Column({ type: 'text', nullable: true })
  cullDetail?: string;

  // -------------------------------------------------------------------------
  // TRANSFER DETAYLARI
  // -------------------------------------------------------------------------

  @Field({ nullable: true })
  @Column('uuid', { nullable: true })
  destinationTankId?: string;         // Transfer hedefi

  @ManyToOne('Tank', { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'destinationTankId' })
  destinationTank?: any;

  // Denormalized destination tank name
  @Field({ nullable: true })
  @Column({ length: 255, nullable: true })
  destinationTankName?: string;

  @Field({ nullable: true })
  @Column({ type: 'text', nullable: true })
  transferReason?: string;

  // -------------------------------------------------------------------------
  // HARVEST DETAYLARI
  // -------------------------------------------------------------------------

  @Field(() => Float, { nullable: true })
  @Column({ type: 'decimal', precision: 15, scale: 2, nullable: true })
  harvestTotalWeightKg?: number;           // Hasat toplam ağırlık

  @Field(() => Float, { nullable: true })
  @Column({ type: 'decimal', precision: 10, scale: 2, nullable: true })
  harvestPricePerKg?: number;              // kg başına fiyat

  @Field({ nullable: true })
  @Column({ length: 255, nullable: true })
  harvestBuyer?: string;                   // Alıcı

  // -------------------------------------------------------------------------
  // CLEANER FISH DETAYLARI
  // -------------------------------------------------------------------------

  /**
   * Bu operasyon cleaner fish ile mi ilgili?
   */
  @Field({ nullable: true })
  @Column({ type: 'boolean', default: false })
  isCleanerFishOperation: boolean;

  /**
   * Cleaner fish türü (Lumpfish, Ballan Wrasse, vb.)
   */
  @Field({ nullable: true })
  @Column({ type: 'varchar', length: 100, nullable: true })
  cleanerSpeciesName?: string;

  /**
   * Cleaner fish batch ID (cleaner fish operasyonları için)
   */
  @Field({ nullable: true })
  @Column('uuid', { nullable: true })
  cleanerBatchId?: string;

  // -------------------------------------------------------------------------
  // OPERASYON ÖNCESİ/SONRASI DURUM
  // -------------------------------------------------------------------------

  @Field(() => GraphQLJSON, { nullable: true })
  @Column({ type: 'jsonb', nullable: true })
  preOperationState?: PostOperationState;

  @Field(() => GraphQLJSON, { nullable: true })
  @Column({ type: 'jsonb', nullable: true })
  postOperationState?: PostOperationState;

  // -------------------------------------------------------------------------
  // EK BİLGİLER
  // -------------------------------------------------------------------------

  @Field({ nullable: true })
  @Column({ type: 'text', nullable: true })
  notes?: string;

  // -------------------------------------------------------------------------
  // AUDIT FIELDS
  // -------------------------------------------------------------------------

  @Field()
  @Column('uuid')
  performedBy: string;                     // İşlemi yapan kullanıcı

  @Field()
  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @Field()
  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;

  // -------------------------------------------------------------------------
  // SOFT DELETE
  // -------------------------------------------------------------------------

  @Field()
  @Column({ default: false })
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
   * Stok azaltan operasyon mu?
   */
  isStockReducing(): boolean {
    return [
      OperationType.MORTALITY,
      OperationType.CULL,
      OperationType.TRANSFER_OUT,
      OperationType.HARVEST,
    ].includes(this.operationType);
  }

  /**
   * Stok artıran operasyon mu?
   */
  isStockIncreasing(): boolean {
    return this.operationType === OperationType.TRANSFER_IN;
  }

  /**
   * Survival Rate'i etkiler mi? (Sadece mortality)
   */
  affectsSurvivalRate(): boolean {
    return this.operationType === OperationType.MORTALITY;
  }

  /**
   * Retention Rate'i etkiler mi? (mortality + cull)
   */
  affectsRetentionRate(): boolean {
    return [
      OperationType.MORTALITY,
      OperationType.CULL,
    ].includes(this.operationType);
  }

  /**
   * Cleaner fish operasyonu mu?
   */
  isCleanerFishOp(): boolean {
    return [
      OperationType.CLEANER_DEPLOYMENT,
      OperationType.CLEANER_MORTALITY,
      OperationType.CLEANER_REMOVAL,
      OperationType.CLEANER_TRANSFER_OUT,
      OperationType.CLEANER_TRANSFER_IN,
    ].includes(this.operationType);
  }

  /**
   * Cleaner fish stok azaltan operasyon mu?
   */
  isCleanerFishStockReducing(): boolean {
    return [
      OperationType.CLEANER_MORTALITY,
      OperationType.CLEANER_REMOVAL,
      OperationType.CLEANER_TRANSFER_OUT,
    ].includes(this.operationType);
  }

  /**
   * Cleaner fish stok artıran operasyon mu?
   */
  isCleanerFishStockIncreasing(): boolean {
    return [
      OperationType.CLEANER_DEPLOYMENT,
      OperationType.CLEANER_TRANSFER_IN,
    ].includes(this.operationType);
  }
}
