import { InputType, ObjectType, Field, ID, Int } from '@nestjs/graphql';
import { IsString, IsOptional, IsEnum, IsUUID, MaxLength, IsObject } from 'class-validator';
import { GraphQLJSON } from 'graphql-scalars';

import { ScadaPackageStatus } from '../entities/scada-package.entity';

// ============================================================================
// Input DTOs
// ============================================================================

@InputType()
export class CreateScadaPackageInput {
  @Field()
  @IsString()
  @MaxLength(255)
  name!: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  description?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsUUID()
  processId?: string;

  @Field(() => GraphQLJSON)
  @IsObject()
  packageData!: Record<string, unknown>;
}

@InputType()
export class UpdateScadaPackageInput {
  @Field(() => ID)
  @IsUUID()
  id!: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  name?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  description?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsUUID()
  processId?: string;

  @Field(() => GraphQLJSON, { nullable: true })
  @IsOptional()
  @IsObject()
  packageData?: Record<string, unknown>;

  @Field(() => ScadaPackageStatus, { nullable: true })
  @IsOptional()
  @IsEnum(ScadaPackageStatus)
  status?: ScadaPackageStatus;
}

@InputType()
export class ScadaPackageFilterInput {
  @Field(() => ScadaPackageStatus, { nullable: true })
  @IsOptional()
  @IsEnum(ScadaPackageStatus)
  status?: ScadaPackageStatus;

  @Field({ nullable: true })
  @IsOptional()
  @IsUUID()
  processId?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  searchTerm?: string;
}

// ============================================================================
// Output DTOs
// ============================================================================

@ObjectType()
export class ScadaPackageType {
  @Field(() => ID)
  id!: string;

  @Field()
  tenantId!: string;

  @Field()
  name!: string;

  @Field({ nullable: true })
  description?: string;

  @Field(() => Int)
  version!: number;

  @Field({ nullable: true })
  processId?: string;

  @Field({ nullable: true })
  processName?: string;

  @Field(() => GraphQLJSON)
  packageData!: Record<string, unknown>;

  @Field(() => ScadaPackageStatus)
  status!: ScadaPackageStatus;

  @Field({ nullable: true })
  createdBy?: string;

  @Field({ nullable: true })
  updatedBy?: string;

  @Field()
  createdAt!: Date;

  @Field()
  updatedAt!: Date;
}

@ObjectType()
export class ScadaPackageListType {
  @Field(() => [ScadaPackageType])
  items!: ScadaPackageType[];

  @Field(() => Int)
  total!: number;

  @Field(() => Int)
  offset!: number;

  @Field(() => Int)
  limit!: number;

  @Field()
  hasMore!: boolean;
}

@ObjectType()
export class DeployScadaPackageResultType {
  @Field()
  success!: boolean;

  @Field({ nullable: true })
  message?: string;

  @Field(() => ID, { nullable: true })
  packageId?: string;

  @Field(() => ID, { nullable: true })
  deviceId?: string;
}
