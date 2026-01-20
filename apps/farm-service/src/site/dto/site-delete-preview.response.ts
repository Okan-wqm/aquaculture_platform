/**
 * Site Delete Preview Response Types for GraphQL
 * Displays what will be deleted when a site is cascade soft deleted
 */
import { ObjectType, Field, Int, Float, ID } from '@nestjs/graphql';
import { SiteResponse } from './site.response';

/**
 * Summary of a tank that will be affected
 */
@ObjectType()
export class TankSummary {
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
@ObjectType()
export class EquipmentSummary {
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
 * Summary of a system that will be affected
 */
@ObjectType()
export class SystemSummary {
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
 * Summary of a department that will be affected
 */
@ObjectType()
export class DepartmentSummary {
  @Field(() => ID)
  id!: string;

  @Field()
  name!: string;

  @Field()
  code!: string;

  @Field(() => Int)
  equipmentCount!: number;

  @Field(() => Int)
  tankCount!: number;
}

/**
 * All items that will be affected by site deletion
 */
@ObjectType()
export class SiteAffectedItems {
  @Field(() => [DepartmentSummary])
  departments!: DepartmentSummary[];

  @Field(() => [SystemSummary])
  systems!: SystemSummary[];

  @Field(() => [EquipmentSummary])
  equipment!: EquipmentSummary[];

  @Field(() => [TankSummary])
  tanks!: TankSummary[];

  @Field(() => Int)
  totalCount!: number;
}

/**
 * Site delete preview response
 */
@ObjectType()
export class SiteDeletePreviewResponse {
  @Field(() => SiteResponse)
  site!: SiteResponse;

  @Field()
  canDelete!: boolean;

  @Field(() => [String])
  blockers!: string[];

  @Field(() => SiteAffectedItems)
  affectedItems!: SiteAffectedItems;
}
