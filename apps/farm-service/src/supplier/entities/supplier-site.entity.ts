/**
 * SupplierSite Entity - Tedarikçi-Site İlişkisi (N:M)
 *
 * Her tedarikçi birden fazla site'a hizmet verebilir.
 * Her site birden fazla tedarikçi kullanabilir.
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
  id: string;

  @Field()
  @Column('uuid')
  @Index()
  tenantId: string;

  // -------------------------------------------------------------------------
  // SUPPLIER İLİŞKİSİ
  // -------------------------------------------------------------------------

  @Field()
  @Column('uuid')
  @Index()
  supplierId: string;

  @ManyToOne(() => Supplier, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'supplierId' })
  supplier: Supplier;

  // -------------------------------------------------------------------------
  // SITE İLİŞKİSİ
  // -------------------------------------------------------------------------

  @Field()
  @Column('uuid')
  @Index()
  siteId: string;

  @ManyToOne('Site', { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'siteId' })
  site?: Site;

  // -------------------------------------------------------------------------
  // İLİŞKİ DETAYLARI
  // -------------------------------------------------------------------------

  @Field()
  @Column({ default: false })
  isPreferred: boolean;                // Tercih edilen tedarikçi mi?

  // -------------------------------------------------------------------------
  // AUDIT FIELDS
  // -------------------------------------------------------------------------

  @Field()
  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @Field({ nullable: true })
  @Column('uuid', { nullable: true })
  createdBy?: string;
}
