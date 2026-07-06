/**
 * Regulatory Report Draft — the scheduler's unit of work (RPT-003).
 *
 * On each period rollover the scheduler assembles a draft per (site, report
 * type, period) and upserts a row here; the operator reviews it, supplies any
 * blocking MANUAL_REQUIRED fields as `manualOverrides`, and approves it for
 * submission. `submittedReportId` links to the `regulatory_reports` row once
 * transmitted (the persisted submission receipt).
 *
 * One draft per (tenant, reportType, site, period) — enforced by a partial
 * unique expression index in the migration (COALESCE on the nullable week/month
 * so the two period grains share one constraint). Rollover is idempotent
 * (INSERT … ON CONFLICT DO NOTHING).
 *
 * Per-tenant table (schema-per-tenant): NO `schema:` (ADR-011).
 */
import { Field, ID, Int, ObjectType, registerEnumType } from '@nestjs/graphql';
import GraphQLJSON from 'graphql-type-json';
import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

import type { ReportFieldMeta } from '../assembly/provenance.types';

/**
 * Draft lifecycle. DRAFT → READY (zero blocking fields) → APPROVED → SUBMITTED
 * (terminal); DISMISSED is the operator opt-out (terminal). READY↔DRAFT flips
 * as the assembled payload gains/loses blocking fields on re-assembly.
 */
export enum ReportDraftStatus {
  DRAFT = 'draft',
  READY = 'ready',
  APPROVED = 'approved',
  SUBMITTED = 'submitted',
  DISMISSED = 'dismissed',
}

registerEnumType(ReportDraftStatus, {
  name: 'ReportDraftStatus',
  description: 'Lifecycle of a scheduled regulatory report draft',
});

@ObjectType()
@Entity('regulatory_report_drafts')
@Index(['tenantId', 'status'])
@Index(['tenantId', 'reportType', 'siteId'])
export class RegulatoryReportDraft {
  @Field(() => ID)
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Field()
  @Column('uuid')
  @Index()
  tenantId!: string;

  /** ReportPrefillType value (SEA_LICE, SMOLT, …). */
  @Field()
  @Column({ length: 40 })
  reportType!: string;

  @Field(() => ID)
  @Column('uuid')
  siteId!: string;

  @Field(() => Int)
  @Column({ type: 'int' })
  periodYear!: number;

  @Field(() => Int, { nullable: true })
  @Column({ type: 'int', nullable: true })
  periodWeek?: number;

  @Field(() => Int, { nullable: true })
  @Column({ type: 'int', nullable: true })
  periodMonth?: number;

  @Field(() => ReportDraftStatus)
  @Column({ type: 'enum', enum: ReportDraftStatus, default: ReportDraftStatus.DRAFT })
  status!: ReportDraftStatus;

  /** Server-assembled wire payload (the exact Mattilsynet shape). */
  @Field(() => GraphQLJSON)
  @Column({ type: 'jsonb' })
  assembledPayload!: Record<string, unknown>;

  /** Per-field provenance (ReportFieldMeta[]) — what is RECORDS vs MANUAL. */
  @Field(() => GraphQLJSON)
  @Column({ type: 'jsonb' })
  fieldMeta!: ReportFieldMeta[];

  /** Operator-supplied values for the blocking MANUAL_REQUIRED JSON pointers. */
  @Field(() => GraphQLJSON, { nullable: true })
  @Column({ type: 'jsonb', nullable: true })
  manualOverrides?: Record<string, unknown>;

  /** True when zero blocking fields remain (submission-ready). */
  @Field()
  @Column({ type: 'boolean', default: false })
  schemaValid!: boolean;

  /** Official submission deadline (Oslo calendar date). */
  @Field({ nullable: true })
  @Column({ type: 'date', nullable: true })
  dueAt?: string;

  @Field()
  @Column({ type: 'timestamptz' })
  assembledAt!: Date;

  /** Set once the draft is transmitted — links to regulatory_reports.id. */
  @Field(() => ID, { nullable: true })
  @Column('uuid', { nullable: true })
  submittedReportId?: string;

  /**
   * Last deadline bucket an outbox reminder was raised for (RPT-003) — the
   * sweep enqueues a RegulatoryReportDeadlineApproachingEvent only when the
   * computed bucket differs, so a reminder fires once per bucket transition.
   */
  @Field({ nullable: true })
  @Column({ type: 'varchar', length: 16, nullable: true })
  deadlineNotifiedBucket?: string | null;

  @Field(() => ID, { nullable: true })
  @Column('uuid', { nullable: true })
  approvedBy?: string;

  @Field({ nullable: true })
  @Column({ type: 'timestamptz', nullable: true })
  approvedAt?: Date;

  @Field()
  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @Field()
  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
