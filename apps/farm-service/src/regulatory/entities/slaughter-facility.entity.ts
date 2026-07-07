/**
 * Slaughter Facility — the catalog behind the slakt reports'
 * godkjenningsnummer (facility approval number).
 *
 * Replaces the single regulatory_settings.slaughterApprovalNumber field
 * (which supported exactly one facility): tenants slaughtering through
 * multiple facilities pick one per report; the default facility feeds the
 * assembler. The settings field remains a read fallback until Phase 4
 * drops it (dedup: this catalog is the SSoT).
 *
 * Per-tenant table (schema-per-tenant): NO `schema:` (ADR-011).
 */
import { Field, ID, ObjectType } from '@nestjs/graphql';
import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

@ObjectType()
@Entity('slaughter_facilities')
@Index(['tenantId', 'godkjenningsnummer'], { unique: true })
@Index(['tenantId', 'isDefault'])
export class SlaughterFacility {
  @Field(() => ID)
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Field()
  @Column('uuid')
  @Index()
  tenantId!: string;

  @Field()
  @Column({ length: 150 })
  name!: string;

  /** Official approval number (1–6 alphanumeric) keying the slakt reports. */
  @Field()
  @Column({ length: 6 })
  godkjenningsnummer!: string;

  /** The facility the slakt assembler uses when the report names none. */
  @Field()
  @Column({ type: 'boolean', default: false })
  isDefault!: boolean;

  @Field({ nullable: true })
  @Column({ length: 255, nullable: true })
  address?: string;

  @Field()
  @Column({ type: 'boolean', default: true })
  isActive!: boolean;

  @Field()
  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @Field()
  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
