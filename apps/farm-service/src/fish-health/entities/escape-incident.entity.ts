/**
 * Escape Incident — the operational record behind the rømming varsling.
 *
 * The escape REPORT (immediate notification to Mattilsynet/Fiskeridirektoratet)
 * previously had nothing to reconcile against: nothing recorded that an escape
 * happened operationally. This entity is that record; the varsling form
 * assembles from it and links back via varslingReportId once submitted.
 *
 * Per-tenant table (schema-per-tenant): NO `schema:` (ADR-011).
 */
import { Field, Float, ID, Int, ObjectType, registerEnumType } from '@nestjs/graphql';
import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { DecimalTransformer } from '@aquaculture/backend-common/database';

export enum EscapeIncidentCause {
  HOLE_IN_NET = 'hole_in_net',
  HANDLING = 'handling',
  PREDATOR = 'predator',
  STRUCTURAL_FAILURE = 'structural_failure',
  OPERATIONAL = 'operational',
  UNKNOWN = 'unknown',
  OTHER = 'other',
}

registerEnumType(EscapeIncidentCause, {
  name: 'EscapeIncidentCause',
  description: 'Operational cause taxonomy for fish escape incidents',
});

export enum EscapeIncidentStatus {
  OPEN = 'open',
  CLOSED = 'closed',
}

registerEnumType(EscapeIncidentStatus, {
  name: 'EscapeIncidentStatus',
  description: 'Lifecycle of an escape incident (recapture may continue while open)',
});

@ObjectType()
@Entity('escape_incidents')
@Index(['tenantId', 'siteId', 'detectedAt'])
@Index(['tenantId', 'status'])
export class EscapeIncident {
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

  @Field(() => ID, { nullable: true })
  @Column('uuid', { nullable: true })
  tankId?: string;

  @Field(() => ID, { nullable: true })
  @Column('uuid', { nullable: true })
  batchId?: string;

  @Field()
  @Column({ type: 'timestamptz' })
  detectedAt!: Date;

  @Field(() => ID)
  @Column('uuid')
  speciesId!: string;

  @Field(() => Int)
  @Column({ type: 'int' })
  estimatedCount!: number;

  @Field(() => Float, { nullable: true })
  @Column({
    type: 'decimal',
    precision: 8,
    scale: 1,
    nullable: true,
    transformer: new DecimalTransformer(),
  })
  avgWeightG?: number;

  @Field(() => EscapeIncidentCause)
  @Column({ type: 'enum', enum: EscapeIncidentCause, default: EscapeIncidentCause.UNKNOWN })
  cause!: EscapeIncidentCause;

  @Field({ nullable: true })
  @Column({ type: 'text', nullable: true })
  causeDetails?: string;

  @Field()
  @Column({ type: 'boolean', default: false })
  recoveryOngoing!: boolean;

  @Field(() => Int, { nullable: true })
  @Column({ type: 'int', nullable: true })
  recoveredCount?: number;

  @Field(() => EscapeIncidentStatus)
  @Column({ type: 'enum', enum: EscapeIncidentStatus, default: EscapeIncidentStatus.OPEN })
  status!: EscapeIncidentStatus;

  /** Set once the varsling report for this incident is submitted. */
  @Field(() => ID, { nullable: true })
  @Column('uuid', { nullable: true })
  varslingReportId?: string;

  @Field(() => ID, { nullable: true })
  @Column('uuid', { nullable: true })
  createdBy?: string;

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
