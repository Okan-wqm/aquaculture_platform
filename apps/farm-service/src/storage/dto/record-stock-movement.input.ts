import { MobileCommandEnvelopeInput } from '@aquaculture/backend-common/mobile-command';
import { InputType, Field, Float, ID } from '@nestjs/graphql';
import { Type } from 'class-transformer';
import { IsDate, IsEnum, IsNumber, IsOptional, IsString, IsUUID, Max, MaxDate, MaxLength, Min } from 'class-validator';

import { MovementType } from '../entities/stock-movement.entity';
import { StorageItemType } from '../entities/storage-inventory.entity';

@InputType()
export class RecordStockMovementInput extends MobileCommandEnvelopeInput {
  @Field(() => MovementType)
  @IsEnum(MovementType)
  movementType!: MovementType;

  @Field(() => StorageItemType)
  @IsEnum(StorageItemType)
  itemType!: StorageItemType;

  @Field(() => ID)
  @IsUUID()
  itemId!: string;

  @Field(() => Float)
  @IsNumber()
  @Min(0.01)
  @Max(9999999)
  quantity!: number;

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

  /**
   * Authoritative timestamp of the underlying operational event.
   *
   * For manual movements the server default (now) is fine. For
   * event-driven flows (e.g. a FeedingRecordedEvent that logs yesterday's
   * meal today), the caller MUST pass the event's occurredAt here so
   * FEFO picks from lots that were actually in inventory AT the event
   * time — not lots that arrived afterwards.
   *
   * Future dates are rejected (cannot consume from lots that have not
   * yet arrived). Backdating beyond a hard policy limit is enforced at
   * the event-handler layer; this DTO only guards the obvious "cannot
   * be in the future" axis.
   */
  @Field({
    nullable: true,
    description:
      'Authoritative event date for FEFO as-of scoping. Defaults to now when omitted.',
  })
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  @MaxDate(() => new Date())
  movementDate?: Date;
}
