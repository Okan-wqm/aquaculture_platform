/**
 * GraphQL surface for server-assembled report drafts (`reportPrefill`).
 */
import { Field, ID, InputType, Int, ObjectType, registerEnumType } from '@nestjs/graphql';
import GraphQLJSON from 'graphql-type-json';
import { IsEnum, IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';

import { ReportPrefillType } from '../assembly/report-assembly.service';
import { ReportFieldProvenance } from '../assembly/provenance.types';

registerEnumType(ReportPrefillType, {
  name: 'ReportPrefillType',
  description: 'Report types that can be server-assembled into a prefilled draft',
});

registerEnumType(ReportFieldProvenance, {
  name: 'ReportFieldProvenance',
  description:
    'Where a prefilled report field came from: aggregated operational records, a sensor projection, or operator input still required',
});

@InputType()
export class ReportPrefillInput {
  @Field(() => ReportPrefillType)
  @IsEnum(ReportPrefillType)
  reportType!: ReportPrefillType;

  @Field(() => ID)
  @IsUUID('4')
  siteId!: string;

  @Field(() => Int)
  @IsInt()
  @Min(2000)
  @Max(2100)
  periodYear!: number;

  @Field(() => Int, { nullable: true, description: 'ISO week (weekly report types)' })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(53)
  periodWeek?: number;

  @Field(() => Int, { nullable: true, description: 'Month 1-12 (monthly report types)' })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(12)
  periodMonth?: number;
}

@ObjectType()
export class ReportFieldMetaOutput {
  @Field({ description: 'JSON pointer into draftPayload, e.g. "/mortality/byCause"' })
  path!: string;

  @Field(() => ReportFieldProvenance)
  provenance!: ReportFieldProvenance;

  @Field(() => Int, { nullable: true, description: 'RECORDS: source rows aggregated' })
  sourceRecordCount?: number;

  @Field({ nullable: true, description: 'RECORDS: query/service that produced the value' })
  sourceQuery?: string;

  @Field({ nullable: true, description: 'SENSOR: sensor identity' })
  sensorId?: string;

  @Field({ nullable: true, description: 'SENSOR: measurement time of the used reading' })
  measuredAt?: Date;

  @Field({ nullable: true, description: 'MANUAL_REQUIRED: actionable reason' })
  message?: string;

  @Field({ description: 'True when schema-required and still MANUAL_REQUIRED' })
  blocking!: boolean;
}

@ObjectType()
export class ReportPrefillOutput {
  @Field(() => ReportPrefillType)
  reportType!: ReportPrefillType;

  @Field(() => ID)
  siteId!: string;

  @Field(() => Int)
  periodYear!: number;

  @Field(() => Int, { nullable: true })
  periodWeek?: number;

  @Field(() => Int, { nullable: true })
  periodMonth?: number;

  @Field(() => GraphQLJSON, { description: 'Assembled draft in the exact report wire shape' })
  draftPayload!: object;

  @Field(() => [ReportFieldMetaOutput])
  fields!: ReportFieldMetaOutput[];

  @Field({ description: 'True when zero blocking fields remain' })
  schemaValid!: boolean;

  @Field()
  assembledAt!: Date;
}
