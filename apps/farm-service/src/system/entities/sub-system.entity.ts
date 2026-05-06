/**
 * SubSystem Entity - Sistem içindeki alt sistemler
 * Örnek: Havalandırma, Filtrasyon, UV Sterilizasyon
 *
 * Hiyerarşi: Tenant -> Site -> System -> SubSystem -> Equipment
 *
 * @module Farm
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
  VersionColumn,
} from 'typeorm';
import {
  ObjectType,
  Field,
  ID,
  registerEnumType,
} from '@nestjs/graphql';
import { System } from './system.entity';
import { Department } from '../../department/entities/department.entity';

// ============================================================================
// ENUMS
// ============================================================================

/**
 * Alt sistem tipi
 */
export enum SubSystemType {
  AERATION = 'aeration',             // Havalandırma
  FILTRATION = 'filtration',         // Filtrasyon (mekanik)
  BIOLOGICAL = 'biological',         // Biyolojik filtrasyon
  HEATING = 'heating',               // Isıtma
  COOLING = 'cooling',               // Soğutma
  UV = 'uv',                         // UV sterilizasyon
  OZONE = 'ozone',                   // Ozon
  OXYGEN = 'oxygen',                 // Oksijen sistemi
  PUMPING = 'pumping',               // Pompalama
  FEEDING = 'feeding',               // Besleme sistemi
  MONITORING = 'monitoring',         // İzleme/sensör sistemi
  OTHER = 'other',
}

registerEnumType(SubSystemType, {
  name: 'SubSystemType',
  description: 'Alt sistem tipi',
});

/**
 * Alt sistem durumu
 */
export enum SubSystemStatus {
  OPERATIONAL = 'operational',       // Çalışır
  MAINTENANCE = 'maintenance',       // Bakımda
  INACTIVE = 'inactive',             // Devre dışı
}

registerEnumType(SubSystemStatus, {
  name: 'SubSystemStatus',
  description: 'Alt sistem durumu',
});

// ============================================================================
// ENTITY
// ============================================================================

@ObjectType()
@Entity('sub_systems')
@Index(['tenantId', 'systemId', 'code'], { unique: true })
@Index(['tenantId', 'systemId'])
@Index(['tenantId', 'type'])
@Index(['tenantId', 'status'])
export class SubSystem {
  @Field(() => ID)
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Field()
  @Column('uuid')
  @Index()
  tenantId: string;

  // -------------------------------------------------------------------------
  // SYSTEM İLİŞKİSİ
  // -------------------------------------------------------------------------

  @Field()
  @Column('uuid')
  @Index()
  systemId: string;

  @ManyToOne(() => System, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'systemId' })
  system: System;

  // -------------------------------------------------------------------------
  // DEPARTMENT İLİŞKİSİ
  // -------------------------------------------------------------------------

  @Field({ nullable: true })
  @Column('uuid', { nullable: true })
  departmentId?: string;

  @ManyToOne(() => Department, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'departmentId' })
  department?: Department;

  // -------------------------------------------------------------------------
  // TEMEL BİLGİLER
  // -------------------------------------------------------------------------

  @Field()
  @Column({ length: 100 })
  name: string;

  @Field()
  @Column({ length: 20 })
  code: string;

  @Field(() => SubSystemType)
  @Column({
    type: 'enum',
    enum: SubSystemType,
    default: SubSystemType.OTHER,
  })
  type: SubSystemType;

  @Field({ nullable: true })
  @Column({ type: 'text', nullable: true })
  description?: string;

  // -------------------------------------------------------------------------
  // DURUM
  // -------------------------------------------------------------------------

  @Field(() => SubSystemStatus)
  @Column({
    type: 'enum',
    enum: SubSystemStatus,
    default: SubSystemStatus.OPERATIONAL,
  })
  status: SubSystemStatus;

  @Field()
  @Column({ default: true })
  @Index()
  isActive: boolean;

  // -------------------------------------------------------------------------
  // AUDIT FIELDS
  // -------------------------------------------------------------------------

  @Field()
  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @Field()
  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;

  @Field({ nullable: true })
  @Column('uuid', { nullable: true })
  createdBy?: string;

  @Field({ nullable: true })
  @Column('uuid', { nullable: true })
  updatedBy?: string;

  @VersionColumn()
  version: number;

  // -------------------------------------------------------------------------
  // SOFT DELETE
  // -------------------------------------------------------------------------

  @Field()
  @Column({ default: false })
  @Index()
  isDeleted: boolean;

  @Field({ nullable: true })
  @Column({ type: 'timestamptz', nullable: true })
  deletedAt?: Date;

  @Field({ nullable: true })
  @Column('uuid', { nullable: true })
  deletedBy?: string;

  // -------------------------------------------------------------------------
  // İLİŞKİLER
  // -------------------------------------------------------------------------

  // @OneToMany(() => Equipment, (equipment) => equipment.subSystem)
  // equipment?: Equipment[];

  // -------------------------------------------------------------------------
  // BUSINESS METHODS
  // -------------------------------------------------------------------------

  /**
   * Soft delete işlemi
   */
  softDelete(deletedBy?: string): void {
    this.isDeleted = true;
    this.deletedAt = new Date();
    this.deletedBy = deletedBy;
    this.isActive = false;
  }

  /**
   * Soft delete geri alma
   */
  restore(): void {
    this.isDeleted = false;
    this.deletedAt = undefined;
    this.deletedBy = undefined;
    this.isActive = true;
  }
}
