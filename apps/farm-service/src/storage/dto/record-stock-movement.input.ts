import { InputType, Field, Float, ID } from '@nestjs/graphql';
import { IsNotEmpty, IsString, IsOptional, IsNumber, MaxLength, IsEnum, IsUUID, Min, Max } from 'class-validator';
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
  @Min(0.01)
  @Max(9999999)
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

  /**
   * Client-generated idempotency key (UUID v4 recommended). When provided,
   * the server guarantees at-most-once execution: if a movement with this key
   * already exists, the existing movement is returned instead of creating a
   * duplicate. This protects against network retries and double-click submissions.
   *
   * Frontend should generate this via crypto.randomUUID() before the first
   * submission attempt and include the same key on every retry.
   */
  @Field({ nullable: true, description: 'Client-generated idempotency key to prevent duplicate movements' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  idempotencyKey?: string;
}
