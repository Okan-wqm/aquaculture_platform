import { Field, ID, InputType, Int, ObjectType } from '@nestjs/graphql';
import { StandardPaginatedResponse } from '@aquaculture/backend-common/pagination';
import { IsArray, IsBoolean, IsOptional, IsString, IsUUID } from 'class-validator';
import { FarmStockBatchSnapshot } from '../entities/farm-stock-batch-snapshot.entity';
import {
  FarmStockContainerSnapshot,
  FarmStockContainerSource,
} from '../entities/farm-stock-container-snapshot.entity';

@InputType()
export class FarmStockInventoryFilterInput {
  @Field(() => [FarmStockContainerSource], { nullable: true })
  @IsOptional()
  @IsArray()
  containerSources?: FarmStockContainerSource[];

  @Field(() => ID, { nullable: true })
  @IsOptional()
  @IsUUID()
  departmentId?: string;

  @Field(() => ID, { nullable: true })
  @IsOptional()
  @IsUUID()
  siteId?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  status?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @Field({ nullable: true })
  @IsOptional()
  @IsBoolean()
  hasActiveBatch?: boolean;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  search?: string;

  @Field(() => Int, { nullable: true, defaultValue: 1 })
  @IsOptional()
  page?: number;

  @Field(() => Int, { nullable: true, defaultValue: 100 })
  @IsOptional()
  limit?: number;
}

@ObjectType()
export class FarmStockInventoryItem {
  @Field(() => FarmStockContainerSnapshot)
  container!: FarmStockContainerSnapshot;

  @Field(() => [FarmStockBatchSnapshot])
  batches!: FarmStockBatchSnapshot[];
}

@ObjectType()
export class FarmStockInventoryConnection extends StandardPaginatedResponse(
  FarmStockInventoryItem,
) {}
