/**
 * ChemicalSite Entity - Kimyasal-Site İlişkisi (N:M)
 *
 * Her kimyasal birden fazla site'da onaylı olabilir.
 * Site bazında onay durumu takip edilir.
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
import { Chemical } from './chemical.entity';
// Note: Site is referenced via string to avoid circular dependency

@ObjectType()
@Entity('chemical_sites')
@Unique(['chemicalId', 'siteId'])
@Index(['tenantId', 'chemicalId'])
@Index(['tenantId', 'siteId'])
export class ChemicalSite {
  @Field(() => ID)
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Field()
  @Column('uuid')
  @Index()
  tenantId: string;

  // -------------------------------------------------------------------------
  // CHEMICAL İLİŞKİSİ
  // -------------------------------------------------------------------------

  @Field()
  @Column('uuid')
  @Index()
  chemicalId: string;

  @ManyToOne(() => Chemical, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'chemicalId' })
  chemical: Chemical;

  // -------------------------------------------------------------------------
  // SITE İLİŞKİSİ
  // -------------------------------------------------------------------------

  @Field()
  @Column('uuid')
  @Index()
  siteId: string;

  @ManyToOne('Site', { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'siteId' })
  site: any;

  // -------------------------------------------------------------------------
  // ONAY DETAYLARI
  // -------------------------------------------------------------------------

  @Field()
  @Column({ default: true })
  isApproved: boolean;

  @Field({ nullable: true })
  @Column('uuid', { nullable: true })
  approvedBy?: string;

  @Field({ nullable: true })
  @Column({ type: 'timestamptz', nullable: true })
  approvedAt?: Date;

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
