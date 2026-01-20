/**
 * Equipment Entity - Tüm ekipmanlar (tanklar dahil)
 *
 * Hiyerarşi: Tenant -> Site -> System -> SubSystem -> Equipment
 * Ekipmanlar SubSystem'e veya Department'a bağlı olabilir
 *
 * Tank tipi ekipmanlar için specifications JSONB'de tank-specific veriler saklanır:
 * - tankType: 'circular' | 'rectangular' | 'raceway' | ...
 * - dimensions: { diameter?, length?, width?, depth }
 * - volume: m³
 * - maxBiomass: kg
 * - maxDensity: kg/m³
 * - waterType: 'freshwater' | 'saltwater' | 'brackish'
 * - material: 'fiberglass' | 'concrete' | ...
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
  BeforeInsert,
  BeforeUpdate,
} from 'typeorm';
// Note: Department and SubSystem are referenced via string to avoid circular dependency
import { EquipmentType } from './equipment-type.entity';

export enum EquipmentStatus {
  OPERATIONAL = 'operational',       // Çalışır durumda
  MAINTENANCE = 'maintenance',       // Bakımda
  REPAIR = 'repair',                 // Tamirde
  OUT_OF_SERVICE = 'out_of_service', // Hizmet dışı
  DECOMMISSIONED = 'decommissioned', // Kullanımdan kaldırıldı
  STANDBY = 'standby',               // Yedek/Beklemede
  // Tank-specific statuses
  ACTIVE = 'active',                 // Aktif (tank - içinde balık var)
  PREPARING = 'preparing',           // Hazırlanıyor
  CLEANING = 'cleaning',             // Temizleniyor
  HARVESTING = 'harvesting',         // Hasat yapılıyor
  FALLOW = 'fallow',                 // Boş/Dinlendirme
  QUARANTINE = 'quarantine',         // Karantina
}

export interface EquipmentLocation {
  building?: string;
  floor?: string;
  room?: string;
  section?: string;
  row?: number;
  column?: number;
  coordinates?: {
    x: number;
    y: number;
    z?: number;
  };
  notes?: string;
}

export interface MaintenanceSchedule {
  frequency: 'daily' | 'weekly' | 'monthly' | 'quarterly' | 'yearly' | 'custom';
  customDays?: number;
  lastMaintenanceDate?: string;
  nextMaintenanceDate?: string;
  maintenanceNotes?: string;
  checklistItems?: string[];
}

/**
 * Tank-specific specifications
 * EquipmentType.category === 'tank' için kullanılır
 */
export interface TankSpecifications {
  tankType: 'circular' | 'rectangular' | 'raceway' | 'd_end' | 'oval' | 'square' | 'other';
  material: 'fiberglass' | 'concrete' | 'hdpe' | 'steel' | 'stainless_steel' | 'pvc' | 'liner' | 'other';
  waterType: 'freshwater' | 'saltwater' | 'brackish';
  dimensions: {
    diameter?: number;               // m - circular/oval için
    length?: number;                 // m - rectangular/raceway için
    width?: number;                  // m - rectangular/raceway için
    depth: number;                   // m - tüm tipler için zorunlu
    waterDepth?: number;             // m - gerçek su seviyesi
    freeboard?: number;              // m - su yüzeyinden tank kenarına
  };
  volume: number;                    // m³ - hesaplanmış
  waterVolume?: number;              // m³ - gerçek su hacmi
  maxBiomass: number;                // kg
  maxDensity: number;                // kg/m³
  maxCount?: number;                 // maksimum adet
  waterFlow?: {
    flowRate?: number;               // L/dakika veya m³/saat
    flowRateUnit?: 'L/min' | 'm3/h';
    exchangeRate?: number;           // Hacim/saat değişim oranı
    inletCount?: number;
    outletCount?: number;
    drainType?: 'center' | 'side' | 'dual' | 'other';
  };
  aeration?: {
    hasAeration: boolean;
    aerationType?: 'diffuser' | 'paddle_wheel' | 'venturi' | 'blower' | 'other';
    aeratorCount?: number;
    airFlowRate?: number;            // L/dakika
    targetDO?: number;               // mg/L
  };
}

@Entity('equipment')
@Index(['tenantId', 'code'], { unique: true })
@Index(['tenantId', 'departmentId'])
@Index(['tenantId', 'subSystemId'])
@Index(['tenantId', 'status'])
@Index(['tenantId', 'equipmentTypeId'])
@Index(['tenantId', 'isTank'])
@Index(['tenantId', 'isVisibleInSensor'])
export class Equipment {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column('uuid')
  @Index()
  tenantId: string;

  // Ekipman Department'a VEYA SubSystem'e bağlı olabilir
  @Column('uuid', { nullable: true })
  @Index()
  departmentId?: string;

  @ManyToOne('Department', { onDelete: 'CASCADE', nullable: true })
  @JoinColumn({ name: 'departmentId' })
  department?: any;

  @Column('uuid', { nullable: true })
  @Index()
  subSystemId?: string;

  @ManyToOne('SubSystem', { onDelete: 'CASCADE', nullable: true })
  @JoinColumn({ name: 'subSystemId' })
  subSystem?: any;

  // -------------------------------------------------------------------------
  // SYSTEM İLİŞKİSİ (Equipment -> Systems - Many-to-Many via junction table)
  // An equipment can serve multiple systems (e.g., generator, blower)
  // -------------------------------------------------------------------------

  @OneToMany('EquipmentSystem', 'equipment')
  equipmentSystems?: any[];

  // -------------------------------------------------------------------------
  // PARENT EQUIPMENT İLİŞKİSİ (Self-referencing - Equipment hierarchy)
  // -------------------------------------------------------------------------

  @Column('uuid', { nullable: true })
  @Index()
  parentEquipmentId?: string;

  @ManyToOne('Equipment', 'childEquipment', { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'parentEquipmentId' })
  parentEquipment?: Equipment;

  @OneToMany('Equipment', 'parentEquipment')
  childEquipment?: Equipment[];

  // -------------------------------------------------------------------------

  @Column('uuid')
  equipmentTypeId: string;

  @ManyToOne(() => EquipmentType)
  @JoinColumn({ name: 'equipmentTypeId' })
  equipmentType: EquipmentType;

  @Column({ length: 255 })
  name: string;

  @Column({ length: 50 })
  code: string;

  @Column({ type: 'text', nullable: true })
  description?: string;

  @Column({ length: 100, nullable: true })
  manufacturer?: string;

  @Column({ length: 100, nullable: true })
  model?: string;

  @Column({ length: 100, nullable: true })
  @Index()
  serialNumber?: string;

  @Column({ type: 'date', nullable: true })
  purchaseDate?: Date;

  @Column({ type: 'date', nullable: true })
  installationDate?: Date;

  @Column({ type: 'date', nullable: true })
  warrantyEndDate?: Date;

  @Column({ type: 'decimal', precision: 15, scale: 2, nullable: true })
  purchasePrice?: number;

  @Column({ length: 3, default: 'TRY' })
  currency: string;

  @Column({
    type: 'enum',
    enum: EquipmentStatus,
    default: EquipmentStatus.OPERATIONAL,
  })
  status: EquipmentStatus;

  @Column({ type: 'jsonb', nullable: true })
  location?: EquipmentLocation;

  /**
   * Dinamik özellikler - EquipmentType.specificationSchema'ya göre
   * Tank için: TankSpecifications
   * Diğerleri için: Record<string, unknown>
   */
  @Column({ type: 'jsonb', nullable: true })
  specifications?: TankSpecifications | Record<string, unknown>;

  @Column({ type: 'jsonb', nullable: true })
  maintenanceSchedule?: MaintenanceSchedule;

  @Column('uuid', { nullable: true })
  supplierId?: string;

  @Column({ type: 'int', default: 0 })
  subEquipmentCount: number;

  @Column({ type: 'decimal', precision: 10, scale: 2, nullable: true })
  operatingHours?: number;

  @Column({ type: 'text', nullable: true })
  notes?: string;

  // Tank-specific denormalized fields
  @Column({ default: false })
  isTank: boolean;

  // Sensor Module visibility flag
  @Column({ default: false })
  isVisibleInSensor: boolean;

  @Column({ type: 'decimal', precision: 15, scale: 2, nullable: true })
  volume?: number;                   // m³ - tank için

  @Column({ type: 'decimal', precision: 15, scale: 2, nullable: true })
  currentBiomass?: number;           // kg - tank için, batch'lerden hesaplanır

  @Column({ type: 'int', nullable: true })
  currentCount?: number;             // Mevcut adet - tank için

  @Column({ default: true })
  isActive: boolean;

  // Soft delete fields
  @Column({ default: false })
  isDeleted: boolean;

  @Column({ type: 'timestamptz', nullable: true })
  deletedAt?: Date;

  @Column('uuid', { nullable: true })
  deletedBy?: string;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;

  @Column('uuid', { nullable: true })
  createdBy?: string;

  @Column('uuid', { nullable: true })
  updatedBy?: string;

  @VersionColumn()
  version: number;

  // -------------------------------------------------------------------------
  // LIFECYCLE HOOKS
  // -------------------------------------------------------------------------

  @BeforeInsert()
  @BeforeUpdate()
  calculateTankVolume(): void {
    if (this.isTank && this.specifications) {
      const specs = this.specifications as TankSpecifications;
      if (specs.dimensions) {
        this.volume = this.computeVolume(specs);
      }
    }
  }

  // -------------------------------------------------------------------------
  // BUSINESS METHODS (Tank için)
  // -------------------------------------------------------------------------

  /**
   * Tank hacmini hesaplar (m³)
   */
  computeVolume(specs: TankSpecifications): number {
    const depth = specs.dimensions?.depth || 0;

    switch (specs.tankType) {
      case 'circular':
      case 'oval':
        const diameter = specs.dimensions?.diameter || 0;
        return Math.PI * Math.pow(diameter / 2, 2) * depth;

      case 'rectangular':
      case 'square':
        const length = specs.dimensions?.length || 0;
        const width = specs.dimensions?.width || 0;
        return length * width * depth;

      case 'raceway':
      case 'd_end':
        const raceLength = specs.dimensions?.length || 0;
        const raceWidth = specs.dimensions?.width || 0;
        return raceLength * raceWidth * depth;

      default:
        return specs.volume || 0;
    }
  }

  /**
   * Checks if this equipment can hold fish (tank, pond, cage)
   * Considers isTank flag OR presence of tank-like specifications
   */
  canHoldFish(): boolean {
    if (this.isTank) return true;
    // Also check if it has tank-like specifications (for ponds/cages)
    const specs = this.specifications as TankSpecifications;
    return !!(specs?.maxBiomass || specs?.maxDensity || specs?.volume);
  }

  /**
   * Mevcut yoğunluğu hesaplar (kg/m³)
   */
  getCurrentDensity(): number {
    if (!this.canHoldFish()) return 0;
    const effectiveVolume = this.volume || 0;
    if (effectiveVolume === 0) return 0;
    return (this.currentBiomass || 0) / effectiveVolume;
  }

  /**
   * Kullanım yüzdesini hesaplar
   */
  getUtilizationPercent(): number {
    if (!this.canHoldFish()) return 0;
    const specs = this.specifications as TankSpecifications;
    if (!specs?.maxBiomass || specs.maxBiomass === 0) return 0;
    return ((this.currentBiomass || 0) / specs.maxBiomass) * 100;
  }

  /**
   * Kapasiteyi kontrol eder
   */
  hasCapacityFor(biomassToAdd: number): boolean {
    if (!this.canHoldFish()) return false;
    const specs = this.specifications as TankSpecifications;
    const newBiomass = (this.currentBiomass || 0) + biomassToAdd;

    // Biomass limiti kontrolü
    if (newBiomass > (specs?.maxBiomass || 0)) {
      return false;
    }

    // Yoğunluk limiti kontrolü
    const effectiveVolume = this.volume || 0;
    if (effectiveVolume > 0) {
      const newDensity = newBiomass / effectiveVolume;
      if (newDensity > (specs?.maxDensity || 0)) {
        return false;
      }
    }

    return true;
  }

  /**
   * Eklenebilecek maksimum biomass'ı hesaplar
   */
  getAvailableCapacity(): number {
    if (!this.canHoldFish()) return 0;
    const specs = this.specifications as TankSpecifications;
    const byBiomass = (specs?.maxBiomass || 0) - (this.currentBiomass || 0);

    const effectiveVolume = this.volume || 0;
    if (effectiveVolume <= 0) return byBiomass;

    const byDensity = (specs?.maxDensity || 0) * effectiveVolume - (this.currentBiomass || 0);

    return Math.min(byBiomass, byDensity);
  }
}
