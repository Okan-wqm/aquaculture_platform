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
export class CreatePlanInput {
  @Field()
  @IsString()
  @MaxLength(100)
  name!: string;

  @Field(() => PlanTier)
  @IsEnum(PlanTier)
  tier!: PlanTier;

  @Field(() => Float)
  @IsNumber()
  @Min(0)
  basePrice!: number;

  @Field({ nullable: true, defaultValue: 'USD' })
  @IsOptional()
  @IsString()
  @MaxLength(3)
  currency?: string;

  @Field(() => BillingCycle, { nullable: true, defaultValue: BillingCycle.MONTHLY })
  @IsOptional()
  @IsEnum(BillingCycle)
  billingCycle?: BillingCycle;

  @Field(() => PlanLimitsInput)
  @ValidateNested()
  @Type(() => PlanLimitsInput)
  limits!: PlanLimitsInput;

  @Field(() => PlanPricingInput)
  @ValidateNested()
  @Type(() => PlanPricingInput)
  pricing!: PlanPricingInput;

  @Field(() => [String], { nullable: true, defaultValue: [] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  features?: string[];

  @Field({ nullable: true, defaultValue: true })
  @IsOptional()
  @IsBoolean()
  isPublic?: boolean;

  @Field(() => Int, { nullable: true, defaultValue: 0 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  sortOrder?: number;
}
