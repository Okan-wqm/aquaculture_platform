/**
 * TankAllocation Entity - Tank Dağıtım Tarihçesi
 *
 * Batch'lerin tanklara dağıtım tarihçesini tutar.
 * Her dağıtım kaydı:
 * - Hangi batch'den ne kadar alındı
 * - Hangi tank'a konuldu
 * - Tarih ve operatör bilgisi
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
// Type-only import for TypeScript type checking
import type { Equipment } from '../../equipment/entities/equipment.entity';

// ============================================================================
// ENUMS
// ============================================================================

/**
 * Dağıtım tipi
 */
export enum AllocationType {
  INITIAL_STOCKING = 'initial_stocking',   // İlk stoklama
  SPLIT = 'split',                         // Bölme (aşırı yoğunluk)
  TRANSFER_IN = 'transfer_in',             // Transfer giriş
  TRANSFER_OUT = 'transfer_out',           // Transfer çıkış
  GRADING = 'grading',                     // Grading sonrası
  HARVEST = 'harvest',                     // Hasat
}

registerEnumType(AllocationType, {
  name: 'AllocationType',
  description: 'Dağıtım tipi',
});

// ============================================================================
// ENTITY
// ============================================================================

@ObjectType()
@Entity('tank_allocations')
@Index(['tenantId', 'batchId', 'allocationDate'])
@Index(['tenantId', 'tankId', 'allocationDate'])
@Index(['batchId', 'tankId'])
export class TankAllocation {
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

  // Denormalized batch number for quick access
  @Field({ nullable: true })
  @Column({ length: 50, nullable: true })
  batchNumber?: string;

  // -------------------------------------------------------------------------
  // TANK İLİŞKİSİ
  // -------------------------------------------------------------------------

  @Field()
  @Column('uuid')
  @Index()
  tankId: string;

  @ManyToOne('Tank', { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'tankId' })
  tank?: Equipment;

  // Denormalized tank name for quick access
  @Field({ nullable: true })
  @Column({ length: 255, nullable: true })
  tankName?: string;

  @Field({ nullable: true })
  @Column({ length: 50, nullable: true })
  tankCode?: string;

  // -------------------------------------------------------------------------
  // DAĞITIM BİLGİLERİ
  // -------------------------------------------------------------------------

  @Field(() => AllocationType)
  @Column({
    type: 'enum',
    enum: AllocationType,
    default: AllocationType.INITIAL_STOCKING,
  })
  allocationType: AllocationType;

  @Field()
  @Column({ type: 'date' })
  allocationDate: Date;

  @Field(() => Int)
  @Column({ type: 'int' })
  quantity: number;                        // Dağıtılan adet

  @Field(() => Float)
  @Column({ type: 'decimal', precision: 10, scale: 2 })
  avgWeightG: number;                      // Ortalama ağırlık (g)

  @Field(() => Float)
  @Column({ type: 'decimal', precision: 15, scale: 2 })
  biomassKg: number;                       // Toplam biomass (kg)

  // -------------------------------------------------------------------------
  // KAYNAK/HEDEF BİLGİLERİ (Transfer için)
  // -------------------------------------------------------------------------

  @Field({ nullable: true })
  @Column('uuid', { nullable: true })
  sourceTankId?: string;              // Transfer kaynağı

  @ManyToOne('Tank', { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'sourceTankId' })
  sourceTank?: Equipment;

  // Denormalized source tank name
  @Field({ nullable: true })
  @Column({ length: 255, nullable: true })
  sourceTankName?: string;

  // -------------------------------------------------------------------------
  // EK BİLGİLER
  // -------------------------------------------------------------------------

  @Field(() => Float, { nullable: true })
  @Column({ type: 'decimal', precision: 10, scale: 2, nullable: true })
  densityKgM3?: number;                    // Dağıtım sonrası yoğunluk

  @Field({ nullable: true })
  @Column({ type: 'text', nullable: true })
  notes?: string;

  // -------------------------------------------------------------------------
  // AUDIT FIELDS
  // -------------------------------------------------------------------------

  @Field()
  @Column('uuid')
  allocatedBy: string;                     // Dağıtımı yapan kullanıcı

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
}
