import { InputType, Field } from '@nestjs/graphql';
import { IsString, IsOptional, IsEnum, IsArray, ValidateNested, IsDateString } from 'class-validator';
import { Type } from 'class-transformer';
import { PurchaseOrderCategory } from '../entities/purchase-order.entity';
import { PurchaseOrderItemInput } from './purchase-order-item.input';

@InputType()
export class CreatePurchaseOrderInput {
  @Field(() => PurchaseOrderCategory)
  @IsEnum(PurchaseOrderCategory)
  category: PurchaseOrderCategory;

  @Field()
  @IsString()
  supplierName: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
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
  items: PurchaseOrderItemInput[];
}
