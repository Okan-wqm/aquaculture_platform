import { InputType, ObjectType, Field, ID, Int, Float } from '@nestjs/graphql';
import { IsString, IsOptional, IsEnum, IsUUID, MaxLength, IsObject } from 'class-validator';
import { GraphQLJSON } from 'graphql-scalars';

import { TagDirection, TagIoType, TagDataType } from '../entities/unified-tag.entity';

// ============================================================================
// Input DTOs
// ============================================================================

@InputType()
export class CreateTagInput {
  @Field()
  @IsString()
  @MaxLength(500)
  fqn!: string;

  @Field()
  @IsString()
  @MaxLength(100)
  localName!: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  displayName?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  description?: string;

  @Field(() => TagIoType)
  @IsEnum(TagIoType)
  ioType!: TagIoType;

  @Field(() => TagDataType)
  @IsEnum(TagDataType)
  dataType!: TagDataType;

  @Field(() => TagDirection, { nullable: true })
  @IsOptional()
  @IsEnum(TagDirection)
  direction?: TagDirection;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  engUnit?: string;

  @Field(() => Float, { nullable: true })
  @IsOptional()
  engMin?: number;

  @Field(() => Float, { nullable: true })
  @IsOptional()
  engMax?: number;

  @Field(() => Float, { nullable: true })
  @IsOptional()
  alarmHH?: number;

  @Field(() => Float, { nullable: true })
  @IsOptional()
  alarmH?: number;

  @Field(() => Float, { nullable: true })
  @IsOptional()
  alarmL?: number;

  @Field(() => Float, { nullable: true })
  @IsOptional()
  alarmLL?: number;

  @Field(() => Float, { nullable: true })
  @IsOptional()
  deadband?: number;

  @Field(() => GraphQLJSON, { nullable: true })
  @IsOptional()
  @IsObject()
  source?: Record<string, unknown>;

  @Field(() => GraphQLJSON, { nullable: true })
  @IsOptional()
  @IsObject()
  hierarchy?: Record<string, unknown>;
}

@InputType()
export class UpdateTagInput {
  @Field(() => ID)
  @IsUUID()
  id!: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  fqn?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  localName?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  displayName?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  description?: string;

  @Field(() => TagIoType, { nullable: true })
  @IsOptional()
  @IsEnum(TagIoType)
  ioType?: TagIoType;

  @Field(() => TagDataType, { nullable: true })
  @IsOptional()
  @IsEnum(TagDataType)
  dataType?: TagDataType;

  @Field(() => TagDirection, { nullable: true })
  @IsOptional()
  @IsEnum(TagDirection)
  direction?: TagDirection;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  engUnit?: string;

  @Field(() => Float, { nullable: true })
  @IsOptional()
  engMin?: number;

  @Field(() => Float, { nullable: true })
  @IsOptional()
  engMax?: number;

  @Field(() => Float, { nullable: true })
  @IsOptional()
  alarmHH?: number;

  @Field(() => Float, { nullable: true })
  @IsOptional()
  alarmH?: number;

  @Field(() => Float, { nullable: true })
  @IsOptional()
  alarmL?: number;

  @Field(() => Float, { nullable: true })
  @IsOptional()
  alarmLL?: number;

  @Field(() => Float, { nullable: true })
  @IsOptional()
  deadband?: number;

  @Field(() => GraphQLJSON, { nullable: true })
  @IsOptional()
  @IsObject()
  source?: Record<string, unknown>;

  @Field(() => GraphQLJSON, { nullable: true })
  @IsOptional()
  @IsObject()
  hierarchy?: Record<string, unknown>;
}

@InputType()
export class TagFilterInput {
  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  searchTerm?: string;

  @Field(() => TagIoType, { nullable: true })
  @IsOptional()
  @IsEnum(TagIoType)
  ioType?: TagIoType;

  @Field(() => TagDataType, { nullable: true })
  @IsOptional()
  @IsEnum(TagDataType)
  dataType?: TagDataType;

  @Field(() => TagDirection, { nullable: true })
  @IsOptional()
  @IsEnum(TagDirection)
  direction?: TagDirection;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  equipmentId?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  edgeDeviceId?: string;
}

// ============================================================================
// Output DTOs
// ============================================================================

@ObjectType()
export class UnifiedTagType {
  @Field(() => ID)
  id!: string;

  @Field()
  tenantId!: string;

  @Field()
  fqn!: string;

  @Field()
  localName!: string;

  @Field({ nullable: true })
  displayName?: string;

  @Field({ nullable: true })
  description?: string;

  @Field(() => TagIoType)
  ioType!: TagIoType;

  @Field(() => TagDataType)
  dataType!: TagDataType;

  @Field(() => TagDirection)
  direction!: TagDirection;

  @Field({ nullable: true })
  engUnit?: string;

  @Field(() => Float, { nullable: true })
  engMin?: number;

  @Field(() => Float, { nullable: true })
  engMax?: number;

  @Field(() => Float, { nullable: true })
  alarmHH?: number;

  @Field(() => Float, { nullable: true })
  alarmH?: number;

  @Field(() => Float, { nullable: true })
  alarmL?: number;

  @Field(() => Float, { nullable: true })
  alarmLL?: number;

  @Field(() => Float, { nullable: true })
  deadband?: number;

  @Field(() => GraphQLJSON)
  source!: Record<string, unknown>;

  @Field(() => GraphQLJSON)
  hierarchy!: Record<string, unknown>;

  @Field()
  createdAt!: Date;

  @Field()
  updatedAt!: Date;
}

@ObjectType()
export class UnifiedTagListType {
  @Field(() => [UnifiedTagType])
  items!: UnifiedTagType[];

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
export class TagDiscoveryResultType {
  @Field()
  success!: boolean;

  @Field({ nullable: true })
  message?: string;

  @Field(() => Int)
  discoveredCount!: number;

  @Field(() => Int)
  createdCount!: number;

  @Field(() => [UnifiedTagType])
  tags!: UnifiedTagType[];
}
