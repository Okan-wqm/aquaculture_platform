/**
 * SubEquipment Response Types for GraphQL
 */
import { ObjectType, Field, Int, ID } from '@nestjs/graphql';
import { GraphQLJSON } from 'graphql-type-json';
import { StandardPaginatedResponse } from '@aquaculture/backend-common/pagination';
import { EquipmentStatus } from '../entities/equipment.entity';
import { EquipmentResponse } from './equipment.response';

@ObjectType()
export class SubEquipmentTypeResponse {
  @Field(() => ID)
  id!: string;

  @Field()
  name!: string;

  @Field()
  code!: string;

  @Field({ nullable: true })
  description?: string;

  @Field({ nullable: true })
  icon?: string;

  @Field(() => [String], { description: 'Compatible equipment type codes' })
  compatibleEquipmentTypes!: string[];

  @Field(() => GraphQLJSON, { nullable: true })
  specificationSchema?: Record<string, unknown>;

  @Field()
  isActive!: boolean;

  @Field()
  isSystem!: boolean;

  @Field(() => Int)
  sortOrder!: number;

  @Field()
  createdAt!: Date;

  @Field()
  updatedAt!: Date;
}

@ObjectType()
export class SubEquipmentResponse {
  @Field(() => ID)
  id!: string;

  @Field(() => ID)
  tenantId!: string;

  @Field(() => ID)
  parentEquipmentId!: string;

  @Field(() => EquipmentResponse, { nullable: true })
  parentEquipment?: EquipmentResponse;

  @Field(() => ID)
  subEquipmentTypeId!: string;

  @Field(() => SubEquipmentTypeResponse, { nullable: true })
  subEquipmentType?: SubEquipmentTypeResponse;

  @Field()
  name!: string;

  @Field()
  code!: string;

  @Field({ nullable: true })
  description?: string;

  @Field({ nullable: true })
  manufacturer?: string;

  @Field({ nullable: true })
  model?: string;

  @Field({ nullable: true })
  serialNumber?: string;

  @Field(() => EquipmentStatus)
  status!: EquipmentStatus;

  @Field(() => GraphQLJSON, { nullable: true })
  specifications?: Record<string, unknown>;

  @Field({ nullable: true })
  installationDate?: Date;

  @Field({ nullable: true })
  notes?: string;

  @Field()
  isActive!: boolean;

  @Field(() => ID, { nullable: true })
  createdBy?: string;

  @Field(() => ID, { nullable: true })
  updatedBy?: string;

  @Field()
  createdAt!: Date;

  @Field()
  updatedAt!: Date;

  @Field(() => Int)
  version!: number;
}

@ObjectType()
export class PaginatedSubEquipmentResponse extends StandardPaginatedResponse(SubEquipmentResponse) {}
