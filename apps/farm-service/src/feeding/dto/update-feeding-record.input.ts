import { Type } from 'class-transformer';
import {
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { Field, Float, ID, InputType } from '@nestjs/graphql';

import { FeedingEnvironmentInput, FishBehaviorInput } from './create-feeding-record.input';

@InputType()
export class UpdateFeedingRecordInput {
  @Field(() => ID)
  @IsUUID()
  operationRequestId!: string;

  @Field(() => Float, { nullable: true })
  @IsOptional()
  @IsNumber()
  @Min(0)
  actualAmount?: number;

  @Field(() => Float, { nullable: true })
  @IsOptional()
  @IsNumber()
  @Min(0)
  wasteAmount?: number;

  @Field(() => FeedingEnvironmentInput, { nullable: true })
  @IsOptional()
  @ValidateNested()
  @Type(() => FeedingEnvironmentInput)
  environment?: FeedingEnvironmentInput;

  @Field(() => FishBehaviorInput, { nullable: true })
  @IsOptional()
  @ValidateNested()
  @Type(() => FishBehaviorInput)
  fishBehavior?: FishBehaviorInput;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  notes?: string;

  @Field(() => ID, { nullable: true })
  @IsOptional()
  @IsUUID()
  verifiedBy?: string;
}

@InputType()
export class VerifyFeedingRecordInput {
  @Field(() => ID)
  @IsUUID()
  id!: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  verificationNotes?: string;
}
