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

@InputType()
export class CompetencyRatingInput {
  @Field()
  @IsString()
  competencyId!: string;

  @Field(() => Float)
  @IsNumber()
  @Min(1)
  @Max(5)
  rating!: number;

  @Field({ nullable: true })
  @IsString()
  @IsOptional()
  @MaxLength(1000)
  comments?: string;
}

@InputType()
export class SubmitSelfAssessmentInput {
  @Field()
  @IsUUID()
  reviewId!: string;

  @Field()
  @IsString()
  @MaxLength(5000)
  selfAssessment!: string;

  @Field(() => Float)
  @IsNumber()
  @Min(1)
  @Max(5)
  selfRating!: number;

  @Field(() => [CompetencyRatingInput], { nullable: true })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CompetencyRatingInput)
  @IsOptional()
  competencyRatings?: CompetencyRatingInput[];
}
