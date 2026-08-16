import { InputType, Field, Float, ID } from '@nestjs/graphql';
import {
  ArrayMinSize,
  IsArray,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

@InputType()
export class ReceiveDeliveryItemInput {
  @Field(() => ID)
  @IsUUID()
  purchaseOrderItemId!: string;

  @Field(() => Float)
  @IsNumber()
  @Min(0.01)
  quantityReceived!: number;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @Matches(/\S/u, { message: 'lotNumber must contain a non-whitespace character' })
  lotNumber?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/u, { message: 'expiryDate must use YYYY-MM-DD' })
  expiryDate?: string;
}

@InputType()
export class ReceiveDeliveryInput {
  /**
   * Caller-generated immutable receipt identity. The same value MUST be
   * reused for a transport retry and MUST NOT be reused for a new delivery.
   */
  @Field(() => ID)
  @IsUUID()
  operationId!: string;

  @Field(() => ID)
  @IsUUID()
  purchaseOrderId!: string;

  @Field(() => ID)
  @IsUUID()
  storageLocationId!: string;

  @Field(() => [ReceiveDeliveryItemInput])
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => ReceiveDeliveryItemInput)
  items!: ReceiveDeliveryItemInput[];
}
