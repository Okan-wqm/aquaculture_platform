import { InputType, Field, Int, Float } from '@nestjs/graphql';
import {
  IsString,
  IsEnum,
  IsOptional,
  IsBoolean,
  IsDateString,
  IsNumber,
  ValidateNested,
  Min,
  Max,
} from 'class-validator';
import { Type } from 'class-transformer';
import { BillingCycle, PlanTier } from '../entities/subscription.entity';

@InputType()
export class PlanLimitsInput {
  @Field(() => Int)
  @IsNumber()
  @Min(1)
  maxFarms!: number;

  @Field(() => Int)
  @IsNumber()
  @Min(1)
  maxPonds!: number;

  @Field(() => Int)
  @IsNumber()
  @Min(1)
  maxSensors!: number;

  @Field(() => Int)
  @IsNumber()
  @Min(1)
  maxUsers!: number;

  @Field(() => Int)
  @IsNumber()
  @Min(30)
  dataRetentionDays!: number;

  @Field()
  @IsBoolean()
  alertsEnabled!: boolean;

  @Field()
  @IsBoolean()
  reportsEnabled!: boolean;

  @Field()
  @IsBoolean()
  apiAccessEnabled!: boolean;

  @Field()
  @IsBoolean()
  customIntegrationsEnabled!: boolean;
}

@InputType()
export class PlanPricingInput {
  @Field(() => Float)
  @IsNumber()
  @Min(0)
  basePrice!: number;

  @Field(() => Float, { nullable: true })
  @IsOptional()
  @IsNumber()
  @Min(0)
  perFarmPrice?: number;

  @Field(() => Float, { nullable: true })
  @IsOptional()
  @IsNumber()
  @Min(0)
  perSensorPrice?: number;

  @Field(() => Float, { nullable: true })
  @IsOptional()
  @IsNumber()
  @Min(0)
  perUserPrice?: number;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  currency?: string;
}

@InputType()
export class CreateSubscriptionInput {
  @Field(() => PlanTier)
  @IsEnum(PlanTier)
  planTier!: PlanTier;

  @Field()
  @IsString()
  planName!: string;

  @Field(() => BillingCycle)
  @IsEnum(BillingCycle)
  billingCycle!: BillingCycle;

  @Field(() => PlanLimitsInput)
  @ValidateNested()
  @Type(() => PlanLimitsInput)
  limits!: PlanLimitsInput;

  @Field(() => PlanPricingInput)
  @ValidateNested()
  @Type(() => PlanPricingInput)
  pricing!: PlanPricingInput;

  @Field({ nullable: true })
  @IsOptional()
  @IsDateString()
  startDate?: string;

  @Field(() => Int, { nullable: true })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(30)
  trialDays?: number;

  @Field({ nullable: true })
  @IsOptional()
  @IsBoolean()
  autoRenew?: boolean;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  stripeCustomerId?: string;
}
