import { InputType, Field, Float } from '@nestjs/graphql';
import {
  IsUUID,
  IsString,
  IsNumber,
  IsOptional,
  IsArray,
  ValidateNested,
  MaxLength,
  Min,
  Max,
} from 'class-validator';
import { Type } from 'class-transformer';
import { CompetencyRatingInput } from './submit-self-assessment.input';

@InputType()
export class SubmitManagerAssessmentInput {
  @Field()
  @IsUUID()
  reviewId!: string;

  @Field()
  @IsString()
  @MaxLength(5000)
  managerAssessment!: string;

  @Field(() => Float)
  @IsNumber()
  @Min(1)
  @Max(5)
  managerRating!: number;

  @Field(() => [CompetencyRatingInput], { nullable: true })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CompetencyRatingInput)
  @IsOptional()
  competencyRatings?: CompetencyRatingInput[];

  @Field(() => [String], { nullable: true })
  @IsArray()
  @IsOptional()
  strengths?: string[];

  @Field(() => [String], { nullable: true })
  @IsArray()
  @IsOptional()
  areasForImprovement?: string[];

  @Field({ nullable: true })
  @IsString()
  @IsOptional()
  @MaxLength(5000)
  developmentPlan?: string;
}
