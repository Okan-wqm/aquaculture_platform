/**
 * SupplierSite Entity - Tedarikçi-Site İlişkisi (N:M)
 *
 * Her tedarikçi birden fazla site'a hizmet verebilir.
 * Her site birden fazla tedarikçi kullanabilir.
 *
 * Wired in Scope A Phase 4.4.1: the table is created per-tenant by
 * migration `WireSupplierSitesAndSiteContacts1788100000000` and the
 * entity is registered in `SupplierModule.forFeature(...)`. The
 * `approvedSites[]` write surface lands with Phase 4.4.2.
 *
 * @module Farm
 */
import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
  ManyToOne,
  JoinColumn,
  Unique,
} from 'typeorm';
import {
  ObjectType,
  Field,
  ID,
} from '@nestjs/graphql';
import { Supplier } from './supplier.entity';
// Note: Site is referenced via string in decorator to avoid circular dependency
// Type-only import for TypeScript type checking
import type { Site } from '../../site/entities/site.entity';

@ObjectType()
@Entity('supplier_sites')
@Unique(['supplierId', 'siteId'])
@Index(['tenantId', 'supplierId'])
@Index(['tenantId', 'siteId'])
export class SupplierSite {
  @Field(() => ID)
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Field()
  @Column('uuid')
  @Index()
  tenantId!: string;

  // -------------------------------------------------------------------------
  // SUPPLIER İLİŞKİSİ
  // -------------------------------------------------------------------------

  @Field()
  @Column('uuid')
  @Index()
  supplierId!: string;

  @ManyToOne(() => Supplier, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'supplierId' })
  supplier!: Supplier;

  // -------------------------------------------------------------------------
  // SITE İLİŞKİSİ
  // -------------------------------------------------------------------------

  @Field()
  @Column('uuid')
  @Index()
  siteId!: string;

  @ManyToOne('Site', { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'siteId' })
  site?: Site;

  // -------------------------------------------------------------------------
  // İLİŞKİ DETAYLARI
  // -------------------------------------------------------------------------

  @Field()
  @Column({ default: false })
  isPreferred!: boolean;                // Tercih edilen tedarikçi mi?

  /**
   * Free-text note about the supplier-site relationship — e.g. "uses
   * weekend deliveries only", "primary fish-feed supplier per the
   * 2025 procurement contract". Documented in
   * `docs/illustrator/farm-modulu-sema-gorsel.md:1281` as part of the
   * `supplier_sites` row schema.
   */
  @Field({ nullable: true })
  @Column('text', { nullable: true })
  notes?: string;

  // -------------------------------------------------------------------------
  // AUDIT FIELDS
  // -------------------------------------------------------------------------

  @Field()
  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @Field({ nullable: true })
  @Column('uuid', { nullable: true })
  createdBy?: string;
}
