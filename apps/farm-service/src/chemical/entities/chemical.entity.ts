/**
 * Chemical Entity - Kimyasallar
 * Çiftlikte kullanılan dezenfektanlar, ilaçlar, su kondisyonerleri vb.
 *
 * N:M ilişki: Bir kimyasal birden fazla site'da onaylı olabilir (chemical_sites)
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
  Float,
  Int,
  registerEnumType,
} from '@nestjs/graphql';
import GraphQLJSON from 'graphql-type-json';
// Note: Supplier is referenced via string to avoid circular dependency
// Type-only import for TypeScript type checking
import type { Supplier } from '../../supplier/entities/supplier.entity';

// ============================================================================
// ENUMS
// ============================================================================

/**
 * Kimyasal tipi
 */
export enum ChemicalType {
  DISINFECTANT = 'disinfectant',         // Dezenfektan
  TREATMENT = 'treatment',               // Tedavi
  WATER_CONDITIONER = 'water_conditioner', // Su kondisyoneri
  ANTIBIOTIC = 'antibiotic',             // Antibiyotik
  ANTIPARASITIC = 'antiparasitic',       // Antiparaziter
  PROBIOTIC = 'probiotic',               // Probiyotik
  VITAMIN = 'vitamin',                    // Vitamin
  MINERAL = 'mineral',                    // Mineral
  ANESTHETIC = 'anesthetic',             // Anestezik
  pH_ADJUSTER = 'ph_adjuster',           // pH ayarlayıcı
  ALGAECIDE = 'algaecide',               // Yosun öldürücü
  OTHER = 'other',
}

registerEnumType(ChemicalType, {
  name: 'ChemicalType',
  description: 'Kimyasal tipi',
});

/**
 * Kimyasal durumu
 */
export enum ChemicalStatus {
  AVAILABLE = 'available',
  LOW_STOCK = 'low_stock',
  OUT_OF_STOCK = 'out_of_stock',
  EXPIRED = 'expired',
  DISCONTINUED = 'discontinued',
}

registerEnumType(ChemicalStatus, {
  name: 'ChemicalStatus',
  description: 'Kimyasal durumu',
});

// ============================================================================
// INTERFACES
// ============================================================================

export interface UsageProtocol {
  dosage: string;
  applicationMethod: string;
  frequency?: string;
  duration?: string;
  withdrawalPeriod?: number; // Gün cinsinden
  targetSpecies?: string[];
  targetConditions?: string[];
  contraindications?: string[];
  precautions?: string[];
  notes?: string;
}

export interface SafetyInfo {
  hazardClass?: string;
  signalWord?: string; // Warning, Danger
  hazardStatements?: string[];
  precautionaryStatements?: string[];
  firstAid?: {
    inhalation?: string;
    skinContact?: string;
    eyeContact?: string;
    ingestion?: string;
  };
  storageConditions?: string;
  disposalMethod?: string;
  msdsUrl?: string;
}

export interface ChemicalDocument {
  id: string;
  name: string;
  type: 'msds' | 'label' | 'protocol' | 'certificate' | 'other';
  url: string;
  uploadedAt: string;
  uploadedBy: string;
}

// ============================================================================
// ENTITY
// ============================================================================

@ObjectType()
@Entity('chemicals')
@Index(['tenantId', 'code'], { unique: true })
@Index(['tenantId', 'name'], { unique: true })
@Index(['tenantId', 'type'])
@Index(['tenantId', 'status'])
@Index(['tenantId', 'isActive'])
export class Chemical {
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
  code: string;

  @Field({ nullable: true })
  @Column({ type: 'text', nullable: true })
  description?: string;

  @Field(() => ChemicalType)
  @Column({
    type: 'enum',
    enum: ChemicalType,
    default: ChemicalType.OTHER,
  })
  type: ChemicalType;

  @Field({ nullable: true })
  @Column({ length: 255, nullable: true })
  brand?: string;

  @Field({ nullable: true })
  @Column({ length: 255, nullable: true })
  activeIngredient?: string;

  @Field({ nullable: true })
  @Column({ length: 100, nullable: true })
  concentration?: string; // "10%", "50 mg/L" gibi

  @Field({ nullable: true })
  @Column({ length: 100, nullable: true })
  formulation?: string; // Liquid, Powder, Tablet, etc.

  // -------------------------------------------------------------------------
  // TEDARİKÇİ İLİŞKİSİ
  // -------------------------------------------------------------------------

  @Field({ nullable: true })
  @Column('uuid', { nullable: true })
  @Index()
  supplierId?: string;

  @ManyToOne('Supplier', { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'supplierId' })
  supplier?: Supplier;

  // -------------------------------------------------------------------------
  // STOK BİLGİLERİ
  // -------------------------------------------------------------------------

  @Field(() => ChemicalStatus)
  @Column({
    type: 'enum',
    enum: ChemicalStatus,
    default: ChemicalStatus.AVAILABLE,
  })
  status: ChemicalStatus;

  @Field(() => Float)
  @Column({ type: 'decimal', precision: 15, scale: 4, default: 0 })
  quantity: number;

  @Field(() => Float)
  @Column({ type: 'decimal', precision: 15, scale: 4, default: 0 })
  minStock: number;

  @Field()
  @Column({ length: 20, default: 'liter' })
  unit: string; // liter, kg, gram, ml, piece

  // -------------------------------------------------------------------------
  // GÜVENLİK & KULLANIM
  // -------------------------------------------------------------------------

  /**
   * Kullanım için onay gerekli mi?
   * Bazı kimyasallar (antibiyotikler, tehlikeli maddeler) onay gerektirebilir
   */
  @Field()
  @Column({ default: false })
  requiresApproval: boolean;

  /**
   * Arındırma süresi (gün)
   * Hasattan önce beklenecek süre
   */
  @Field(() => Int, { nullable: true })
  @Column({ type: 'int', nullable: true })
  withdrawalPeriodDays?: number;

  @Field(() => GraphQLJSON, { nullable: true })
  @Column({ type: 'jsonb', nullable: true })
  usageProtocol?: UsageProtocol;

  @Field(() => GraphQLJSON, { nullable: true })
  @Column({ type: 'jsonb', nullable: true })
  safetyInfo?: SafetyInfo;

  @Field({ nullable: true })
  @Column({ length: 100, nullable: true })
  storageRequirements?: string;

  @Field(() => Int, { nullable: true })
  @Column({ type: 'int', nullable: true })
  shelfLifeMonths?: number;

  @Field({ nullable: true })
  @Column({ type: 'date', nullable: true })
  expiryDate?: Date;

  @Field(() => [String], { nullable: true })
  @Column({ type: 'simple-array', nullable: true })
  usageAreas?: string[]; // Department codes veya equipment type codes

  @Field(() => GraphQLJSON, { nullable: true })
  @Column({ type: 'jsonb', nullable: true })
  documents?: ChemicalDocument[];

  // -------------------------------------------------------------------------
  // FİYATLANDIRMA
  // -------------------------------------------------------------------------

  @Field(() => Float, { nullable: true })
  @Column({ type: 'decimal', precision: 15, scale: 2, nullable: true })
  unitPrice?: number;

  @Field()
  @Column({ length: 3, default: 'TRY' })
  currency: string;

  // -------------------------------------------------------------------------
  // DURUM
  // -------------------------------------------------------------------------

  @Field({ nullable: true })
  @Column({ type: 'text', nullable: true })
  notes?: string;

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

  // @OneToMany(() => ChemicalSite, (cs) => cs.chemical)
  // chemicalSites?: ChemicalSite[];

  // -------------------------------------------------------------------------
  // BUSINESS METHODS
  // -------------------------------------------------------------------------

  /**
   * Arındırma süresi kontrolü
   * Hasata uygun olup olmadığını kontrol eder
   */
  isWithdrawalPeriodComplete(lastApplicationDate: Date): boolean {
    if (!this.withdrawalPeriodDays) return true;
    const now = new Date();
    const daysSinceApplication = Math.floor(
      (now.getTime() - lastApplicationDate.getTime()) / (1000 * 60 * 60 * 24)
    );
    return daysSinceApplication >= this.withdrawalPeriodDays;
  }

  /**
   * Stok durumunu güncelle
   */
  updateStockStatus(): void {
    if (this.quantity <= 0) {
      this.status = ChemicalStatus.OUT_OF_STOCK;
    } else if (this.quantity <= this.minStock) {
      this.status = ChemicalStatus.LOW_STOCK;
    } else {
      this.status = ChemicalStatus.AVAILABLE;
    }
  }

  /**
   * Son kullanma tarihi geçmiş mi?
   */
  isExpired(): boolean {
    if (!this.expiryDate) return false;
    return new Date() > this.expiryDate;
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
