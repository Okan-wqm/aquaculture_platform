/**
 * Consumable Response Types for GraphQL
 */
import { ObjectType, Field, Int, Float, ID } from '@nestjs/graphql';
import { StandardPaginatedResponse } from '@platform/backend-common';
import { ConsumableCategory, ConsumableStatus } from '../entities/consumable.entity';

@ObjectType()
export class ConsumableResponse {
  @Field(() => ID)
  id!: string;

  @Field(() => ID)
  tenantId!: string;

  @Field()
  name!: string;

  @Field()
  code!: string;

  @Field(() => ConsumableCategory)
  category!: ConsumableCategory;

  @Field({ nullable: true })
  description?: string;

  @Field()
  unit!: string;

  @Field({ nullable: true })
  brand?: string;

  @Field(() => ID, { nullable: true })
  supplierId?: string;

  @Field(() => Float)
  quantity!: number;

  @Field(() => Float)
  minStock!: number;

  @Field(() => ConsumableStatus)
  status!: ConsumableStatus;

  @Field(() => Float, { nullable: true })
  unitPrice?: number;

  @Field()
  currency!: string;

  // Storage conditions
  @Field(() => Float, { nullable: true })
  storageTempMin?: number;

  @Field(() => Float, { nullable: true })
  storageTempMax?: number;

  @Field(() => Float, { nullable: true })
  storageHumidityMin?: number;

  @Field(() => Float, { nullable: true })
  storageHumidityMax?: number;

  @Field({ nullable: true })
  storageRequirements?: string;

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
}

@ObjectType()
export class PaginatedConsumablesResponse extends StandardPaginatedResponse(ConsumableResponse) {}
