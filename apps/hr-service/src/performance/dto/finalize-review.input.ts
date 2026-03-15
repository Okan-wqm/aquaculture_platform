import { InputType, Field, Float } from '@nestjs/graphql';
import {
  IsUUID,
  IsString,
  IsNumber,
  IsOptional,
  MaxLength,
  Min,
  Max,
} from 'class-validator';

@InputType()
export class FinalizeReviewInput {
  @Field()
  @IsUUID()
  reviewId!: string;

  @Field(() => Float)
  @IsNumber()
  @Min(1)
  @Max(5)
  finalRating!: number;

  @Field({ nullable: true })
  @IsString()
  @IsOptional()
  @MaxLength(2000)
  calibrationNotes?: string;

  @Field({ nullable: true })
  @IsString()
  @IsOptional()
  @MaxLength(2000)
  reviewerComments?: string;
}
