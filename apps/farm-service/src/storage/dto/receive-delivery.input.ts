import { InputType, Field, Float, ID } from '@nestjs/graphql';
import { IsUUID, IsArray, ValidateNested, IsNumber, Min, IsOptional, IsString } from 'class-validator';
import { Type } from 'class-transformer';

@InputType()
export class ReceiveDeliveryItemInput {
  @Field(() => ID)
  @IsUUID()
  itemId!: string;

  @Field(() => Float)
  @IsNumber()
  @Min(0.01)
  quantityReceived!: number;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  lotNumber?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  expiryDate?: string;
}

@InputType()
export class ReceiveDeliveryInput {
  @Field(() => ID)
  @IsUUID()
  purchaseOrderId!: string;

  @Field(() => ID)
  @IsUUID()
  storageLocationId!: string;

  @Field(() => [ReceiveDeliveryItemInput])
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ReceiveDeliveryItemInput)
  items!: ReceiveDeliveryItemInput[];
}
