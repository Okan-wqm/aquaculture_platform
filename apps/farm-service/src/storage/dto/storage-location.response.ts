import { ObjectType, Field, Int, Float, ID } from '@nestjs/graphql';
import { StandardPaginatedResponse } from '@aquaculture/backend-common';
import { StorageLocationType } from '../entities/storage-location.entity';

@ObjectType()
export class StorageLocationResponse {
  @Field(() => ID)
  id!: string;

  @Field(() => ID)
  tenantId!: string;

  @Field(() => ID)
  siteId!: string;

  @Field()
  name!: string;

  @Field()
  code!: string;

  @Field(() => StorageLocationType)
  type!: StorageLocationType;

  @Field({ nullable: true })
  description?: string;

  @Field(() => Float, { nullable: true })
  capacity?: number;

  @Field()
  capacityUnit!: string;

  @Field(() => Float)
  usedCapacity!: number;

  @Field(() => Float, { nullable: true })
  temperatureMin?: number;

  @Field(() => Float, { nullable: true })
  temperatureMax?: number;

  @Field(() => Float, { nullable: true })
  humidityMin?: number;

  @Field(() => Float, { nullable: true })
  humidityMax?: number;

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
export class PaginatedStorageLocationsResponse extends StandardPaginatedResponse(StorageLocationResponse) {}
