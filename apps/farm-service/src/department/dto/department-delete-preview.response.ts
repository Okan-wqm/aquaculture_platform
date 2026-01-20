/**
 * Department Delete Preview Response Types for GraphQL
 * Displays what will be deleted when a department is cascade soft deleted
 */
import { ObjectType, Field, Int, Float, ID } from '@nestjs/graphql';
import { DepartmentResponse } from './department.response';

/**
 * Summary of a tank that will be affected
 */
@ObjectType('DepartmentTankSummary')
export class DepartmentTankSummary {
  @Field(() => ID)
  id!: string;

  @Field()
  name!: string;

  @Field()
  code!: string;

  @Field(() => Float)
  currentBiomass!: number;

  @Field()
  hasActiveBiomass!: boolean;
}

/**
 * Summary of an equipment that will be affected
 */
@ObjectType('DepartmentEquipmentSummary')
export class DepartmentEquipmentSummary {
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
 * All items that will be affected by department deletion
 */
@ObjectType()
export class DepartmentAffectedItems {
  @Field(() => [DepartmentEquipmentSummary])
  equipment!: DepartmentEquipmentSummary[];

  @Field(() => [DepartmentTankSummary])
  tanks!: DepartmentTankSummary[];

  @Field(() => Int)
  totalCount!: number;
}

/**
 * Department delete preview response
 */
@ObjectType()
export class DepartmentDeletePreviewResponse {
  @Field(() => DepartmentResponse)
  department!: DepartmentResponse;

  @Field()
  canDelete!: boolean;

  @Field(() => [String])
  blockers!: string[];

  @Field(() => DepartmentAffectedItems)
  affectedItems!: DepartmentAffectedItems;
}
