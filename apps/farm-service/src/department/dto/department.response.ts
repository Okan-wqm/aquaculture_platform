/**
 * Department Response Types for GraphQL
 */
import { ObjectType, Field, Int, Float, ID } from '@nestjs/graphql';
import { GraphQLJSON } from 'graphql-type-json';
import { StandardPaginatedResponse } from '@aquaculture/backend-common/pagination';
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

  /**
   * The department's manager, as stored on the department row
   * (departments.managerUserId / managerName, written by create/update).
   * WHY these names: the resolvers return the entity itself, so a response
   * field reads only when it carries the entity column's name — the former
   * `departmentManager` field mapped to no column and was always null, and the
   * facility-structure page reported every department as unassigned.
   */
  @Field(() => ID, { nullable: true })
  managerUserId?: string;

  /** Display name stored with the manager (denormalised for listing). */
  @Field({ nullable: true })
  managerName?: string;

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
export class PaginatedDepartmentsResponse extends StandardPaginatedResponse(DepartmentResponse) {}
