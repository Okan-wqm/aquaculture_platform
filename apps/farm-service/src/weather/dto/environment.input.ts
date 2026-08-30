import { Field, ID, InputType, Int } from '@nestjs/graphql';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsDate,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  Min,
} from 'class-validator';

import { EnvironmentMetric } from '../entities/environment-observation.types';

@InputType()
export class SiteEnvironmentHistoryInput {
  @Field(() => ID)
  @IsUUID()
  siteId!: string;

  @Field(() => [EnvironmentMetric])
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(12)
  @IsEnum(EnvironmentMetric, { each: true })
  metrics!: EnvironmentMetric[];

  @Field()
  @Type(() => Date)
  @IsDate()
  from!: Date;

  @Field()
  @Type(() => Date)
  @IsDate()
  to!: Date;
}

@InputType()
export class SiteEnvironmentForecastInput {
  @Field(() => ID)
  @IsUUID()
  siteId!: string;

  @Field(() => [EnvironmentMetric])
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(12)
  @IsEnum(EnvironmentMetric, { each: true })
  metrics!: EnvironmentMetric[];

  @Field(() => Int, { defaultValue: 7 })
  @IsInt()
  @Min(1)
  @Max(7)
  days: number = 7;
}

@InputType()
export class EnvironmentScenesInput {
  @Field(() => ID)
  @IsUUID()
  siteId!: string;

  @Field()
  @Type(() => Date)
  @IsDate()
  from!: Date;

  @Field()
  @Type(() => Date)
  @IsDate()
  to!: Date;

  @Field(() => Int, { defaultValue: 50 })
  @IsInt()
  @Min(1)
  @Max(100)
  first: number = 50;

  @Field(() => String, { nullable: true })
  @IsOptional()
  @IsString()
  after?: string;
}
