import { MobileCommandEnvelopeInput } from '@aquaculture/backend-common/mobile-command';
import { InputType, Field, Float, ID } from '@nestjs/graphql';
import { IsIn, IsNumber, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';

import { StorageItemType } from '../entities/storage-inventory.entity';

/**
 * The item types `transferStock` moves.
 *
 * WHY SPARE_PART and HEALTHCARE are excluded: `TransferStockHandler` still
 * hand-writes both inventory legs (FARM-HIGH-239, lane-B PR B1a-1b), so it takes
 * no stock mutation lock, emits no LowStockDetected and can book into a
 * soft-deleted location. SPARE_PART stock moves only through the manager-gated
 * spare-part ledger door (`recordSparePartStockMovement`, movement type
 * `transfer`), and HEALTHCARE shares the consumable catalog row, whose canonical
 * lock this handler never takes. Admitting either here reopened the second door
 * the spare-part ledger closed.
 * WHAT: the type AND the validator derive from this one list, so the handler
 * cannot be handed another type (compile time) and the API refuses it (runtime).
 * INVARIANT: if violated → a MODULE_USER moves spare-part stock around the
 * manager gate and the low-stock sink.
 */
export const TRANSFERABLE_ITEM_TYPES = [
  StorageItemType.FEED,
  StorageItemType.CHEMICAL,
  StorageItemType.CONSUMABLE,
] as const satisfies readonly StorageItemType[];

/** A ledger item type `transferStock` may move (see TRANSFERABLE_ITEM_TYPES). */
export type TransferableItemType = (typeof TRANSFERABLE_ITEM_TYPES)[number];

@InputType()
export class TransferStockInput extends MobileCommandEnvelopeInput {
  @Field(() => StorageItemType, {
    description:
      'FEED, CHEMICAL or CONSUMABLE. Spare parts move through recordSparePartStockMovement (transfer).',
  })
  @IsIn(TRANSFERABLE_ITEM_TYPES, {
    message: 'transferStock moves feed, chemical and consumable stock only',
  })
  itemType!: TransferableItemType;

  @Field(() => ID)
  @IsUUID()
  itemId!: string;

  @Field(() => Float)
  @IsNumber()
  quantity!: number;

  @Field(() => ID)
  @IsUUID()
  fromLocationId!: string;

  @Field(() => ID)
  @IsUUID()
  toLocationId!: string;

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

  @Field({ nullable: true, description: 'Client-generated idempotency key for at-most-once transfer execution' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  idempotencyKey?: string;
}
