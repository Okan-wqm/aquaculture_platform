/**
 * Per-report-type submission summary — feeds the Reports page header
 * stats and tab badges (FARM-HIGH-125).
 */
import { Field, Int, ObjectType } from '@nestjs/graphql';

import { RegulatoryReportType } from '../entities/regulatory-report.entity';

@ObjectType()
export class RegulatoryReportTypeSummary {
  @Field(() => RegulatoryReportType)
  reportType!: RegulatoryReportType;

  @Field(() => Int)
  pendingCount!: number;

  @Field(() => Int)
  submittedCount!: number;

  @Field(() => Int)
  queuedCount!: number;

  @Field(() => Int)
  failedCount!: number;

  @Field({ nullable: true })
  lastSubmittedAt?: Date;
}
