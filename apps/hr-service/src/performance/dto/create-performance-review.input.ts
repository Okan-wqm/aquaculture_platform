import { InputType, Field } from '@nestjs/graphql';
import {
  IsUUID,
  IsEnum,
  IsDateString,
} from 'class-validator';
import { ReviewPeriodType } from '../entities/performance-review.entity';

@InputType()
export class CreatePerformanceReviewInput {
  @Field()
  @IsUUID()
  employeeId!: string;

  @Field()
  @IsUUID()
  reviewerId!: string;

  @Field(() => ReviewPeriodType)
  @IsEnum(ReviewPeriodType)
  periodType!: ReviewPeriodType;

  @Field()
  @IsDateString()
  periodStart!: string;

  @Field()
  @IsDateString()
  periodEnd!: string;
}
