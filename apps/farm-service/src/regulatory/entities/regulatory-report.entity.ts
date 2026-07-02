/**
 * RegulatoryReport Entity
 *
 * Persistent record of EVERY regulatory report submission (FARM-HIGH-112).
 * Before this table existed the seven Mattilsynet report types (sea lice,
 * cleaner fish, smolt, planned/executed slaughter, welfare event, escape,
 * disease outbreak) were fired at the regulator without any local record —
 * the frontend report-history tabs rendered mock data because there was
 * nothing real to list.
 *
 * Storage strategy (same shape decision as biomass-report.entity.ts):
 *   - Fixed columns carry routing + lifecycle (tenantId, reportType,
 *     klientReferanse, siteId, lokalitetsnummer, period, status,
 *     submission bookkeeping) — everything list/summary queries touch.
 *   - The full submitted form lives in a JSONB column typed as the union
 *     of the submit input DTO shapes (type-only imports — no runtime
 *     class-validator coupling in the persistence layer). The payload
 *     type therefore IS the submit contract and cannot drift from it.
 *
 * Lifecycle:
 *   - Five REST report types: PENDING (persisted before the Mattilsynet
 *     call) → SUBMITTED (+ referanse) or FAILED (+ feilmelding). A crash
 *     between persist and submit leaves an honest PENDING row; retrying
 *     with the same klientReferanse updates that row (klientReferanse is
 *     Mattilsynet's own idempotency key).
 *   - Three varsling types: QUEUED, written atomically with the outbox
 *     enqueue that carries the urgent notification e-mail event.
 *
 * Uniqueness: (tenantId, reportType, klientReferanse) — a resubmit is an
 * update of the same row, never a duplicate.
 */
import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  Unique,
  UpdateDateColumn,
} from 'typeorm';
import { Field, ID, Int, ObjectType, registerEnumType } from '@nestjs/graphql';
import GraphQLJSON from 'graphql-type-json';

import type {
  SubmitCleanerFishReportInput,
  SubmitExecutedSlaughterInput,
  SubmitPlannedSlaughterInput,
  SubmitSeaLiceReportInput,
  SubmitSmoltReportInput,
} from '../dto/regulatory-inputs.dto';
import type {
  SubmitDiseaseOutbreakInput,
  SubmitEscapeReportInput,
  SubmitWelfareEventInput,
} from '../dto/regulatory-varsling-inputs.dto';

// ============================================================================
// ENUMS
// ============================================================================

export enum RegulatoryReportType {
  SEA_LICE = 'SEA_LICE',
  CLEANER_FISH = 'CLEANER_FISH',
  SMOLT = 'SMOLT',
  SLAUGHTER_PLANNED = 'SLAUGHTER_PLANNED',
  SLAUGHTER_EXECUTED = 'SLAUGHTER_EXECUTED',
  WELFARE_EVENT = 'WELFARE_EVENT',
  ESCAPE = 'ESCAPE',
  DISEASE_OUTBREAK = 'DISEASE_OUTBREAK',
}

registerEnumType(RegulatoryReportType, {
  name: 'RegulatoryReportType',
  description: 'Which Mattilsynet report a persisted submission row records',
});

export enum RegulatoryReportSubmissionStatus {
  /** Row persisted; the synchronous Mattilsynet REST call has not completed. */
  PENDING = 'PENDING',
  /** Mattilsynet accepted the submission (referanse populated). */
  SUBMITTED = 'SUBMITTED',
  /** Varsling report committed atomically with its outbox notification event. */
  QUEUED = 'QUEUED',
  /** Mattilsynet rejected the submission or the call failed (feilmelding populated). */
  FAILED = 'FAILED',
}

registerEnumType(RegulatoryReportSubmissionStatus, {
  name: 'RegulatoryReportSubmissionStatus',
  description: 'Lifecycle of a persisted regulatory report submission',
});

// ============================================================================
// PAYLOAD — the union of the submit input shapes (type-only imports)
// ============================================================================

export type RegulatoryReportPayload =
  | SubmitSeaLiceReportInput
  | SubmitCleanerFishReportInput
  | SubmitSmoltReportInput
  | SubmitPlannedSlaughterInput
  | SubmitExecutedSlaughterInput
  | SubmitWelfareEventInput
  | SubmitEscapeReportInput
  | SubmitDiseaseOutbreakInput;

// ============================================================================
// ENTITY
// ============================================================================

@ObjectType()
@Entity('regulatory_reports')
@Unique('UQ_regulatory_report_client_ref', ['tenantId', 'reportType', 'klientReferanse'])
@Index('idx_regulatory_reports_tenant_type_year', ['tenantId', 'reportType', 'reportYear'])
@Index('idx_regulatory_reports_tenant_status', ['tenantId', 'status'])
@Index('idx_regulatory_reports_tenant_site', ['tenantId', 'siteId'])
export class RegulatoryReport {
  @Field(() => ID)
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Field()
  @Column('uuid')
  @Index()
  tenantId: string;

  @Field(() => RegulatoryReportType)
  @Column({
    type: 'enum',
    enum: RegulatoryReportType,
    enumName: 'regulatory_reports_type_enum',
  })
  reportType: RegulatoryReportType;

  /** Client reference — the operator-facing idempotency key echoed to Mattilsynet. */
  @Field()
  @Column('varchar', { length: 128 })
  klientReferanse: string;

  /** Internal site the locality maps to; nullable when no mapping resolves. */
  @Field({ nullable: true })
  @Column('uuid', { nullable: true })
  siteId?: string;

  @Field(() => Int)
  @Column('int')
  lokalitetsnummer: number;

  /** Reporting period — which columns apply depends on reportType. */
  @Field(() => Int, { nullable: true })
  @Column('int', { nullable: true })
  reportYear?: number;

  @Field(() => Int, { nullable: true })
  @Column('int', { nullable: true })
  reportWeek?: number;

  @Field(() => Int, { nullable: true })
  @Column('int', { nullable: true })
  reportMonth?: number;

  @Field(() => RegulatoryReportSubmissionStatus)
  @Column({
    type: 'enum',
    enum: RegulatoryReportSubmissionStatus,
    enumName: 'regulatory_reports_status_enum',
    default: RegulatoryReportSubmissionStatus.PENDING,
  })
  status: RegulatoryReportSubmissionStatus;

  /**
   * Full submitted form snapshot. Typed as the union of the submit input
   * DTO shapes at the TypeScript layer; stored as JSONB.
   */
  @Field(() => GraphQLJSON)
  @Column('jsonb')
  payload: RegulatoryReportPayload;

  /** Mattilsynet receipt reference (SUBMITTED) or outbox event id (QUEUED). */
  @Field({ nullable: true })
  @Column('varchar', { length: 255, nullable: true })
  referanse?: string;

  /**
   * Error message from Mattilsynet / transport when status = FAILED.
   * Typed `| null` because a successful resubmit must actively CLEAR a
   * previous failure message (TypeORM skips undefined on save).
   */
  @Field({ nullable: true })
  @Column('text', { nullable: true })
  feilmelding?: string | null;

  @Field()
  @Column('uuid')
  submittedBy: string;

  @Field({ nullable: true })
  @Column('timestamptz', { nullable: true })
  submittedAt?: Date;

  @Field()
  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @Field()
  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
