/**
 * Feed Entity - Yemler
 * Çiftlikte kullanılan balık yemleri ve özellikleri
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
// Note: Supplier is referenced via string to avoid circular dependency

export enum FeedType {
  STARTER = 'starter',       // Başlangıç yemi
  GROWER = 'grower',         // Büyüme yemi
  FINISHER = 'finisher',     // Bitirme yemi
  BROODSTOCK = 'broodstock', // Anaç yemi
  MEDICATED = 'medicated',   // İlaçlı yem
  LARVAL = 'larval',         // Larva yemi
  FRY = 'fry',               // Yavru yemi
  OTHER = 'other',
}

export enum FloatingType {
  FLOATING = 'floating',     // Yüzen
  SINKING = 'sinking',       // Batan
  SLOW_SINKING = 'slow_sinking', // Yavaş batan
}

export enum FeedStatus {
  AVAILABLE = 'available',
  LOW_STOCK = 'low_stock',
  OUT_OF_STOCK = 'out_of_stock',
  EXPIRED = 'expired',
  DISCONTINUED = 'discontinued',
}

export interface NutritionalContent {
  crudeProtein?: number;     // %
  crudeFat?: number;         // %
  crudeFiber?: number;       // %
  crudeAsh?: number;         // %
  moisture?: number;         // %
  energy?: number;           // kcal/kg veya MJ/kg
  energyUnit?: 'kcal' | 'MJ';
  phosphorus?: number;       // %
  calcium?: number;          // %
  omega3?: number;           // %
  omega6?: number;           // %
  lysine?: number;           // %
  methionine?: number;       // %
  vitamins?: Record<string, number>;
  minerals?: Record<string, number>;
  additionalInfo?: Record<string, unknown>;
  // Yeni alanlar
  nfe?: number;              // NFE (Nitrogen-Free Extract) %
  grossEnergy?: number;      // Brüt enerji (MJ)
  digestibleEnergy?: number; // Sindirilebilir enerji (MJ)
}

/**
 * Besleme tablosu - Sıcaklık ve ağırlık bazlı
 */
export interface FeedingTableEntry {
  temperatureMin: number;
  temperatureMax: number;
  temperatureUnit: 'celsius' | 'fahrenheit';
  weightRanges: Array<{
    minWeight: number;
    maxWeight: number;
    weightUnit: 'gram' | 'kg';
    feedPercent: number;        // Vücut ağırlığının yüzdesi
    feedingFrequency: number;   // Günlük öğün sayısı
    notes?: string;
  }>;
}

export interface FeedingTable {
  species: string;
  stage: FeedType;
  entries: FeedingTableEntry[];
  fcr?: number; // Feed Conversion Ratio hedefi
  notes?: string;
}

export interface FeedDocument {
  id: string;
  name: string;
  type: 'datasheet' | 'certificate' | 'label' | 'analysis' | 'other';
  url: string;
  uploadedAt: string;
  uploadedBy: string;
}

/**
 * Çevresel Etki Bilgileri
 */
export interface EnvironmentalImpact {
  co2EqWithLuc?: number;    // CO2-eq with Land Use Change (kg CO2/kg feed)
  co2EqWithoutLuc?: number; // CO2-eq without Land Use Change (kg CO2/kg feed)
}

/**
 * Besleme Eğrisi Noktası (1D - sadece ağırlık bazlı)
 */
export interface FeedingCurvePoint {
  fishWeightG: number;       // Balık ağırlığı (gram)
  feedingRatePercent: number; // Besleme oranı (%BW - Body Weight)
  fcr: number;               // Feed Conversion Ratio
}

/**
 * 2D Besleme Matrisi - Sıcaklık x Ağırlık
 *
 * Bilinear interpolasyon ile ara değerler hesaplanır.
 *
 * Örnek:
 * {
 *   temperatures: [12, 14, 16, 18],  // °C ekseni
 *   weights: [5, 10, 20, 50, 100],   // gram ekseni
 *   rates: [                          // 2D dizi: rates[sıcaklıkIndex][ağırlıkIndex]
 *     [2.5, 2.2, 1.8, 1.4, 1.1],     // 12°C'de
 *     [3.0, 2.6, 2.1, 1.6, 1.2],     // 14°C'de
 *     [3.5, 3.0, 2.4, 1.8, 1.3],     // 16°C'de
 *     [4.0, 3.4, 2.7, 2.0, 1.4],     // 18°C'de
 *   ],
 *   fcrMatrix: [                      // Opsiyonel: FCR değerleri için aynı yapı
 *     [0.8, 0.9, 1.0, 1.1, 1.2],
 *     ...
 *   ]
 * }
 */
export interface FeedingMatrix2D {
  temperatures: number[];        // Sıcaklık ekseni değerleri (°C)
  weights: number[];             // Ağırlık ekseni değerleri (gram)
  rates: number[][];             // 2D dizi: rates[tempIndex][weightIndex] = yemleme oranı %
  fcrMatrix?: number[][];        // Opsiyonel: Her noktadaki FCR değerleri
  temperatureUnit?: 'celsius' | 'fahrenheit';
  weightUnit?: 'gram' | 'kg';
  notes?: string;
}

@Entity('feeds')
@Index(['tenantId', 'code'], { unique: true })
@Index(['tenantId', 'name'], { unique: true })
@Index(['tenantId', 'type'])
@Index(['tenantId', 'status'])
@Index(['tenantId', 'targetSpecies'])
export class Feed {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column('uuid')
  @Index()
  tenantId: string;

  @Column({ length: 255 })
  name: string;

  @Column({ length: 50 })
  code: string;

  @Column({ type: 'text', nullable: true })
  description?: string;

  @Column({ length: 255, nullable: true })
  brand?: string;

  @Column({ length: 100, nullable: true })
  manufacturer?: string;

  @Column('uuid', { nullable: true })
  supplierId?: string;

  @ManyToOne('Supplier', { nullable: true })
  @JoinColumn({ name: 'supplierId' })
  supplier?: any;

  @Column({
    type: 'enum',
    enum: FeedType,
    default: FeedType.GROWER,
  })
  type: FeedType;

  @Column({ length: 100, nullable: true })
  targetSpecies?: string; // Salmon, Trout, Seabass, etc.

  @Column({ type: 'decimal', precision: 5, scale: 2, nullable: true })
  pelletSize?: number; // mm cinsinden

  @Column({
    type: 'enum',
    enum: FloatingType,
    default: FloatingType.FLOATING,
  })
  floatingType: FloatingType;

  @Column({ type: 'jsonb', nullable: true })
  nutritionalContent?: NutritionalContent;

  @Column({ type: 'jsonb', nullable: true })
  feedingTable?: FeedingTable;

  @Column({
    type: 'enum',
    enum: FeedStatus,
    default: FeedStatus.AVAILABLE,
  })
  status: FeedStatus;

  @Column({ type: 'decimal', precision: 15, scale: 2, default: 0 })
  quantity: number; // kg cinsinden stok

  @Column({ type: 'decimal', precision: 15, scale: 2, default: 0 })
  minStock: number;

  @Column({ length: 20, default: 'kg' })
  unit: string;

  @Column({ length: 100, nullable: true })
  storageRequirements?: string;

  @Column({ type: 'int', nullable: true })
  shelfLifeMonths?: number;

  @Column({ type: 'date', nullable: true })
  expiryDate?: Date;

  @Column({ type: 'decimal', precision: 15, scale: 2, nullable: true })
  pricePerKg?: number;

  @Column({ length: 3, default: 'TRY' })
  currency: string;

  @Column({ type: 'jsonb', nullable: true })
  documents?: FeedDocument[];

  @Column({ type: 'text', nullable: true })
  notes?: string;

  // Yeni alanlar - Pelet ve ürün bilgileri
  @Column({ length: 50, nullable: true })
  pelletSizeLabel?: string;  // "2mm", "3-5mm" gibi etiket

  @Column({ length: 100, nullable: true })
  productStage?: string;     // Ürün aşaması

  @Column({ type: 'text', nullable: true })
  composition?: string;      // İçerik/hammaddeler (metin)

  // Yeni alanlar - Fiyatlama
  @Column({ length: 100, nullable: true })
  unitSize?: string;         // "25kg çuval" gibi

  @Column({ type: 'decimal', precision: 15, scale: 2, nullable: true })
  unitPrice?: number;        // Birim fiyat

  // Yeni alanlar - Çevresel etki ve besleme eğrisi
  @Column({ type: 'jsonb', nullable: true })
  environmentalImpact?: EnvironmentalImpact;

  // 1D Besleme Eğrisi (sadece ağırlık bazlı - legacy)
  @Column({ type: 'jsonb', nullable: true })
  feedingCurve?: FeedingCurvePoint[];

  // 2D Besleme Matrisi (sıcaklık x ağırlık)
  @Column({ type: 'jsonb', nullable: true })
  feedingMatrix2D?: FeedingMatrix2D;

  @Column({ default: true })
  isActive: boolean;

  // -------------------------------------------------------------------------
  // SOFT DELETE
  // -------------------------------------------------------------------------

  @Column({ default: false })
  @Index()
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
