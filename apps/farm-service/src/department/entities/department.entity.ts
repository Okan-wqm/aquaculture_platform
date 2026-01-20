/**
 * Department Entity - Site içindeki departmanlar
 * Örnek: Grow-out, Hatchery, Nursery, Processing
 *
 * Hiyerarşi: Tenant -> Site -> Department
 * Departmanlar personel atamaları ve organizasyonel yapı için kullanılır.
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
  registerEnumType,
} from '@nestjs/graphql';
import GraphQLJSON from 'graphql-type-json';
// Note: Site is referenced via string to avoid circular dependency

// ============================================================================
// ENUMS
// ============================================================================

/**
 * Departman türü
 */
export enum DepartmentType {
  PRODUCTION = 'production',           // Üretim Departmanı
  MAINTENANCE = 'maintenance',         // Bakım Departmanı
  QUALITY_CONTROL = 'quality_control', // Kalite Kontrol
  FEED = 'feed',                       // Yem Departmanı
  ADMINISTRATION = 'administration',   // İdari İşler
  HATCHERY = 'hatchery',               // Kuluçkahane
  NURSERY = 'nursery',                 // Fidanlık/Yavru yetiştirme
  GROW_OUT = 'grow_out',               // Büyütme
  BROODSTOCK = 'broodstock',           // Anaç stok
  QUARANTINE = 'quarantine',           // Karantina
  PROCESSING = 'processing',           // İşleme
  LABORATORY = 'laboratory',           // Laboratuvar
  OTHER = 'other',
}

registerEnumType(DepartmentType, {
  name: 'DepartmentType',
  description: 'Departman türü',
});

/**
 * Departman durumu
 */
export enum DepartmentStatus {
  ACTIVE = 'active',
  INACTIVE = 'inactive',
}

registerEnumType(DepartmentStatus, {
  name: 'DepartmentStatus',
  description: 'Departman durumu',
});

// ============================================================================
// ENTITY
// ============================================================================

@ObjectType()
@Entity('departments')
@Index(['tenantId', 'code'], { unique: true })
@Index(['tenantId', 'siteId'])
@Index(['tenantId', 'status'])
export class Department {
  @Field(() => ID)
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Field()
  @Column('uuid')
  @Index()
  tenantId: string;

  // -------------------------------------------------------------------------
  // SITE İLİŞKİSİ (nullable - orphaned departments when site is deleted)
  // -------------------------------------------------------------------------

  @Field({ nullable: true })
  @Column('uuid', { nullable: true })
  @Index()
  siteId?: string;

  @ManyToOne('Site', { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'siteId' })
  site?: any;

  // -------------------------------------------------------------------------
  // TEMEL BİLGİLER
  // -------------------------------------------------------------------------

  @Field()
  @Column({ length: 100 })
  name: string;

  @Field()
  @Column({ length: 20 })
  code: string;                        // Kısa kod: "PROD", "MAINT"

  @Field(() => DepartmentType)
  @Column({
    type: 'enum',
    enum: DepartmentType,
    default: DepartmentType.PRODUCTION,
  })
  type: DepartmentType;

  @Field({ nullable: true })
  @Column({ type: 'text', nullable: true })
  description?: string;

  @Field({ nullable: true })
  @Column({ type: 'float', nullable: true })
  capacity?: number;

  @Field({ nullable: true })
  @Column({ type: 'text', nullable: true })
  notes?: string;

  // -------------------------------------------------------------------------
  // YÖNETİCİ
  // -------------------------------------------------------------------------

  @Field({ nullable: true })
  @Column('uuid', { nullable: true })
  managerUserId?: string;              // Users tablosundan

  @Field({ nullable: true })
  @Column({ length: 255, nullable: true })
  managerName?: string;                // Denormalized for quick access

  // -------------------------------------------------------------------------
  // DURUM
  // -------------------------------------------------------------------------

  @Field(() => DepartmentStatus)
  @Column({
    type: 'enum',
    enum: DepartmentStatus,
    default: DepartmentStatus.ACTIVE,
  })
  status: DepartmentStatus;

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

  // @OneToMany(() => Equipment, (equipment) => equipment.department)
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
