/**
 * GraphQL inputs/outputs for the scheduled report-draft review workflow (RPT-003).
 *
 * The draft entity itself (`RegulatoryReportDraft`) is the @ObjectType returned
 * by `reportDrafts` / draft mutations. These add the filter/override inputs and
 * the lighter `ReportDeadlineOutput` the deadline view renders.
 */
import { Field, ID, InputType, Int, ObjectType } from '@nestjs/graphql';
import GraphQLJSON from 'graphql-type-json';
import { IsBoolean, IsIn, IsInt, IsOptional, IsString, IsUUID } from 'class-validator';

import { ReportDraftStatus } from '../entities/regulatory-report-draft.entity';

/**
 * COMPLIANCE-MEDIUM-006 — the SSoT for which report types may carry an
 * auto-submit policy: the five Mattilsynet REST draft types the scheduler
 * rolls over and can transmit unattended. BIOMASS is the manual Altinn
 * channel and the three varsling types (welfare/escape/disease) are
 * immediate manual filings — none of them has an auto-submit draft path, so
 * a policy key for them would be dead configuration at best and a
 * false "will auto-file" affordance at worst. Used by the input validator
 * (API-boundary rejection) AND the service guard (defence in depth).
 */
export const AUTO_SUBMITTABLE_REPORT_TYPES = [
  'SEA_LICE',
  'CLEANER_FISH',
  'SMOLT',
  'SLAUGHTER_PLANNED',
  'SLAUGHTER_EXECUTED',
] as const;

export type AutoSubmittableReportType = (typeof AUTO_SUBMITTABLE_REPORT_TYPES)[number];

@InputType()
export class ReportDraftFilterInput {
  @Field(() => ReportDraftStatus, { nullable: true })
  @IsOptional()
  status?: ReportDraftStatus;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  reportType?: string;

  @Field(() => ID, { nullable: true })
  @IsOptional()
  @IsUUID()
  siteId?: string;
}

@InputType()
export class SaveReportDraftOverridesInput {
  @Field(() => ID)
  @IsUUID()
  draftId!: string;

  /**
   * Operator-supplied values keyed by JSON pointer (the same pointers the
   * field-meta uses). The server accepts a key ONLY when it targets a
   * MANUAL_REQUIRED field — RECORDS/SENSOR values are corrected at the source
   * record, never in the report.
   */
  @Field(() => GraphQLJSON)
  overrides!: Record<string, unknown>;
}

@InputType()
export class UpdateAutoSubmitPolicyInput {
  @Field()
  @IsString()
  @IsIn(AUTO_SUBMITTABLE_REPORT_TYPES, {
    message: `reportType must be one of: ${AUTO_SUBMITTABLE_REPORT_TYPES.join(', ')}`,
  })
  reportType!: string;

  @Field()
  @IsBoolean()
  enabled!: boolean;
}

@ObjectType()
export class ReportDeadlineOutput {
  @Field(() => ID)
  id!: string;

  @Field()
  reportType!: string;

  @Field(() => ID)
  siteId!: string;

  @Field(() => Int)
  periodYear!: number;

  @Field(() => Int, { nullable: true })
  periodWeek?: number;

  @Field(() => Int, { nullable: true })
  periodMonth?: number;

  @Field(() => ReportDraftStatus)
  status!: ReportDraftStatus;

  /** Official deadline (Oslo calendar date, ISO yyyy-mm-dd) — null if unscheduled. */
  @Field({ nullable: true })
  dueAt?: string;

  /** True when the deadline has passed in the Europe/Oslo calendar. */
  @Field()
  overdue!: boolean;

  /** Whole Oslo-calendar days until the deadline (negative when overdue). */
  @Field(() => Int, { nullable: true })
  @IsInt()
  daysUntilDue?: number;
}

@ObjectType()
export class AutoSubmitPolicyEntry {
  @Field()
  reportType!: string;

  @Field()
  enabled!: boolean;
}
