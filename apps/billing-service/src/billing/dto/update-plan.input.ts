import { InputType, Field, Int, Float } from '@nestjs/graphql';
import {
  IsString,
  IsEnum,
  IsOptional,
  IsBoolean,
  IsNumber,
  IsArray,
  ValidateNested,
  Min,
  MaxLength,
} from 'class-validator';
import { Type } from 'class-transformer';
import { BillingCycle, PlanTier } from '../entities/subscription.entity';
import { PlanLimitsInput, PlanPricingInput } from './create-subscription.input';

@InputType()
export class UpdatePlanInput {
  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  name?: string;

  @Field(() => PlanTier, { nullable: true })
  @IsOptional()
  @IsEnum(PlanTier)
  tier?: PlanTier;

  @Field(() => Float, { nullable: true })
  @IsOptional()
  @IsNumber()
  @Min(0)
  basePrice?: number;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(3)
  currency?: string;

  @Field(() => BillingCycle, { nullable: true })
  @IsOptional()
  @IsEnum(BillingCycle)
  billingCycle?: BillingCycle;

  @Field(() => PlanLimitsInput, { nullable: true })
  @IsOptional()
  @ValidateNested()
  @Type(() => PlanLimitsInput)
  limits?: PlanLimitsInput;

  @Field(() => PlanPricingInput, { nullable: true })
  @IsOptional()
  @ValidateNested()
  @Type(() => PlanPricingInput)
  pricing?: PlanPricingInput;

  @Field(() => [String], { nullable: true })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  features?: string[];

  @Field({ nullable: true })
  @IsOptional()
  @IsBoolean()
  isPublic?: boolean;

  @Field(() => Int, { nullable: true })
  @IsOptional()
  @IsNumber()
  @Min(0)
  sortOrder?: number;

  @Field(() => Int)
  @IsNumber()
  expectedVersion!: number;
}
