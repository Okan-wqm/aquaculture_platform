import { InputType, Field, Float } from '@nestjs/graphql';
import {
  IsString,
  IsEnum,
  IsOptional,
  IsUUID,
  IsDateString,
  IsNumber,
  ValidateNested,
  Min,
  MaxLength,
  Matches,
} from 'class-validator';
import { Type } from 'class-transformer';
import { PaymentMethod } from '../entities/payment.entity';

@InputType()
export class PaymentMethodDetailsInput {
  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  cardBrand?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  cardLast4?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsNumber()
  cardExpMonth?: number;

  @Field({ nullable: true })
  @IsOptional()
  @IsNumber()
  cardExpYear?: number;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  bankName?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  bankAccountLast4?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  checkNumber?: string;
}

@InputType()
export class RecordPaymentInput {
  @Field()
  @IsUUID()
  invoiceId!: string;

  @Field(() => Float)
  @IsNumber()
  @Min(0.01)
  amount!: number;

  @Field(() => PaymentMethod)
  @IsEnum(PaymentMethod)
  paymentMethod!: PaymentMethod;

  @Field(() => PaymentMethodDetailsInput, { nullable: true })
  @IsOptional()
  @ValidateNested()
  @Type(() => PaymentMethodDetailsInput)
  paymentMethodDetails?: PaymentMethodDetailsInput;

  @Field({ nullable: true })
  @IsOptional()
  @IsDateString()
  paymentDate?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  currency?: string;

  // SECURITY: Validate Stripe ID formats to prevent arbitrary strings from being recorded.
  // Stripe payment intent IDs always start with "pi_" followed by alphanumeric characters.
  // Providing a well-formed Stripe ID does NOT verify payment success — that requires
  // server-side Stripe API verification (future webhook implementation).
  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  @Matches(/^pi_[a-zA-Z0-9]+$/, {
    message: 'stripePaymentIntentId must be a valid Stripe payment intent ID (pi_...)',
  })
  stripePaymentIntentId?: string;

  // Stripe charge IDs always start with "ch_" or "py_" followed by alphanumeric characters.
  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  @Matches(/^(ch_|py_)[a-zA-Z0-9]+$/, {
    message: 'stripeChargeId must be a valid Stripe charge ID (ch_... or py_...)',
  })
  stripeChargeId?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;
}
