import { InputType, Field, Float } from '@nestjs/graphql';
import {
  IsString,
  IsOptional,
  IsUUID,
  IsDateString,
  IsNumber,
  ValidateNested,
  IsArray,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';

@InputType()
export class BillingAddressInput {
  @Field()
  @IsString()
  companyName!: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  attention?: string;

  @Field()
  @IsString()
  street!: string;

  @Field()
  @IsString()
  city!: string;

  @Field()
  @IsString()
  state!: string;

  @Field()
  @IsString()
  postalCode!: string;

  @Field()
  @IsString()
  country!: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  taxId?: string;
}

@InputType()
export class InvoiceLineItemInput {
  @Field()
  @IsString()
  description!: string;

  @Field(() => Float)
  @IsNumber()
  @Min(0)
  quantity!: number;

  @Field(() => Float)
  @IsNumber()
  @Min(0)
  unitPrice!: number;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  productCode?: string;
}

@InputType()
export class TaxInfoInput {
  @Field(() => Float)
  @IsNumber()
  @Min(0)
  taxRate!: number;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  taxId?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  taxName?: string;
}

@InputType()
export class CreateInvoiceInput {
  @Field({ nullable: true })
  @IsOptional()
  @IsUUID()
  subscriptionId?: string;

  @Field(() => BillingAddressInput)
  @ValidateNested()
  @Type(() => BillingAddressInput)
  billingAddress!: BillingAddressInput;

  @Field(() => [InvoiceLineItemInput])
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => InvoiceLineItemInput)
  lineItems!: InvoiceLineItemInput[];

  @Field(() => TaxInfoInput, { nullable: true })
  @IsOptional()
  @ValidateNested()
  @Type(() => TaxInfoInput)
  tax?: TaxInfoInput;

  @Field(() => Float, { nullable: true })
  @IsOptional()
  @IsNumber()
  @Min(0)
  discount?: number;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  discountCode?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  currency?: string;

  @Field()
  @IsDateString()
  dueDate!: string;

  @Field()
  @IsDateString()
  periodStart!: string;

  @Field()
  @IsDateString()
  periodEnd!: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  notes?: string;
}
