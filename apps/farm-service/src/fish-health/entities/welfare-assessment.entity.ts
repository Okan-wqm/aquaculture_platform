/**
 * Welfare Assessment — structured fish-welfare scoring (velferdsindikatorer).
 *
 * Replaces free-string symptom arrays for the regulator-relevant indicators:
 * gill health, fin damage, wounds/lesions and deformities, scored 0 (none)
 * to 3 (severe) over a sample of fish. Welfare-event varsling and internal
 * welfare trends consume these records.
 *
 * Per-tenant table (schema-per-tenant): NO `schema:` (ADR-011).
 */
import { Field, ID, Int, ObjectType } from '@nestjs/graphql';
import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

@ObjectType()
@Entity('welfare_assessments')
@Index(['tenantId', 'siteId', 'assessedAt'])
@Index(['tenantId', 'tankId', 'assessedAt'])
export class WelfareAssessment {
  @Field(() => ID)
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Field()
  @Column('uuid')
  @Index()
  tenantId!: string;

  @Field(() => ID)
  @Column('uuid')
  siteId!: string;

  @Field(() => ID)
  @Column('uuid')
  tankId!: string;

  @Field(() => ID, { nullable: true })
  @Column('uuid', { nullable: true })
  batchId?: string;

  @Field()
  @Column({ type: 'date' })
  assessedAt!: string;

  @Field(() => Int)
  @Column({ type: 'int' })
  fishSampled!: number;

  /** 0 (healthy) .. 3 (severe) — gill condition. */
  @Field(() => Int)
  @Column({ type: 'smallint' })
  gillScore!: number;

  /** 0 .. 3 — fin damage/erosion. */
  @Field(() => Int)
  @Column({ type: 'smallint' })
  finScore!: number;

  /** 0 .. 3 — wounds/lesions. */
  @Field(() => Int)
  @Column({ type: 'smallint' })
  woundScore!: number;

  /** 0 .. 3 — skeletal/other deformities. */
  @Field(() => Int)
  @Column({ type: 'smallint' })
  deformityScore!: number;

  @Field(() => ID, { nullable: true })
  @Column('uuid', { nullable: true })
  assessedBy?: string;

  @Field({ nullable: true })
  @Column({ type: 'text', nullable: true })
  notes?: string;

  @Field()
  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @Field()
  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
