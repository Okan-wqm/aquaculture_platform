import { InputType, Field, Float } from '@nestjs/graphql';
import {
  IsString,
  IsOptional,
  IsUUID,
  IsNumber,
  Min,
  MaxLength,
  Matches,
} from 'class-validator';

@InputType()
export class RefundPaymentInput {
  @Field()
  @IsUUID()
  paymentId!: string;

  @Field(() => Float)
  @IsNumber()
  @Min(0.01)
  amount!: number;

  @Field()
  @IsString()
  @MaxLength(1000)
  reason!: string;

  /**
   * Optional Stripe refund ID (from Stripe webhook).
   * Stripe refund IDs always start with "re_" followed by alphanumeric characters.
   */
  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  @Matches(/^re_[a-zA-Z0-9]+$/, {
    message: 'refundId must be a valid Stripe refund ID (re_...)',
  })
  refundId?: string;
}
