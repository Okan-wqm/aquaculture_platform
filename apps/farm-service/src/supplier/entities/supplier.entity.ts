/**
 * Supplier Entity - Tedarikçiler
 * Yavru, yem, ekipman, kimyasal tedarikçileri
 *
 * N:M ilişki: Bir tedarikçi birden fazla site'a hizmet verebilir (supplier_sites)
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
  VersionColumn,
  OneToMany,
} from 'typeorm';
import {
  ObjectType,
  Field,
  ID,
  Float,
  registerEnumType,
} from '@nestjs/graphql';
import GraphQLJSON from 'graphql-type-json';

// ============================================================================
// ENUMS
// ============================================================================

/**
 * Tedarikçi ana tipi
 */
export enum SupplierType {
  FRY = 'fry',                         // Yavru tedarikçisi
  FEED = 'feed',                       // Yem tedarikçisi
  EQUIPMENT = 'equipment',             // Ekipman tedarikçisi
  CHEMICAL = 'chemical',               // Kimyasal tedarikçisi
  SERVICE = 'service',                 // Servis tedarikçisi
  OTHER = 'other',                     // Diğer
}

registerEnumType(SupplierType, {
  name: 'SupplierType',
  description: 'Tedarikçi ana tipi',
});

/**
 * Tedarikçi durumu
 */
export enum SupplierStatus {
  ACTIVE = 'active',
  INACTIVE = 'inactive',
  SUSPENDED = 'suspended',
  BLACKLISTED = 'blacklisted',
}

registerEnumType(SupplierStatus, {
  name: 'SupplierStatus',
  description: 'Tedarikçi durumu',
});

// ============================================================================
// INTERFACES
// ============================================================================

export interface SupplierAddress {
  street?: string;
  city: string;
  state?: string;
  postalCode?: string;
  country: string;
}

// ============================================================================
// ENTITY
// ============================================================================

@ObjectType()
@Entity('suppliers')
@Index(['tenantId', 'code'], { unique: true })
@Index(['tenantId', 'type'])
@Index(['tenantId', 'status'])
@Index(['tenantId', 'isActive'])
export class Supplier {
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
  @Column({ length: 200 })
  name: string;

  @Field({ nullable: true })
  @Column({ length: 20, nullable: true })
  code?: string;                       // Kısa kod

  @Field(() => SupplierType)
  @Column({
    type: 'enum',
    enum: SupplierType,
    default: SupplierType.OTHER,
  })
  type: SupplierType;                  // Ana tip

  /**
   * Çoklu tip desteği: ['fry', 'feed']
   */
  @Field(() => [String], { nullable: true })
  @Column({ type: 'simple-array', nullable: true })
  supplyTypes?: string[];

  // -------------------------------------------------------------------------
  // İLETİŞİM
  // -------------------------------------------------------------------------

  @Field({ nullable: true })
  @Column({ length: 100, nullable: true })
  contactPerson?: string;

  @Field({ nullable: true })
  @Column({ length: 150, nullable: true })
  email?: string;

  @Field({ nullable: true })
  @Column({ length: 50, nullable: true })
  phone?: string;

  @Field({ nullable: true })
  @Column({ length: 200, nullable: true })
  website?: string;

  // -------------------------------------------------------------------------
  // ADRES
  // -------------------------------------------------------------------------

  @Field(() => GraphQLJSON, { nullable: true })
  @Column({ type: 'jsonb', nullable: true })
  address?: SupplierAddress;

  @Field({ nullable: true })
  @Column({ length: 100, nullable: true })
  city?: string;

  @Field({ nullable: true })
  @Column({ length: 100, nullable: true })
  country?: string;

  // -------------------------------------------------------------------------
  // DEĞERLENDİRME
  // -------------------------------------------------------------------------

  @Field(() => Float, { nullable: true })
  @Column({ type: 'decimal', precision: 2, scale: 1, nullable: true })
  rating?: number;                     // 1.0 - 5.0 arası

  // -------------------------------------------------------------------------
  // FİNANSAL
  // -------------------------------------------------------------------------

  @Field({ nullable: true })
  @Column({ length: 100, nullable: true })
  paymentTerms?: string;               // "30 gün vadeli", "Peşin"

  @Field({ nullable: true })
  @Column({ length: 50, nullable: true })
  taxId?: string;                      // Vergi numarası

  // -------------------------------------------------------------------------
  // ÜRÜNLER
  // -------------------------------------------------------------------------

  @Field(() => [String], { nullable: true })
  @Column({ type: 'simple-array', nullable: true })
  products?: string[];                 // Sunduğu ürünler listesi

  // -------------------------------------------------------------------------
  // DURUM
  // -------------------------------------------------------------------------

  @Field(() => SupplierStatus)
  @Column({
    type: 'enum',
    enum: SupplierStatus,
    default: SupplierStatus.ACTIVE,
  })
  status: SupplierStatus;

  @Field()
  @Column({ default: true })
  @Index()
  isActive: boolean;

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

  // @OneToMany(() => SupplierSite, (ss) => ss.supplier)
  // supplierSites?: SupplierSite[];

  // -------------------------------------------------------------------------
  // BUSINESS METHODS
  // -------------------------------------------------------------------------

  /**
   * Rating değerinin geçerli olup olmadığını kontrol eder
   */
  hasValidRating(): boolean {
    if (this.rating === null || this.rating === undefined) return true;
    return this.rating >= 1 && this.rating <= 5;
  }

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
