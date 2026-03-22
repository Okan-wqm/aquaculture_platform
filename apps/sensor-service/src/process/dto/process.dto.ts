import { InputType, ObjectType, Field, ID, Int } from '@nestjs/graphql';
import { Type } from 'class-transformer';
import { IsString, IsOptional, IsEnum, IsUUID, MaxLength } from 'class-validator';
import { GraphQLJSON } from 'graphql-scalars';

import { ProcessStatus, ProcessNode, ProcessEdge } from '../entities/process.entity';
import { StandardPaginationInput, StandardPaginatedResponse } from '@aquaculture/backend-common';

// ============================================================================
// Input DTOs
// ============================================================================

@InputType()
export class CreateProcessInput {
  @Field()
  @IsString()
  @MaxLength(255)
  name!: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  description?: string;

  @Field(() => ProcessStatus, { nullable: true })
  @IsOptional()
  @IsEnum(ProcessStatus)
  status?: ProcessStatus;

  @Field(() => GraphQLJSON, { nullable: true })
  @IsOptional()
  @Type(() => Object)
  nodes?: ProcessNode[];

  @Field(() => GraphQLJSON, { nullable: true })
  @IsOptional()
  @Type(() => Object)
  edges?: ProcessEdge[];

  @Field({ nullable: true })
  @IsOptional()
  @IsUUID()
  siteId?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsUUID()
  departmentId?: string;

  @Field(() => GraphQLJSON, { nullable: true })
  @IsOptional()
  metadata?: Record<string, unknown>;

  @Field({ nullable: true })
  @IsOptional()
  isTemplate?: boolean;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  templateName?: string;
}

@InputType()
export class UpdateProcessInput {
  @Field(() => ID)
  @IsUUID()
  processId!: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  name?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  description?: string;

  @Field(() => ProcessStatus, { nullable: true })
  @IsOptional()
  @IsEnum(ProcessStatus)
  status?: ProcessStatus;

  @Field(() => GraphQLJSON, { nullable: true })
  @IsOptional()
  @Type(() => Object)
  nodes?: ProcessNode[];

  @Field(() => GraphQLJSON, { nullable: true })
  @IsOptional()
  @Type(() => Object)
  edges?: ProcessEdge[];

  @Field({ nullable: true })
  @IsOptional()
  @IsUUID()
  siteId?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsUUID()
  departmentId?: string;

  @Field(() => GraphQLJSON, { nullable: true })
  @IsOptional()
  metadata?: Record<string, unknown>;

  @Field({ nullable: true })
  @IsOptional()
  isTemplate?: boolean;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  templateName?: string;
}

@InputType()
export class ProcessFilterInput {
  @Field(() => ProcessStatus, { nullable: true })
  @IsOptional()
  @IsEnum(ProcessStatus)
  status?: ProcessStatus;

  @Field({ nullable: true })
  @IsOptional()
  @IsUUID()
  siteId?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsUUID()
  departmentId?: string;

  @Field({ nullable: true })
  @IsOptional()
  isTemplate?: boolean;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  searchTerm?: string;
}

@InputType('ProcessPaginationInput')
export class ProcessPaginationInput extends StandardPaginationInput {}

// ============================================================================
// Output DTOs
// ============================================================================

@ObjectType()
export class ProcessType {
  @Field(() => ID)
  id!: string;

  @Field()
  name!: string;

  @Field({ nullable: true })
  description?: string;

  @Field(() => ProcessStatus)
  status!: ProcessStatus;

  @Field(() => GraphQLJSON)
  nodes!: ProcessNode[];

  @Field(() => GraphQLJSON)
  edges!: ProcessEdge[];

  @Field()
  tenantId!: string;

  @Field({ nullable: true })
  siteId?: string;

  @Field({ nullable: true })
  departmentId?: string;

  @Field(() => GraphQLJSON, { nullable: true })
  metadata?: Record<string, unknown>;

  @Field()
  isTemplate!: boolean;

  @Field({ nullable: true })
  templateName?: string;

  @Field()
  createdAt!: Date;

  @Field()
  updatedAt!: Date;

  @Field({ nullable: true })
  createdBy?: string;

  @Field({ nullable: true })
  updatedBy?: string;
}

@ObjectType()
export class ProcessResultType {
  @Field()
  success!: boolean;

  @Field({ nullable: true })
  message?: string;

  @Field(() => ProcessType, { nullable: true })
  process?: ProcessType;
}

@ObjectType()
export class ProcessListType extends StandardPaginatedResponse(ProcessType) {}

@ObjectType()
export class DeleteProcessResultType {
  @Field()
  success!: boolean;

  @Field({ nullable: true })
  message?: string;

  @Field(() => ID, { nullable: true })
  deletedId?: string;
}

@ObjectType()
export class DeployProcessResultType {
  @Field()
  success!: boolean;

  @Field({ nullable: true })
  message?: string;

  @Field(() => ID, { nullable: true })
  processId?: string;

  @Field(() => ID, { nullable: true })
  deviceId?: string;
}
