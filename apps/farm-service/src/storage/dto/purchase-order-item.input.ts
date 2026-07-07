import { InputType, Field, Float, ID } from '@nestjs/graphql';
import { IsUUID, IsString, IsNumber, IsOptional, Min } from 'class-validator';

@InputType()
export class PurchaseOrderItemInput {
  @Field(() => ID)
  @IsUUID()
  itemId!: string;

  @Field()
  @IsString()
  itemName!: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  itemCode?: string;

  @Field(() => Float)
  @IsNumber()
  @Min(0.01)
  quantity!: number;

  @Field()
  @IsString()
  unit!: string;

  @Field(() => Float, { nullable: true })
  @IsOptional()
  @IsNumber()
  @Min(0)
  unitPrice?: number;
}
