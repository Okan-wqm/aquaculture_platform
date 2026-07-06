/**
 * RegulatoryReport Entity
 *
 * Persistent record of EVERY regulatory report submission (FARM-HIGH-125).
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

import type { MattilsynetBasePayload } from '../mattilsynet-api.service';
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

/**
 * Failure classification driving the retry pipeline (RPT-018). TRANSIENT
 * failures (5xx / timeout / token) are replayed with exponential backoff;
 * PERMANENT failures (400 / valideringsfeil) are terminal and raise an outbox
 * event for the operator — retrying them would only re-send a rejected report.
 */
export enum RegulatoryFailureClass {
  TRANSIENT = 'TRANSIENT',
  PERMANENT = 'PERMANENT',
}

registerEnumType(RegulatoryFailureClass, {
  name: 'RegulatoryFailureClass',
  description: 'Whether a failed regulatory submission is retryable',
});

// ============================================================================
// PAYLOAD — what was actually recorded per report family (type-only imports)
// ============================================================================

/**
 * The five REST report types persist the EXACT Mattilsynet WIRE payload that
 * was validated and submitted (Norwegian field names, e.g. `sjøtemperatur`) —
 * not the GraphQL input DTO. The record-of-submission therefore records what
 * actually crossed the trust boundary, so the retry sweep can replay the same
 * bytes under the same klientReferanse (RPT-018).
 *
 * Typed as `MattilsynetBasePayload` (the shared header every REST wire payload
 * carries): the interactive resolvers store a concrete subtype (SeaLicePayload,
 * …) and the draft auto-submit path stores a payload assembled dynamically from
 * the draft body + operator overrides. The common base is the honest column
 * type both satisfy, and the official-schema Ajv validation (the brand's sole
 * producer) is the real per-type gate at submit time.
 */
export type RegulatoryRestWirePayload = MattilsynetBasePayload;

/**
 * The three varsling types have no REST wire payload (they are dispatched as
 * urgent e-mail via the outbox), so they persist the submitted GraphQL input.
 */
export type RegulatoryVarslingPayload =
  | SubmitWelfareEventInput
  | SubmitEscapeReportInput
  | SubmitDiseaseOutbreakInput;

export type RegulatoryReportPayload = RegulatoryRestWirePayload | RegulatoryVarslingPayload;

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

  /**
   * Mattilsynet receipt reference (SUBMITTED) or outbox event id (QUEUED).
   * Typed `| null` because a resubmit that re-enters PENDING/QUEUED or FAILED
   * must actively CLEAR a prior receipt (TypeORM skips undefined on save).
   */
  @Field(() => String, { nullable: true })
  @Column('varchar', { length: 255, nullable: true })
  referanse?: string | null;

  /**
   * Error message from Mattilsynet / transport when status = FAILED.
   * Typed `| null` because a successful resubmit must actively CLEAR a
   * previous failure message (TypeORM skips undefined on save).
   */
  @Field(() => String, { nullable: true })
  @Column('text', { nullable: true })
  feilmelding?: string | null;

  @Field()
  @Column('uuid')
  submittedBy: string;

  @Field({ nullable: true })
  @Column('timestamptz', { nullable: true })
  submittedAt?: Date;

  // ==========================================================================
  // Retry pipeline (RPT-018)
  // ==========================================================================

  /** How many submission attempts this row has seen (0 before the first). */
  @Field(() => Int)
  @Column('int', { default: 0 })
  attemptCount: number;

  /** When the retry sweep may next replay a TRANSIENT failure (null = never). */
  @Field({ nullable: true })
  @Column('timestamptz', { nullable: true })
  nextAttemptAt?: Date | null;

  /** TRANSIENT (retryable) vs PERMANENT (terminal) for the latest failure. */
  @Field(() => RegulatoryFailureClass, { nullable: true })
  @Column({
    type: 'enum',
    enum: RegulatoryFailureClass,
    nullable: true,
  })
  failureClass?: RegulatoryFailureClass | null;

  @Field()
  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @Field()
  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
