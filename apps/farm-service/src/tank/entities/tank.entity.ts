/**
 * Tank Entity - Yetiştirme Tankları
 *
 * Akuakültür tesislerinde kullanılan fiziksel tanklar.
 * Tank tipleri: Circular (dairesel), Rectangular (dikdörtgen), Raceway (kanal).
 *
 * Özellikler:
 * - Otomatik hacim hesaplama (boyutlara göre)
 * - Biomass ve yoğunluk takibi
 * - Sistem ve ekipman ilişkileri
 * - Status yönetimi
 *
 * @module Tank
 */
import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
  VersionColumn,
  ManyToOne,
  OneToMany,
  JoinColumn,
  BeforeInsert,
  BeforeUpdate,
} from 'typeorm';
import { DecimalTransformer } from '@aquaculture/backend-common/database';
import { ObjectType, Field, ID, Float, Int, Directive, registerEnumType } from '@nestjs/graphql';
import GraphQLJSON from 'graphql-type-json';
import { Department } from '../../department/entities/department.entity';
import { WaterType } from '../../farm/entities/pond.entity';

// Re-export WaterType so existing imports from this file continue to work
export { WaterType };

// ============================================================================
// ENUMS
// ============================================================================

/**
 * Tank tipi - Fiziksel şekil
 */
export enum TankType {
  CIRCULAR = 'circular', // Dairesel tank
  RECTANGULAR = 'rectangular', // Dikdörtgen tank
  RACEWAY = 'raceway', // Kanal tipi (uzun, dar)
  D_END = 'd_end', // D-uçlu raceway
  OVAL = 'oval', // Oval tank
  SQUARE = 'square', // Kare tank
  OTHER = 'other',
}

registerEnumType(TankType, {
  name: 'TankType',
  description: 'Tank fiziksel şekli',
});

/**
 * Tank malzemesi
 */
export enum TankMaterial {
  FIBERGLASS = 'fiberglass', // Cam elyaf
  CONCRETE = 'concrete', // Beton
  HDPE = 'hdpe', // Yüksek yoğunluklu polietilen
  STEEL = 'steel', // Çelik
  STAINLESS_STEEL = 'stainless_steel', // Paslanmaz çelik
  PVC = 'pvc', // PVC
  LINER = 'liner', // Kaplama (havuz için)
  OTHER = 'other',
}

registerEnumType(TankMaterial, {
  name: 'TankMaterial',
  description: 'Tank malzemesi',
});

// Note: WaterType is imported from pond.entity.ts to avoid duplicate GraphQL type registration

/**
 * Tank durumu
 */
export enum TankStatus {
  ACTIVE = 'active', // Aktif - içinde balık var
  PREPARING = 'preparing', // Hazırlanıyor
  CLEANING = 'cleaning', // Temizleniyor
  MAINTENANCE = 'maintenance', // Bakımda
  HARVESTING = 'harvesting', // Hasat yapılıyor
  FALLOW = 'fallow', // Boş/Dinlendirme
  QUARANTINE = 'quarantine', // Karantina
  INACTIVE = 'inactive', // Kullanım dışı
}

registerEnumType(TankStatus, {
  name: 'TankStatus',
  description: 'Tank durumu',
});

export enum TankContainerKind {
  TANK = 'TANK',
  POND = 'POND',
  CAGE = 'CAGE',
}

registerEnumType(TankContainerKind, {
  name: 'TankContainerKind',
  description: 'Canonical setup container kind for tank-like equipment compatibility',
});

// ============================================================================
// INTERFACES
// ============================================================================

/**
 * Tank boyutları - Tipe göre değişir
 */
export interface TankDimensions {
  // Circular tank için
  diameter?: number; // m

  // Rectangular/Raceway için
  length?: number; // m
  width?: number; // m

  // Tüm tipler için
  depth: number; // m
  freeboard?: number; // Su yüzeyinden tank kenarına mesafe (m)

  // Water level
  waterDepth?: number; // Gerçek su derinliği (m)
}

/**
 * Tank konumu
 */
export interface TankLocation {
  building?: string; // Bina adı
  section?: string; // Seksiyon
  row?: number; // Satır numarası
  column?: number; // Sütun numarası
  floor?: string; // Kat
  coordinates?: {
    x: number;
    y: number;
    z?: number;
  };
  notes?: string;
}

/**
 * Su akış özellikleri
 */
export interface WaterFlowProperties {
  flowRate?: number; // L/dakika
  flowRateUnit?: 'L/min' | 'm3/h';
  exchangeRate?: number; // Hacim/saat değişim oranı
  inletCount?: number; // Giriş sayısı
  outletCount?: number; // Çıkış sayısı
  inletDiameter?: number; // mm
  outletDiameter?: number; // mm
  drainType?: 'center' | 'side' | 'dual' | 'other';
}

/**
 * Kapasite ve yoğunluk limitleri
 */
export interface TankCapacity {
  maxBiomass: number; // Maksimum biomass (kg)
  currentBiomass: number; // Mevcut biomass (kg)
  maxDensity: number; // Maksimum yoğunluk (kg/m³)
  currentDensity?: number; // Mevcut yoğunluk (kg/m³) - computed
  maxCount?: number; // Maksimum adet
  currentCount?: number; // Mevcut adet
  utilizationPercent?: number; // Kullanım yüzdesi - computed
}

/**
 * Havalandırma sistemi bilgileri
 */
export interface AerationInfo {
  [key: string]: unknown;
  hasAeration: boolean;
  aerationType?: 'diffuser' | 'paddle_wheel' | 'venturi' | 'blower' | 'other';
  aeratorCount?: number;
  airFlowRate?: number; // L/dakika
  targetDO?: number; // Hedef çözünmüş oksijen (mg/L)
}

// ============================================================================
// ENTITY
// ============================================================================

@ObjectType()
@Directive('@key(fields: "id")')
@Entity('tanks')
@Index(['tenantId', 'code'], { unique: true })
@Index(['tenantId', 'departmentId'])
@Index(['tenantId', 'status'])
@Index(['tenantId', 'tankType'])
@Index(['tenantId', 'waterType'])
@Index(['tenantId', 'isActive'])
@Index(['departmentId', 'status'])
@Index(['tenantId', 'systemId'])
@Index(['tenantId', 'containerKind'])
@Index(['tenantId', 'equipmentTypeId'])
export class Tank {
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
  @Column({ length: 255 })
  name: string;

  @Field()
  @Column({ length: 50 })
  code: string; // TNK-2024-00001

  @Field({ nullable: true })
  @Column({ type: 'text', nullable: true })
  description?: string;

  // -------------------------------------------------------------------------
  // İLİŞKİLER
  // -------------------------------------------------------------------------

  @Field()
  @Column('uuid')
  departmentId: string;

  @ManyToOne(() => Department, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'departmentId' })
  department: Department;

  @Field({ nullable: true })
  @Column('uuid', { nullable: true })
  systemId?: string; // Bağlı olduğu sistem (varsa)

  @Field(() => TankContainerKind)
  @Column({
    type: 'enum',
    enum: TankContainerKind,
    default: TankContainerKind.TANK,
  })
  containerKind: TankContainerKind;

  @Field({ nullable: true })
  @Column('uuid', { nullable: true })
  equipmentTypeId?: string;

  /**
   * Linked temperature sensor (sensor-service `sensors.id`), set at tank/pond/cage
   * creation. Soft cross-service reference; WaterTemperatureService reads the
   * tank's current temperature from this sensor's latest reading (preferring it
   * over the latest manual measurement when it is more recent).
   */
  @Field(() => ID, { nullable: true })
  @Column({ type: 'uuid', nullable: true })
  temperatureSensorId?: string;

  @Field({ nullable: true })
  @Column({ length: 100, nullable: true })
  equipmentTypeCode?: string;

  /**
   * Official regulatory unit id (kar-/merd-nummer) reported to Mattilsynet as
   * `karId` in the settefisk report (RPT-016b). Optional override for when the
   * regulator's unit number differs from the internal `code`; the settefisk
   * assembler falls back to `code` when this is unset. Partial-unique per
   * tenant (only non-null values must be distinct).
   */
  @Field({ nullable: true })
  @Column({ length: 50, nullable: true })
  regulatoryUnitId?: string;

  // -------------------------------------------------------------------------
  // TİP VE MALZEME
  // -------------------------------------------------------------------------

  @Field(() => TankType)
  @Column({
    type: 'enum',
    enum: TankType,
    default: TankType.CIRCULAR,
  })
  tankType: TankType;

  @Field(() => TankMaterial)
  @Column({
    type: 'enum',
    enum: TankMaterial,
    default: TankMaterial.FIBERGLASS,
  })
  material: TankMaterial;

  @Field(() => WaterType)
  @Column({
    type: 'enum',
    enum: WaterType,
    default: WaterType.SALTWATER,
  })
  waterType: WaterType;

  // -------------------------------------------------------------------------
  // BOYUTLAR (Dimensions are required based on tank type)
  // -------------------------------------------------------------------------

  /**
   * Çap - Sadece CIRCULAR, OVAL tanklar için
   */
  @Field(() => Float, { nullable: true })
  @Column({
    type: 'decimal',
    precision: 10,
    scale: 2,
    nullable: true,
    transformer: new DecimalTransformer(),
  })
  diameter?: number;

  /**
   * Uzunluk - RECTANGULAR, RACEWAY, D_END tanklar için
   */
  @Field(() => Float, { nullable: true })
  @Column({
    type: 'decimal',
    precision: 10,
    scale: 2,
    nullable: true,
    transformer: new DecimalTransformer(),
  })
  length?: number;

  /**
   * Genişlik - RECTANGULAR, RACEWAY, D_END, SQUARE tanklar için
   */
  @Field(() => Float, { nullable: true })
  @Column({
    type: 'decimal',
    precision: 10,
    scale: 2,
    nullable: true,
    transformer: new DecimalTransformer(),
  })
  width?: number;

  /**
   * Derinlik - Tüm tanklar için zorunlu (m)
   */
  @Field(() => Float)
  @Column({ type: 'decimal', precision: 10, scale: 2, transformer: new DecimalTransformer() })
  depth: number;

  /**
   * Su derinliği - Gerçek su seviyesi (m)
   */
  @Field(() => Float, { nullable: true })
  @Column({
    type: 'decimal',
    precision: 10,
    scale: 2,
    nullable: true,
    transformer: new DecimalTransformer(),
  })
  waterDepth?: number;

  /**
   * Freeboard - Su yüzeyinden tank kenarına mesafe (m)
   */
  @Field(() => Float, { nullable: true })
  @Column({
    type: 'decimal',
    precision: 10,
    scale: 2,
    nullable: true,
    transformer: new DecimalTransformer(),
  })
  freeboard?: number;

  // -------------------------------------------------------------------------
  // HACİM (Computed - DB trigger veya BeforeInsert/BeforeUpdate ile)
  // -------------------------------------------------------------------------

  /**
   * Toplam hacim (m³) - Otomatik hesaplanır
   */
  @Field(() => Float)
  @Column({ type: 'decimal', precision: 15, scale: 2, transformer: new DecimalTransformer() })
  volume: number;

  /**
   * Su hacmi (m³) - waterDepth'e göre hesaplanır
   */
  @Field(() => Float, { nullable: true })
  @Column({
    type: 'decimal',
    precision: 15,
    scale: 2,
    nullable: true,
    transformer: new DecimalTransformer(),
  })
  waterVolume?: number;

  // -------------------------------------------------------------------------
  // KAPASİTE VE YOĞUNLUK
  // -------------------------------------------------------------------------

  /**
   * Maksimum biomass (kg)
   */
  @Field(() => Float)
  @Column({
    type: 'decimal',
    precision: 15,
    scale: 2,
    default: 0,
    transformer: new DecimalTransformer(),
  })
  maxBiomass: number;

  /**
   * Mevcut biomass (kg) - Batch'lerden hesaplanır
   */
  @Field(() => Float)
  @Column({
    type: 'decimal',
    precision: 15,
    scale: 2,
    default: 0,
    transformer: new DecimalTransformer(),
  })
  currentBiomass: number;

  /**
   * Maksimum yoğunluk (kg/m³)
   */
  @Field(() => Float)
  @Column({
    type: 'decimal',
    precision: 10,
    scale: 2,
    default: 30,
    transformer: new DecimalTransformer(),
  })
  maxDensity: number;

  /**
   * Mevcut adet (batch'lerden)
   */
  @Field(() => Int, { nullable: true })
  @Column({ type: 'int', nullable: true })
  currentCount?: number;

  // -------------------------------------------------------------------------
  // SU AKIŞ ÖZELLİKLERİ
  // -------------------------------------------------------------------------

  @Field(() => GraphQLJSON, { nullable: true })
  @Column({ type: 'jsonb', nullable: true })
  waterFlow?: WaterFlowProperties;

  // -------------------------------------------------------------------------
  // HAVALANDIRMA
  // -------------------------------------------------------------------------

  @Field(() => GraphQLJSON, { nullable: true })
  @Column({ type: 'jsonb', nullable: true })
  aeration?: AerationInfo;

  // -------------------------------------------------------------------------
  // KONUM
  // -------------------------------------------------------------------------

  @Field(() => GraphQLJSON, { nullable: true })
  @Column({ type: 'jsonb', nullable: true })
  location?: TankLocation;

  // -------------------------------------------------------------------------
  // DURUM
  // -------------------------------------------------------------------------

  @Field(() => TankStatus)
  @Column({
    type: 'enum',
    enum: TankStatus,
    default: TankStatus.PREPARING,
  })
  status: TankStatus;

  @Field({ nullable: true })
  @Column({ type: 'timestamptz', nullable: true })
  statusChangedAt?: Date;

  @Field({ nullable: true })
  @Column({ type: 'text', nullable: true })
  statusReason?: string;

  @Field()
  @Column({ default: true })
  @Index()
  isActive: boolean;

  @Field({ nullable: true })
  @Column({ type: 'text', nullable: true })
  notes?: string;

  // -------------------------------------------------------------------------
  // EK BİLGİLER
  // -------------------------------------------------------------------------

  @Field({ nullable: true })
  @Column({ type: 'date', nullable: true })
  installationDate?: Date;

  @Field({ nullable: true })
  @Column({ type: 'date', nullable: true })
  lastMaintenanceDate?: Date;

  @Field({ nullable: true })
  @Column({ type: 'date', nullable: true })
  nextMaintenanceDate?: Date;

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
  // İLİŞKİLER - İleride aktifleştirilecek
  // -------------------------------------------------------------------------
  // @OneToMany(() => BatchLocation, (bl) => bl.tank)
  // batchLocations?: BatchLocation[];

  // -------------------------------------------------------------------------
  // LIFECYCLE HOOKS - Hacim Hesaplama
  // -------------------------------------------------------------------------

  @BeforeInsert()
  @BeforeUpdate()
  calculateVolume(): void {
    const computedVolume = this.computeVolume();
    if (computedVolume > 0) {
      this.volume = computedVolume;
    } else {
      this.volume = Number(this.volume) > 0 ? Number(this.volume) : 0;
    }

    // Water volume hesapla
    if (this.waterDepth) {
      const computedWaterVolume = this.computeWaterVolume();
      this.waterVolume = computedWaterVolume > 0 ? computedWaterVolume : this.volume;
    }
  }

  // -------------------------------------------------------------------------
  // BUSINESS METHODS
  // -------------------------------------------------------------------------

  /**
   * Tank hacmini hesaplar (m³)
   */
  computeVolume(): number {
    const depth = Number(this.depth) || 0;

    switch (this.tankType) {
      case TankType.CIRCULAR: {
        const diameter = Number(this.diameter) || 0;
        // V = π × r² × h
        return Math.PI * Math.pow(diameter / 2, 2) * depth;
      }
      case TankType.OVAL: {
        // Oval tank uses ellipse area: V = π × (length/2) × (width/2) × h
        const ovalLength = Number(this.length) || 0;
        const ovalWidth = Number(this.width) || 0;
        return Math.PI * (ovalLength / 2) * (ovalWidth / 2) * depth;
      }

      case TankType.RECTANGULAR:
      case TankType.SQUARE:
        const length = Number(this.length) || 0;
        const width = Number(this.width) || 0;
        // V = l × w × h
        return length * width * depth;

      case TankType.RACEWAY:
      case TankType.D_END:
        const raceLength = Number(this.length) || 0;
        const raceWidth = Number(this.width) || 0;
        // Basit dikdörtgen hesaplama (D-end için daha doğru hesaplama yapılabilir)
        return raceLength * raceWidth * depth;

      default:
        // Manuel giriş gerekebilir
        return 0;
    }
  }

  /**
   * Su hacmini hesaplar (m³)
   */
  computeWaterVolume(): number {
    if (!this.waterDepth) return this.volume;

    const waterDepth = Number(this.waterDepth) || 0;

    switch (this.tankType) {
      case TankType.CIRCULAR: {
        const diameter = Number(this.diameter) || 0;
        return Math.PI * Math.pow(diameter / 2, 2) * waterDepth;
      }
      case TankType.OVAL: {
        const ovalLength = Number(this.length) || 0;
        const ovalWidth = Number(this.width) || 0;
        return Math.PI * (ovalLength / 2) * (ovalWidth / 2) * waterDepth;
      }

      case TankType.RECTANGULAR:
      case TankType.SQUARE:
      case TankType.RACEWAY:
      case TankType.D_END:
        const length = Number(this.length) || 0;
        const width = Number(this.width) || 0;
        return length * width * waterDepth;

      default:
        return 0;
    }
  }

  /**
   * Mevcut yoğunluğu hesaplar (kg/m³)
   */
  getCurrentDensity(): number {
    const effectiveVolume = this.waterVolume || this.volume;
    if (!effectiveVolume || effectiveVolume === 0) return 0;
    return Number(this.currentBiomass) / effectiveVolume;
  }

  /**
   * Kullanım yüzdesini hesaplar
   */
  getUtilizationPercent(): number {
    if (!this.maxBiomass || this.maxBiomass === 0) return 0;
    return (Number(this.currentBiomass) / Number(this.maxBiomass)) * 100;
  }

  /**
   * Eklenebilecek maksimum biomass'ı hesaplar
   */
  getAvailableCapacity(): number {
    const byBiomass = Number(this.maxBiomass) - Number(this.currentBiomass);

    const effectiveVolume = this.waterVolume || this.volume;
    const byDensity = Number(this.maxDensity) * effectiveVolume - Number(this.currentBiomass);

    return Math.min(byBiomass, byDensity);
  }

  /**
   * Status geçişi valid mi kontrol eder
   */
  canTransitionTo(newStatus: TankStatus): boolean {
    const validTransitions: Record<TankStatus, TankStatus[]> = {
      [TankStatus.INACTIVE]: [TankStatus.PREPARING],
      [TankStatus.PREPARING]: [TankStatus.ACTIVE, TankStatus.INACTIVE],
      [TankStatus.ACTIVE]: [
        TankStatus.HARVESTING,
        TankStatus.MAINTENANCE,
        TankStatus.QUARANTINE,
        TankStatus.FALLOW,
      ],
      [TankStatus.HARVESTING]: [TankStatus.CLEANING],
      [TankStatus.CLEANING]: [TankStatus.PREPARING, TankStatus.MAINTENANCE, TankStatus.FALLOW],
      [TankStatus.MAINTENANCE]: [TankStatus.PREPARING, TankStatus.INACTIVE],
      [TankStatus.FALLOW]: [TankStatus.PREPARING],
      [TankStatus.QUARANTINE]: [TankStatus.ACTIVE, TankStatus.CLEANING],
    };

    return validTransitions[this.status]?.includes(newStatus) ?? false;
  }
}
