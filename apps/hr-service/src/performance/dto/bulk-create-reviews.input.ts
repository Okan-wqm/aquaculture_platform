import { InputType, Field } from '@nestjs/graphql';
import { IsArray, ValidateNested, ArrayMinSize, ArrayMaxSize } from 'class-validator';
import { Type } from 'class-transformer';
import { CreatePerformanceReviewInput } from './create-performance-review.input';

@InputType()
export class BulkCreateReviewsInput {
  @Field(() => [CreatePerformanceReviewInput])
  @IsArray()
  @ArrayMinSize(1)
  // Cap the batch so a single mutation cannot open an unbounded transaction.
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => CreatePerformanceReviewInput)
  reviews!: CreatePerformanceReviewInput[];
}
