/**
 * GraphQL inputs/outputs for the scheduled report-draft review workflow (RPT-003).
 *
 * The draft entity itself (`RegulatoryReportDraft`) is the @ObjectType returned
 * by `reportDrafts` / draft mutations. These add the filter/override inputs and
 * the lighter `ReportDeadlineOutput` the deadline view renders.
 */
import { Field, ID, InputType, Int, ObjectType } from '@nestjs/graphql';
import GraphQLJSON from 'graphql-type-json';
import { IsBoolean, IsInt, IsOptional, IsString, IsUUID } from 'class-validator';

import { ReportDraftStatus } from '../entities/regulatory-report-draft.entity';

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
