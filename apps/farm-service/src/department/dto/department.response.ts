/**
 * Department Response Types for GraphQL
 */
import { ObjectType, Field, Int, Float, ID } from '@nestjs/graphql';
import { GraphQLJSON } from 'graphql-type-json';
import { DepartmentType, DepartmentStatus } from '../entities/department.entity';
import { SiteResponse } from '../../site/dto/site.response';

// NOTE: DepartmentType and DepartmentStatus enums are registered in department.entity.ts
// Do not register them again here to avoid duplicate registration warnings

@ObjectType()
export class DepartmentResponse {
  @Field(() => ID)
  id!: string;

  @Field(() => ID)
  tenantId!: string;

  @Field(() => ID, { nullable: true })
  siteId?: string;

  @Field(() => SiteResponse, { nullable: true })
  site?: SiteResponse;

  @Field()
  name!: string;

  @Field()
  code!: string;

  @Field(() => DepartmentType)
  type!: DepartmentType;

  @Field({ nullable: true })
  description?: string;

  @Field(() => DepartmentStatus)
  status!: DepartmentStatus;

  @Field(() => Float, { nullable: true })
  capacity?: number;

  @Field(() => Float, { nullable: true })
  currentLoad?: number;

  @Field(() => GraphQLJSON, { nullable: true })
  settings?: Record<string, unknown>;

  @Field({ nullable: true })
  departmentManager?: string;

  @Field({ nullable: true })
  contactEmail?: string;

  @Field({ nullable: true })
  contactPhone?: string;

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
}

@ObjectType()
export class PaginatedDepartmentsResponse {
  @Field(() => [DepartmentResponse])
  items!: DepartmentResponse[];

  @Field(() => Int)
  total!: number;

  @Field(() => Int)
  page!: number;

  @Field(() => Int)
  limit!: number;

  @Field(() => Int)
  totalPages!: number;
}
