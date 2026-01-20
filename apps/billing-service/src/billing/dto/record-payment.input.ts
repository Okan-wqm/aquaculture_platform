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

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  stripePaymentIntentId?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  stripeChargeId?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  notes?: string;
}
