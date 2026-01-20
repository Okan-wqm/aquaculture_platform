/**
 * System Response Types for GraphQL
 */
import { ObjectType, Field, Int, Float, ID } from '@nestjs/graphql';
import { SystemType, SystemStatus } from '../entities/system.entity';
import { SiteResponse } from '../../site/dto/site.response';
import { DepartmentResponse } from '../../department/dto/department.response';

@ObjectType()
export class SystemResponse {
  @Field(() => ID)
  id: string;

  @Field(() => ID)
  tenantId: string;

  @Field(() => ID)
  siteId: string;

  @Field(() => SiteResponse, { nullable: true })
  site?: SiteResponse;

  @Field(() => ID, { nullable: true })
  departmentId?: string;

  @Field(() => DepartmentResponse, { nullable: true })
  department?: DepartmentResponse;

  @Field(() => ID, { nullable: true })
  parentSystemId?: string;

  @Field(() => SystemResponse, { nullable: true })
  parentSystem?: SystemResponse;

  @Field(() => [SystemResponse], { nullable: true })
  childSystems?: SystemResponse[];

  @Field()
  name: string;

  @Field()
  code: string;

  @Field(() => SystemType)
  type: SystemType;

  @Field(() => SystemStatus)
  status: SystemStatus;

  @Field({ nullable: true })
  description?: string;

  @Field(() => Float, { nullable: true })
  totalVolumeM3?: number;

  @Field(() => Float, { nullable: true })
  maxBiomassKg?: number;

  @Field(() => Int, { nullable: true })
  tankCount?: number;

  @Field()
  isActive: boolean;

  @Field(() => ID, { nullable: true })
  createdBy?: string;

  @Field(() => ID, { nullable: true })
  updatedBy?: string;

  @Field()
  createdAt: Date;

  @Field()
  updatedAt: Date;
}

@ObjectType()
export class PaginatedSystemsResponse {
  @Field(() => [SystemResponse])
  items: SystemResponse[];

  @Field(() => Int)
  total: number;

  @Field(() => Int)
  page: number;

  @Field(() => Int)
  limit: number;

  @Field(() => Int)
  totalPages: number;
}
