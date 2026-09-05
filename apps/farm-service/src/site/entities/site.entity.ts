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
import { DecimalTransformer } from '@aquaculture/backend-common/database';
import { ObjectType, Field, ID, Int, Float, registerEnumType } from '@nestjs/graphql';
import GraphQLJSON from 'graphql-type-json';

// ============================================================================
// ENUMS
// ============================================================================

/**
 * Site tipi - Tesis türü
 */
export enum SiteType {
  LAND_BASED = 'land_based', // Kara tabanlı RAS
  SEA_CAGE = 'sea_cage', // Deniz kafesi
  POND = 'pond', // Gölet/Havuz
  RACEWAY = 'raceway', // Oluk sistemi
  RECIRCULATING = 'recirculating', // Kapalı devre (RAS)
  HATCHERY = 'hatchery', // Kuluçkahane
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
  latitude: number; // -90 ile 90 arası
  longitude: number; // -180 ile 180 arası
  altitude?: number;
}

export type MonitoringPosition = [longitude: number, latitude: number];

export interface MonitoringPolygon {
  type: 'Polygon';
  coordinates: MonitoringPosition[][];
}

export interface MonitoringMultiPolygon {
  type: 'MultiPolygon';
  coordinates: MonitoringPosition[][][];
}

export type MonitoringAreaGeometry = MonitoringPolygon | MonitoringMultiPolygon;

/**
 * Site adres bilgileri
 */
export interface SiteAddress {
  street?: string;
  city?: string;
  state?: string;
  postalCode?: string;
  country?: string;
}

/**
 * Site tesisleri ve olanakları
 */
export interface SiteFacilities {
  waterSupply: boolean; // Su temini
  electricity: boolean; // Elektrik
  generator: boolean; // Jeneratör
  storage: boolean; // Depo
  office: boolean; // Ofis
  workshop: boolean; // Atölye
  feedStorage: boolean; // Yem deposu
  coldStorage: boolean; // Soğuk depo
  laboratory: boolean; // Laboratuvar
  quarantine: boolean; // Karantina alanı
  processingArea: boolean; // İşleme alanı
  staffQuarters: boolean; // Personel konaklama
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
@Index('uq_sites_tenant_identity', ['tenantId', 'id'], { unique: true })
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
  code!: string; // Kısa kod: "BOD-01"

  /**
   * Norwegian locality number from the Akvakulturregisteret (5-digit) — the
   * primary site key in every regulatory report. Nullable: non-Norwegian /
   * non-reporting sites have none; reporting fails closed without it.
   * Unique per tenant (partial index). RPT-015: this column is the SSoT;
   * regulatory_settings.site_locality_mappings is a transition fallback
   * removed in Phase 4.
   */
  @Field(() => Int, { nullable: true })
  @Column({ type: 'int', nullable: true })
  lokalitetsnummer?: number;

  /** Org number override when this site is operated under a different entity. */
  @Field({ nullable: true })
  @Column({ length: 20, nullable: true })
  organisationNumberOverride?: string;

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
  location?: SiteLocation | null;

  @Field(() => Int)
  @Column({ type: 'int', default: 2000 })
  monitoringRadiusM!: number;

  @Field(() => GraphQLJSON, { nullable: true })
  @Column({ type: 'jsonb', nullable: true })
  monitoringArea?: MonitoringAreaGeometry | null;

  @Field(() => Int)
  @Column({ type: 'int', default: 1 })
  monitoringLocationRevision!: number;

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
  @Column({ length: 100, nullable: true })
  region?: string;

  /**
   * Sitenin IANA saat dilimi. **NULL = tenant lokalizasyonundan DEVRAL**
   * (W5): yemleme motorunun zon hiyerarşisi site → tenant → UTC'dir ve
   * kalıtım ancak "belirtilmemiş" durumu temsil edilebildiğinde mümkündür.
   * Eski `NOT NULL DEFAULT 'UTC'` şeması "UTC seçildi" ile "hiç seçilmedi"yi
   * ayırt edemiyordu; tenant zonunu ayarladığında siteler UTC'de kalıyordu.
   */
  @Field(() => String, { nullable: true })
  // `type` AÇIK OLMAK ZORUNDA. Alan tipi bir birleşim (`string | null`) ve
  // TypeScript birleşimler için `design:type` metadata'sını `Object` olarak
  // yayar. Açık bir `type:` yoksa TypeORM o çıkarımı benimser ve entity
  // metadata'sı kurulurken
  //   DataTypeNotSupportedError: Data type "Object" in "Site.timezone"
  // ile PATLAR — farm-service'in TÜM metadata'sı kurulamadığı için taze bir
  // veritabanında migration zinciri hiç koşamaz (bootstrap-from-scratch 70/70).
  // Nullable ama `?: string` yazılan kolonlar bu tuzağa düşmez, çünkü orada
  // `design:type` `String`'tir; kalıtımı temsil etmek için NULL'ı açıkça
  // taşımak istediğimizden burada birleşim korunur ve tip elle bildirilir.
  @Column({ type: 'varchar', length: 50, nullable: true })
  timezone!: string | null;

  // -------------------------------------------------------------------------
  // KAPASİTE
  // -------------------------------------------------------------------------

  @Field(() => Float, { nullable: true })
  @Column({
    type: 'decimal',
    precision: 12,
    scale: 2,
    nullable: true,
    transformer: new DecimalTransformer(),
  })
  areaM2?: number; // Tesis alanı (m²)

  get totalArea(): number | undefined {
    return this.areaM2;
  }

  @Field(() => Float, { nullable: true })
  @Column({
    type: 'decimal',
    precision: 12,
    scale: 2,
    nullable: true,
    transformer: new DecimalTransformer(),
  })
  waterCapacityM3?: number; // Su kapasitesi (m³)

  @Field(() => Float, { nullable: true })
  @Column({
    type: 'decimal',
    precision: 12,
    scale: 2,
    nullable: true,
    transformer: new DecimalTransformer(),
  })
  maxBiomassKg?: number; // Maksimum biyokütle kapasitesi (kg)

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

  @Field({ nullable: true })
  @Column({ length: 255, nullable: true })
  siteManager?: string;

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
    return latitude >= -90 && latitude <= 90 && longitude >= -180 && longitude <= 180;
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
