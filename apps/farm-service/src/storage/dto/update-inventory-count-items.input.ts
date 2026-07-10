import { InputType, Field, ID, Float } from '@nestjs/graphql';
import { IsUUID, IsArray, ValidateNested, IsNumber, IsOptional, IsString, Min, MaxLength } from 'class-validator';
import { Type } from 'class-transformer';

/**
 * Single item update within an inventory count. Represents one physical
 * observation by the warehouse staff — "I counted X units of this item."
 */
@InputType()
export class InventoryCountItemUpdateInput {
  @Field(() => ID, { description: 'ID of the InventoryCountItem to update' })
  @IsUUID()
  itemId!: string;

  /**
   * Physical quantity observed. Must be >= 0 (negative stock is physically
   * impossible). Null is allowed in the entity but not in this input — once
   * you submit a count for an item, you must provide a number.
   */
  @Field(() => Float, { description: 'Physical quantity observed during counting' })
  @IsNumber()
  @Min(0)
  actualQuantity!: number;

  @Field({ nullable: true, description: 'Notes about this specific item count (e.g., damage observed)' })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string;
}

/**
 * Input for updating actual quantities on inventory count items.
 *
 * Supports partial updates: the counter can submit counts for a subset of
 * items and come back to finish the rest later. This reflects real warehouse
 * workflows where different sections of a location are counted at different
 * times by different staff members.
 */
@InputType()
export class UpdateInventoryCountItemsInput {
  @Field(() => ID, { description: 'ID of the inventory count session' })
  @IsUUID()
  countId!: string;

  @Field(() => [InventoryCountItemUpdateInput], { description: 'Items to update with actual quantities' })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => InventoryCountItemUpdateInput)
  items!: InventoryCountItemUpdateInput[];
}
