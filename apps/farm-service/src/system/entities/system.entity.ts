/**
 * System Entity - Site içindeki üretim sistemleri
 * Örnek: RAS System A, Flow-through System, Pond System
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
  OneToMany,
  JoinColumn,
  VersionColumn,
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
import { Site } from '../../site/entities/site.entity';
import { Department } from '../../department/entities/department.entity';

// ============================================================================
// ENUMS
// ============================================================================

/**
 * Sistem tipi
 */
export enum SystemType {
  RAS = 'ras',                       // Recirculating Aquaculture System
  FLOW_THROUGH = 'flow_through',     // Akış geçişli sistem
  POND = 'pond',                     // Havuz sistemi
  CAGE = 'cage',                     // Kafes sistemi
  RACEWAY = 'raceway',               // Kanal sistemi
  HATCHERY = 'hatchery',             // Kuluçkahane sistemi
  NURSERY = 'nursery',               // Fidanlık sistemi
  BIOFLOC = 'biofloc',               // Biofloc sistemi
  AQUAPONICS = 'aquaponics',         // Akuaponik sistem
  OTHER = 'other',
}

registerEnumType(SystemType, {
  name: 'SystemType',
  description: 'Sistem tipi',
});

/**
 * Sistem durumu
 */
export enum SystemStatus {
  OPERATIONAL = 'operational',       // Çalışır
  MAINTENANCE = 'maintenance',       // Bakımda
  OFFLINE = 'offline',               // Devre dışı
  CONSTRUCTION = 'construction',     // Yapım aşamasında
}

registerEnumType(SystemStatus, {
  name: 'SystemStatus',
  description: 'Sistem durumu',
});

// ============================================================================
// ENTITY
// ============================================================================

@ObjectType()
@Entity('systems')
@Index(['tenantId', 'siteId', 'code'], { unique: true })
@Index(['tenantId', 'siteId'])
@Index(['tenantId', 'type'])
@Index(['tenantId', 'status'])
export class System {
  @Field(() => ID)
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Field()
  @Column('uuid')
  @Index()
  tenantId: string;

  // -------------------------------------------------------------------------
  // SITE İLİŞKİSİ
  // -------------------------------------------------------------------------

  @Field()
  @Column('uuid')
  @Index()
  siteId: string;

  @ManyToOne(() => Site, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'siteId' })
  site: Site;

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
  // PARENT SYSTEM İLİŞKİSİ (Self-referencing)
  // -------------------------------------------------------------------------

  @Field({ nullable: true })
  @Column('uuid', { nullable: true })
  @Index()
  parentSystemId?: string;

  @Field(() => System, { nullable: true })
  @ManyToOne(() => System, (system) => system.childSystems, {
    onDelete: 'SET NULL',
    nullable: true,
  })
  @JoinColumn({ name: 'parentSystemId' })
  parentSystem?: System;

  @Field(() => [System], { nullable: true })
  @OneToMany(() => System, (system) => system.parentSystem)
  childSystems?: System[];

  // -------------------------------------------------------------------------
  // TEMEL BİLGİLER
  // -------------------------------------------------------------------------

  @Field()
  @Column({ length: 100 })
  name: string;

  @Field()
  @Column({ length: 20 })
  code: string;                        // "SYS-01", "RAS-A"

  @Field(() => SystemType)
  @Column({
    type: 'enum',
    enum: SystemType,
    default: SystemType.OTHER,
  })
  type: SystemType;

  @Field({ nullable: true })
  @Column({ type: 'text', nullable: true })
  description?: string;

  // -------------------------------------------------------------------------
  // KAPASİTE
  // -------------------------------------------------------------------------

  @Field(() => Float, { nullable: true })
  @Column({ type: 'decimal', precision: 12, scale: 2, nullable: true })
  totalVolumeM3?: number;              // Toplam su hacmi (m³)

  @Field(() => Float, { nullable: true })
  @Column({ type: 'decimal', precision: 12, scale: 2, nullable: true })
  maxBiomassKg?: number;               // Maksimum biyokütle (kg)

  @Field(() => Int, { nullable: true })
  @Column({ type: 'int', nullable: true })
  tankCount?: number;                  // Tank sayısı

  // -------------------------------------------------------------------------
  // DURUM
  // -------------------------------------------------------------------------

  @Field(() => SystemStatus)
  @Column({
    type: 'enum',
    enum: SystemStatus,
    default: SystemStatus.OPERATIONAL,
  })
  status: SystemStatus;

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

  // @OneToMany(() => SubSystem, (subSystem) => subSystem.system)
  // subSystems?: SubSystem[];

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
