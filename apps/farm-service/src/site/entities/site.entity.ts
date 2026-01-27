/**
 * Site Entity - Fiziksel lokasyon/tesis
 * Bir tenant birden fazla site'a sahip olabilir
 *
 * Hiyerarşi: Tenant -> Site -> Department -> System -> SubSystem -> Equipment
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
  OneToMany,
  VersionColumn,
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
 * Site tipi - Tesis türü
 */
export enum SiteType {
  LAND_BASED = 'land_based',           // Kara tabanlı RAS
  SEA_CAGE = 'sea_cage',               // Deniz kafesi
  POND = 'pond',                       // Gölet/Havuz
  RACEWAY = 'raceway',                 // Oluk sistemi
  RECIRCULATING = 'recirculating',     // Kapalı devre (RAS)
  HATCHERY = 'hatchery',               // Kuluçkahane
}

registerEnumType(SiteType, {
  name: 'SiteType',
  description: 'Tesis türü',
});

/**
 * Site durumu
 */
export enum SiteStatus {
  ACTIVE = 'active',
  MAINTENANCE = 'maintenance',
  INACTIVE = 'inactive',
  CLOSED = 'closed',
}

registerEnumType(SiteStatus, {
  name: 'SiteStatus',
  description: 'Tesis durumu',
});

// ============================================================================
// INTERFACES
// ============================================================================

/**
 * Site GPS koordinatları
 */
export interface SiteLocation {
  latitude: number;                    // -90 ile 90 arası
  longitude: number;                   // -180 ile 180 arası
  altitude?: number;
}

/**
 * Site adres bilgileri
 */
export interface SiteAddress {
  street?: string;
  city: string;
  state?: string;
  postalCode?: string;
  country: string;
}

/**
 * Site tesisleri ve olanakları
 */
export interface SiteFacilities {
  waterSupply: boolean;                // Su temini
  electricity: boolean;                // Elektrik
  generator: boolean;                  // Jeneratör
  storage: boolean;                    // Depo
  office: boolean;                     // Ofis
  workshop: boolean;                   // Atölye
  feedStorage: boolean;                // Yem deposu
  coldStorage: boolean;                // Soğuk depo
  laboratory: boolean;                 // Laboratuvar
  quarantine: boolean;                 // Karantina alanı
  processingArea: boolean;             // İşleme alanı
  staffQuarters: boolean;              // Personel konaklama
}

/**
 * Site ayarları
 */
export interface SiteSettings {
  timezone: string;
  locale: string;
  currency: string;
  measurementSystem: 'metric' | 'imperial';
  operatingHours?: {
    start: string;
    end: string;
  };
  emergencyContacts?: Array<{
    name: string;
    phone: string;
    role: string;
  }>;
}

// ============================================================================
// ENTITY
// ============================================================================

@ObjectType()
@Entity('sites')
@Index(['tenantId', 'code'], { unique: true })
@Index(['tenantId', 'name'], { unique: true })
@Index(['tenantId', 'status'])
@Index(['tenantId', 'type'])
@Index(['tenantId', 'isActive'])
export class Site {
  @Field(() => ID)
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Field()
  @Column('uuid')
  @Index()
  tenantId!: string;

  // -------------------------------------------------------------------------
  // TEMEL BİLGİLER
  // -------------------------------------------------------------------------

  @Field()
  @Column({ length: 150 })
  name!: string;

  @Field()
  @Column({ length: 20 })
  code!: string;                        // Kısa kod: "BOD-01"

  @Field(() => SiteType)
  @Column({
    type: 'enum',
    enum: SiteType,
    default: SiteType.LAND_BASED,
  })
  type!: SiteType;

  @Field({ nullable: true })
  @Column({ type: 'text', nullable: true })
  description?: string;

  // -------------------------------------------------------------------------
  // LOKASYON
  // -------------------------------------------------------------------------

  @Field(() => GraphQLJSON, { nullable: true })
  @Column({ type: 'jsonb', nullable: true })
  location?: SiteLocation;

  @Field(() => GraphQLJSON, { nullable: true })
  @Column({ type: 'jsonb', nullable: true })
  address?: SiteAddress;

  @Field({ nullable: true })
  @Column({ length: 100, nullable: true })
  city?: string;

  @Field({ nullable: true })
  @Column({ length: 100, nullable: true })
  country?: string;

  @Field({ nullable: true })
  @Column({ length: 50, default: 'UTC' })
  timezone!: string;

  // -------------------------------------------------------------------------
  // KAPASİTE
  // -------------------------------------------------------------------------

  @Field(() => Float, { nullable: true })
  @Column({ type: 'decimal', precision: 12, scale: 2, nullable: true })
  areaM2?: number;                     // Tesis alanı (m²)

  @Field(() => Float, { nullable: true })
  @Column({ type: 'decimal', precision: 12, scale: 2, nullable: true })
  waterCapacityM3?: number;            // Su kapasitesi (m³)

  @Field(() => Float, { nullable: true })
  @Column({ type: 'decimal', precision: 12, scale: 2, nullable: true })
  maxBiomassKg?: number;               // Maksimum biyokütle kapasitesi (kg)

  // -------------------------------------------------------------------------
  // TARİHLER
  // -------------------------------------------------------------------------

  @Field({ nullable: true })
  @Column({ type: 'date', nullable: true })
  establishedDate?: Date;

  // -------------------------------------------------------------------------
  // İLETİŞİM
  // -------------------------------------------------------------------------

  @Field({ nullable: true })
  @Column({ length: 50, nullable: true })
  contactPhone?: string;

  @Field({ nullable: true })
  @Column({ length: 150, nullable: true })
  contactEmail?: string;

  // -------------------------------------------------------------------------
  // TESİS ÖZELLİKLERİ
  // -------------------------------------------------------------------------

  @Field(() => GraphQLJSON, { nullable: true })
  @Column({ type: 'jsonb', nullable: true })
  facilities?: SiteFacilities;

  // -------------------------------------------------------------------------
  // AYARLAR
  // -------------------------------------------------------------------------

  @Field(() => GraphQLJSON, { nullable: true })
  @Column({ type: 'jsonb', nullable: true })
  settings?: SiteSettings;

  // -------------------------------------------------------------------------
  // DURUM
  // -------------------------------------------------------------------------

  @Field(() => SiteStatus)
  @Column({
    type: 'enum',
    enum: SiteStatus,
    default: SiteStatus.ACTIVE,
  })
  status!: SiteStatus;

  @Field()
  @Column({ default: true })
  @Index()
  isActive!: boolean;

  @Field({ nullable: true })
  @Column({ type: 'text', nullable: true })
  notes?: string;

  @Field(() => GraphQLJSON, { nullable: true })
  @Column({ type: 'jsonb', nullable: true })
  metadata?: Record<string, unknown>;

  // -------------------------------------------------------------------------
  // AUDIT FIELDS
  // -------------------------------------------------------------------------

  @Field()
  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @Field()
  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;

  @Field({ nullable: true })
  @Column('uuid', { nullable: true })
  createdBy?: string;

  @Field({ nullable: true })
  @Column('uuid', { nullable: true })
  updatedBy?: string;

  @VersionColumn()
  version!: number;

  // -------------------------------------------------------------------------
  // SOFT DELETE
  // -------------------------------------------------------------------------

  @Field()
  @Column({ default: false })
  @Index()
  isDeleted!: boolean;

  @Field({ nullable: true })
  @Column({ type: 'timestamptz', nullable: true })
  deletedAt?: Date;

  @Field({ nullable: true })
  @Column('uuid', { nullable: true })
  deletedBy?: string;

  // -------------------------------------------------------------------------
  // İLİŞKİLER
  // -------------------------------------------------------------------------

  // @OneToMany(() => SiteContact, (contact) => contact.site)
  // contacts?: SiteContact[];

  // @OneToMany(() => Department, (department) => department.site)
  // departments?: Department[];

  // @OneToMany(() => System, (system) => system.site)
  // systems?: System[];

  // -------------------------------------------------------------------------
  // BUSINESS METHODS
  // -------------------------------------------------------------------------

  /**
   * Koordinatların geçerli olup olmadığını kontrol eder
   */
  hasValidCoordinates(): boolean {
    if (!this.location) return false;
    const { latitude, longitude } = this.location;
    return (
      latitude >= -90 &&
      latitude <= 90 &&
      longitude >= -180 &&
      longitude <= 180
    );
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
