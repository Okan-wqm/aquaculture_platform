import { InputType, Field, Float, ID } from '@nestjs/graphql';
import { IsNotEmpty, IsString, IsOptional, IsNumber, MaxLength, IsEnum, IsUUID } from 'class-validator';
import { StorageItemType } from '../entities/storage-inventory.entity';

@InputType()
export class TransferStockInput {
  @Field(() => StorageItemType)
  @IsEnum(StorageItemType)
  itemType: StorageItemType;

  @Field(() => ID)
  @IsUUID()
  itemId: string;

  @Field(() => Float)
  @IsNumber()
  quantity: number;

  @Field(() => ID)
  @IsUUID()
  fromLocationId: string;

  @Field(() => ID)
  @IsUUID()
  toLocationId: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  lotNumber?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  reference?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  reason?: string;
}
