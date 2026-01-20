/**
 * Equipment Delete Preview Response Types for GraphQL
 * Displays what will be deleted when an equipment is cascade soft deleted
 */
import { ObjectType, Field, Int, ID } from '@nestjs/graphql';
import { EquipmentResponse } from './equipment.response';

/**
 * Summary of a child equipment that will be affected
 */
@ObjectType('EquipmentChildSummary')
export class EquipmentChildSummary {
  @Field(() => ID)
  id!: string;

  @Field()
  name!: string;

  @Field()
  code!: string;

  @Field()
  status!: string;
}

/**
 * Summary of a sub-equipment that will be affected
 */
@ObjectType('SubEquipmentSummary')
export class SubEquipmentSummary {
  @Field(() => ID)
  id!: string;

  @Field()
  name!: string;

  @Field()
  code!: string;

  @Field()
  status!: string;
}

/**
 * All items that will be affected by equipment deletion
 */
@ObjectType()
export class EquipmentAffectedItems {
  @Field(() => [EquipmentChildSummary])
  childEquipment!: EquipmentChildSummary[];

  @Field(() => [SubEquipmentSummary])
  subEquipment!: SubEquipmentSummary[];

  @Field(() => Int)
  totalCount!: number;
}

/**
 * Equipment delete preview response
 */
@ObjectType()
export class EquipmentDeletePreviewResponse {
  @Field(() => EquipmentResponse)
  equipment!: EquipmentResponse;

  @Field()
  canDelete!: boolean;

  @Field(() => [String])
  blockers!: string[];

  @Field(() => EquipmentAffectedItems)
  affectedItems!: EquipmentAffectedItems;
}
