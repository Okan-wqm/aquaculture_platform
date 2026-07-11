import { InputType, Field } from '@nestjs/graphql';
import { IsString, IsOptional, IsEnum, IsArray, ValidateNested, IsDateString, MaxLength } from 'class-validator';
import { Type } from 'class-transformer';
import { PurchaseOrderCategory } from '../entities/purchase-order.entity';
import { PurchaseOrderItemInput } from './purchase-order-item.input';

@InputType()
export class CreatePurchaseOrderInput {
  @Field(() => PurchaseOrderCategory)
  @IsEnum(PurchaseOrderCategory)
  category!: PurchaseOrderCategory;

  /**
   * Supplier company name. MaxLength(500) prevents unbounded input that could
   * cause column overflow or bloated indexes. The 500-char limit accommodates
   * long legal entity names common in international aquaculture supply chains
   * (e.g., "Shanghai Tongwei Feed Technology Co., Ltd. — Aquatic Division").
   */
  @Field()
  @IsString()
  @MaxLength(500)
  supplierName!: string;

  /**
   * Supplier contact information (phone, email, or person name). MaxLength(500)
   * prevents unbounded input while accommodating multi-line contact details
   * that procurement teams commonly paste from supplier directories.
   */
  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  supplierContact?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsDateString()
  expectedDeliveryDate?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  notes?: string;

  @Field(() => [PurchaseOrderItemInput])
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => PurchaseOrderItemInput)
  items!: PurchaseOrderItemInput[];
}
