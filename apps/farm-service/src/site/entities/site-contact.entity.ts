/**
 * SiteContact Entity - Site Sorumlu Kişileri
 *
 * Her site birden fazla sorumlu kişiye sahip olabilir.
 * Sadece bir kişi primary (ana irtibat) olabilir.
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
} from 'typeorm';
import {
  ObjectType,
  Field,
  ID,
} from '@nestjs/graphql';
import { Site } from './site.entity';

@ObjectType()
@Entity('site_contacts')
@Index(['tenantId', 'siteId'])
@Index(['siteId', 'isPrimary'])
export class SiteContact {
  @Field(() => ID)
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Field()
  @Column('uuid')
  @Index()
  tenantId: string;

  // -------------------------------------------------------------------------
  // SITE İLİŞKİSİ
  // -------------------------------------------------------------------------

  @Field()
  @Column('uuid')
  @Index()
  siteId: string;

  @ManyToOne(() => Site, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'siteId' })
  site: Site;

  // -------------------------------------------------------------------------
  // KİŞİ BİLGİLERİ
  // -------------------------------------------------------------------------

  @Field()
  @Column({ length: 100 })
  name: string;

  @Field({ nullable: true })
  @Column({ length: 100, nullable: true })
  role?: string;                       // Genel Müdür, Tesis Müdürü, vb.

  @Field({ nullable: true })
  @Column({ length: 150, nullable: true })
  email?: string;

  @Field({ nullable: true })
  @Column({ length: 50, nullable: true })
  phone?: string;

  @Field()
  @Column({ default: false })
  isPrimary: boolean;                  // Ana irtibat kişisi mi?

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
