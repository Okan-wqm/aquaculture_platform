/**
 * System Delete Preview Response Types for GraphQL
 * Displays what will be deleted when a system is cascade soft deleted
 */
import { ObjectType, Field, Int, ID } from '@nestjs/graphql';
import { SystemResponse } from './system.response';

/**
 * Summary of a child system that will be affected
 */
@ObjectType('SystemChildSummary')
export class SystemChildSummary {
  @Field(() => ID)
  id!: string;

  @Field()
  name!: string;

  @Field()
  code!: string;

  @Field(() => Int)
  equipmentCount!: number;
}

/**
 * Summary of an equipment that will be affected
 */
@ObjectType('SystemEquipmentSummary')
export class SystemEquipmentSummary {
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
 * All items that will be affected by system deletion
 */
@ObjectType()
export class SystemAffectedItems {
  @Field(() => [SystemChildSummary])
  childSystems!: SystemChildSummary[];

  @Field(() => [SystemEquipmentSummary])
  equipment!: SystemEquipmentSummary[];

  @Field(() => Int)
  totalCount!: number;
}

/**
 * System delete preview response
 */
@ObjectType()
export class SystemDeletePreviewResponse {
  @Field(() => SystemResponse)
  system!: SystemResponse;

  @Field()
  canDelete!: boolean;

  @Field(() => [String])
  blockers!: string[];

  @Field(() => SystemAffectedItems)
  affectedItems!: SystemAffectedItems;
}
