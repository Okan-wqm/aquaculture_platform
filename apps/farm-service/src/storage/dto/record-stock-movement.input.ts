import { InputType, Field, Float, ID } from '@nestjs/graphql';
import { IsNotEmpty, IsString, IsOptional, IsNumber, MaxLength, IsEnum, IsUUID } from 'class-validator';
import { MovementType } from '../entities/stock-movement.entity';
import { StorageItemType } from '../entities/storage-inventory.entity';

@InputType()
export class RecordStockMovementInput {
  @Field(() => MovementType)
  @IsEnum(MovementType)
  movementType: MovementType;

  @Field(() => StorageItemType)
  @IsEnum(StorageItemType)
  itemType: StorageItemType;

  @Field(() => ID)
  @IsUUID()
  itemId: string;

  @Field(() => Float)
  @IsNumber()
  quantity: number;

  @Field(() => ID, { nullable: true, description: 'Source location (required for OUT, WASTE)' })
  @IsOptional()
  @IsUUID()
  fromLocationId?: string;

  @Field(() => ID, { nullable: true, description: 'Target location (required for IN)' })
  @IsOptional()
  @IsUUID()
  toLocationId?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  lotNumber?: string;

  @Field({ nullable: true })
  @IsOptional()
  expiryDate?: Date;

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
