import { InputType, Field, ID } from '@nestjs/graphql';
import { IsUUID, IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * Input for creating an inventory count session.
 *
 * Only the storageLocationId is required. Items are auto-populated from
 * storage_inventory to ensure the count reflects the current system state.
 * This prevents manual cherry-picking of items, which is a common audit
 * finding in BAP/ASC certification reviews.
 */
@InputType()
export class CreateInventoryCountInput {
  @Field(() => ID, { description: 'Target storage location to count' })
  @IsUUID()
  storageLocationId!: string;

  /**
   * Free-text notes for the count session (e.g., "Quarterly compliance count",
   * "Post-incident verification after flooding"). MaxLength(2000) prevents
   * unbounded input while accommodating detailed regulatory notes.
   */
  @Field({ nullable: true, description: 'Optional notes for this count session' })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;
}
