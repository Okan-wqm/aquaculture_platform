/**
 * Lice Count — the operational record behind the weekly lakselus report.
 *
 * One row per pen (tank) per counting date, carrying the three official
 * counting stages as averages per fish (lakselusforskriften: count every
 * ≤7 days at ≥4°C; 10–20 fish per pen depending on season). The lakselus
 * assembler aggregates these into the report's `lusetelling` — the report
 * consumes records, never free text.
 *
 * Per-tenant table (schema-per-tenant): NO `schema:` — search_path routes it
 * into tenant_<uuid> at runtime (ADR-011).
 */
import { Field, Float, ID, Int, ObjectType } from '@nestjs/graphql';
import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { DecimalTransformer } from '@aquaculture/backend-common/database';

@ObjectType()
@Entity('lice_counts')
@Index(['tenantId', 'tankId', 'countDate'], { unique: true })
@Index(['tenantId', 'siteId', 'reportingYear', 'reportingWeek'])
export class LiceCount {
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

  /** The pen/cage the sample was taken from. */
  @Field(() => ID)
  @Column('uuid')
  tankId!: string;

  @Field(() => ID, { nullable: true })
  @Column('uuid', { nullable: true })
  batchId?: string;

  @Field()
  @Column({ type: 'date' })
  countDate!: string;

  /** ISO year/week derived at write time (SSoT for report aggregation). */
  @Field(() => Int)
  @Column({ type: 'int' })
  reportingYear!: number;

  @Field(() => Int)
  @Column({ type: 'int' })
  reportingWeek!: number;

  /** Adult female lice (voksne hunnlus) — average per sampled fish. */
  @Field(() => Float)
  @Column({ type: 'decimal', precision: 6, scale: 2, transformer: new DecimalTransformer() })
  adultFemaleLice!: number;

  /** Mobile lice (bevegelige lus) — average per sampled fish. */
  @Field(() => Float)
  @Column({ type: 'decimal', precision: 6, scale: 2, transformer: new DecimalTransformer() })
  mobileLice!: number;

  /** Attached lice (fastsittende lus) — average per sampled fish. */
  @Field(() => Float)
  @Column({ type: 'decimal', precision: 6, scale: 2, transformer: new DecimalTransformer() })
  attachedLice!: number;

  /** Fish sampled for this count (regulation: 10 or 20 per pen by season). */
  @Field(() => Int)
  @Column({ type: 'int' })
  fishSampled!: number;

  /** Sea temperature observed at count time, if captured. */
  @Field(() => Float, { nullable: true })
  @Column({
    type: 'decimal',
    precision: 4,
    scale: 1,
    nullable: true,
    transformer: new DecimalTransformer(),
  })
  seaTemperatureC?: number;

  @Field({ nullable: true })
  @Column({ length: 10, nullable: true })
  temperatureSource?: string; // 'sensor' | 'manual'

  @Field(() => ID, { nullable: true })
  @Column('uuid', { nullable: true })
  countedBy?: string;

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
