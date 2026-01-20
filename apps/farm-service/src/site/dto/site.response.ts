/**
 * Site Response Types for GraphQL
 */
import { ObjectType, Field, Int, Float, ID, registerEnumType } from '@nestjs/graphql';
import { GraphQLJSON } from 'graphql-type-json';
import { SiteStatus, SiteType } from '../entities/site.entity';

// Register enums for GraphQL
registerEnumType(SiteStatus, {
  name: 'SiteStatus',
  description: 'Status of the site',
});

registerEnumType(SiteType, {
  name: 'SiteType',
  description: 'Type of the site',
});

@ObjectType()
export class SiteLocationResponse {
  @Field(() => Float)
  latitude!: number;

  @Field(() => Float)
  longitude!: number;

  @Field(() => Float, { nullable: true })
  altitude?: number;
}

@ObjectType()
export class SiteAddressResponse {
  @Field({ nullable: true })
  street?: string;

  @Field({ nullable: true })
  city?: string;

  @Field({ nullable: true })
  state?: string;

  @Field({ nullable: true })
  postalCode?: string;

  @Field({ nullable: true })
  country?: string;
}

@ObjectType()
export class SiteResponse {
  @Field(() => ID)
  id!: string;

  @Field(() => ID)
  tenantId!: string;

  @Field()
  name!: string;

  @Field()
  code!: string;

  @Field({ nullable: true })
  description?: string;

  @Field(() => SiteType)
  type!: SiteType;

  @Field(() => SiteLocationResponse, { nullable: true })
  location?: SiteLocationResponse;

  @Field(() => SiteAddressResponse, { nullable: true })
  address?: SiteAddressResponse;

  @Field({ nullable: true })
  country?: string;

  @Field({ nullable: true })
  region?: string;

  @Field()
  timezone!: string;

  @Field(() => SiteStatus)
  status!: SiteStatus;

  @Field(() => GraphQLJSON, { nullable: true })
  settings?: Record<string, unknown>;

  @Field(() => Float, { nullable: true })
  totalArea?: number;

  @Field({ nullable: true })
  siteManager?: string;

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
export class PaginatedSitesResponse {
  @Field(() => [SiteResponse])
  items!: SiteResponse[];

  @Field(() => Int)
  total!: number;

  @Field(() => Int)
  page!: number;

  @Field(() => Int)
  limit!: number;

  @Field(() => Int)
  totalPages!: number;
}
