/**
 * FeedInventory Entity - Yem Stok Takibi
 *
 * Site/Departman bazında yem stoklarını takip eder.
 * Her stok hareketi (giriş/çıkış) kayıt altına alınır.
 *
 * Özellikler:
 * - Site/Departman bazlı stok
 * - Lot/Parti numarası takibi
 * - Son kullanma tarihi kontrolü
 * - Minimum stok uyarısı
 *
 * @module Feeding
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
} from 'typeorm';
import {
  ObjectType,
  Field,
  ID,
  Float,
  registerEnumType,
} from '@nestjs/graphql';
// Note: Feed, Site, and Department are referenced via string to avoid circular dependency
// Type-only imports for TypeScript type checking
import type { Feed } from '../../feed/entities/feed.entity';
import type { Site } from '../../site/entities/site.entity';
import type { Department } from '../../department/entities/department.entity';

// ============================================================================
// ENUMS
// ============================================================================

/**
 * Stok hareket tipi
 */
export enum InventoryMovementType {
  PURCHASE = 'purchase',             // Satın alma
  CONSUMPTION = 'consumption',       // Tüketim (yemleme)
  TRANSFER_IN = 'transfer_in',       // Transfer giriş
  TRANSFER_OUT = 'transfer_out',     // Transfer çıkış
  ADJUSTMENT = 'adjustment',         // Manuel düzeltme
  WASTE = 'waste',                   // Fire/Kayıp
  RETURN = 'return',                 // İade
  EXPIRED = 'expired',               // Son kullanma tarihi geçmiş
}

registerEnumType(InventoryMovementType, {
  name: 'InventoryMovementType',
  description: 'Stok hareket tipi',
});

/**
 * Stok durumu
 */
export enum InventoryStatus {
  AVAILABLE = 'available',           // Kullanılabilir
  LOW_STOCK = 'low_stock',           // Düşük stok
  OUT_OF_STOCK = 'out_of_stock',     // Stok yok
  EXPIRED = 'expired',               // Süresi geçmiş
  QUARANTINE = 'quarantine',         // Karantinada
}

registerEnumType(InventoryStatus, {
  name: 'InventoryStatus',
  description: 'Stok durumu',
});

// ============================================================================
// ENTITY
// ============================================================================

@ObjectType()
@Entity('feed_inventory')
@Index(['tenantId', 'feedId', 'siteId'])
@Index(['tenantId', 'siteId', 'status'])
@Index(['tenantId', 'lotNumber'])
@Index(['feedId', 'expiryDate'])
export class FeedInventory {
  @Field(() => ID)
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Field()
  @Column('uuid')
  @Index()
  tenantId: string;

  // -------------------------------------------------------------------------
  // FEED İLİŞKİSİ
  // -------------------------------------------------------------------------

  @Field()
  @Column('uuid')
  @Index()
  feedId: string;

  @ManyToOne('Feed', { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'feedId' })
  feed?: Feed;

  // -------------------------------------------------------------------------
  // LOKASYON
  // -------------------------------------------------------------------------

  @Field()
  @Column('uuid')
  @Index()
  siteId: string;

  @ManyToOne('Site', { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'siteId' })
  site?: Site;

  @Field({ nullable: true })
  @Column('uuid', { nullable: true })
  departmentId?: string;

  @ManyToOne('Department', { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'departmentId' })
  department?: Department;

  // -------------------------------------------------------------------------
  // STOK BİLGİLERİ
  // -------------------------------------------------------------------------

  @Field(() => Float)
  @Column({ type: 'decimal', precision: 15, scale: 2, default: 0 })
  quantityKg: number;                    // Mevcut miktar (kg)

  @Field(() => Float)
  @Column({ type: 'decimal', precision: 15, scale: 2, default: 0 })
  minStockKg: number;                    // Minimum stok seviyesi (kg)

  @Field(() => InventoryStatus)
  @Column({
    type: 'enum',
    enum: InventoryStatus,
    default: InventoryStatus.AVAILABLE,
  })
  status: InventoryStatus;

  // -------------------------------------------------------------------------
  // LOT BİLGİLERİ
  // -------------------------------------------------------------------------

  @Field({ nullable: true })
  @Column({ length: 100, nullable: true })
  lotNumber?: string;                    // Parti numarası

  @Field({ nullable: true })
  @Column({ type: 'date', nullable: true })
  manufacturingDate?: Date;              // Üretim tarihi

  @Field({ nullable: true })
  @Column({ type: 'date', nullable: true })
  expiryDate?: Date;                     // Son kullanma tarihi

  @Field({ nullable: true })
  @Column({ type: 'date', nullable: true })
  receivedDate?: Date;                   // Alım tarihi

  // -------------------------------------------------------------------------
  // FİYATLANDIRMA
  // -------------------------------------------------------------------------

  @Field(() => Float, { nullable: true })
  @Column({ type: 'decimal', precision: 15, scale: 2, nullable: true })
  unitPricePerKg?: number;               // kg başına fiyat

  @Field(() => Float, { nullable: true })
  @Column({ type: 'decimal', precision: 15, scale: 2, nullable: true })
  totalValue?: number;                   // Toplam değer

  @Field({ nullable: true })
  @Column({ length: 3, nullable: true })
  currency?: string;

  // -------------------------------------------------------------------------
  // DEPO BİLGİLERİ
  // -------------------------------------------------------------------------

  @Field({ nullable: true })
  @Column({ length: 100, nullable: true })
  storageLocation?: string;              // Depo/Raf konumu

  @Field({ nullable: true })
  @Column({ type: 'decimal', precision: 5, scale: 1, nullable: true })
  storageTemperature?: number;           // Depolama sıcaklığı (°C)

  // -------------------------------------------------------------------------
  // EK BİLGİLER
  // -------------------------------------------------------------------------

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

  // -------------------------------------------------------------------------
  // BUSINESS METHODS
  // -------------------------------------------------------------------------

  /**
   * Stok durumunu günceller
   */
  updateStatus(): void {
    if (this.quantityKg <= 0) {
      this.status = InventoryStatus.OUT_OF_STOCK;
    } else if (this.expiryDate && new Date(this.expiryDate) < new Date()) {
      this.status = InventoryStatus.EXPIRED;
    } else if (this.quantityKg <= this.minStockKg) {
      this.status = InventoryStatus.LOW_STOCK;
    } else {
      this.status = InventoryStatus.AVAILABLE;
    }
  }

  /**
   * Stok düşük mü?
   */
  isLowStock(): boolean {
    return this.quantityKg <= this.minStockKg;
  }

  /**
   * Son kullanma tarihi geçmiş mi?
   */
  isExpired(): boolean {
    if (!this.expiryDate) return false;
    return new Date(this.expiryDate) < new Date();
  }

  /**
   * Son kullanma tarihine kaç gün var?
   */
  getDaysUntilExpiry(): number | null {
    if (!this.expiryDate) return null;
    const now = new Date();
    const expiry = new Date(this.expiryDate);
    const diffTime = expiry.getTime() - now.getTime();
    return Math.ceil(diffTime / (1000 * 60 * 60 * 24));
  }
}
