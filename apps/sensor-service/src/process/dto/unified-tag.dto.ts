import { InputType, ObjectType, Field, ID, Int, Float } from '@nestjs/graphql';
import { IsString, IsOptional, IsEnum, IsUUID, IsNumber, MaxLength, IsObject, Validate, ValidatorConstraint, ValidatorConstraintInterface, ValidationArguments } from 'class-validator';
import { GraphQLJSON } from 'graphql-scalars';
import { StandardPaginatedResponse } from '@aquaculture/backend-common/pagination';

import { TagDirection, TagIoType, TagDataType, TagStatus } from '../entities/unified-tag.entity';

@ValidatorConstraint({ name: 'jsonMaxSize', async: false })
class JsonMaxSizeConstraint implements ValidatorConstraintInterface {
  validate(value: unknown, args: ValidationArguments): boolean {
    if (value == null) return true;
    const maxBytes = (args.constraints?.[0] as number) ?? 8192;
    return JSON.stringify(value).length <= maxBytes;
  }
  defaultMessage(args: ValidationArguments): string {
    const maxBytes = (args.constraints?.[0] as number) ?? 8192;
    return `JSON object must not exceed ${maxBytes} bytes`;
  }
}

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
  @IsNumber()
  engMin?: number;

  @Field(() => Float, { nullable: true })
  @IsOptional()
  @IsNumber()
  engMax?: number;

  @Field(() => Float, { nullable: true })
  @IsOptional()
  @IsNumber()
  alarmHH?: number;

  @Field(() => Float, { nullable: true })
  @IsOptional()
  @IsNumber()
  alarmH?: number;

  @Field(() => Float, { nullable: true })
  @IsOptional()
  @IsNumber()
  alarmL?: number;

  @Field(() => Float, { nullable: true })
  @IsOptional()
  @IsNumber()
  alarmLL?: number;

  @Field(() => Float, { nullable: true })
  @IsOptional()
  @IsNumber()
  deadband?: number;

  @Field(() => GraphQLJSON, { nullable: true })
  @IsOptional()
  @IsObject()
  @Validate(JsonMaxSizeConstraint, [8192])
  source?: Record<string, unknown>;

  @Field(() => GraphQLJSON, { nullable: true })
  @IsOptional()
  @IsObject()
  @Validate(JsonMaxSizeConstraint, [8192])
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
  @IsNumber()
  engMin?: number;

  @Field(() => Float, { nullable: true })
  @IsOptional()
  @IsNumber()
  engMax?: number;

  @Field(() => Float, { nullable: true })
  @IsOptional()
  @IsNumber()
  alarmHH?: number;

  @Field(() => Float, { nullable: true })
  @IsOptional()
  @IsNumber()
  alarmH?: number;

  @Field(() => Float, { nullable: true })
  @IsOptional()
  @IsNumber()
  alarmL?: number;

  @Field(() => Float, { nullable: true })
  @IsOptional()
  @IsNumber()
  alarmLL?: number;

  @Field(() => Float, { nullable: true })
  @IsOptional()
  @IsNumber()
  deadband?: number;

  @Field(() => GraphQLJSON, { nullable: true })
  @IsOptional()
  @IsObject()
  @Validate(JsonMaxSizeConstraint, [8192])
  source?: Record<string, unknown>;

  @Field(() => GraphQLJSON, { nullable: true })
  @IsOptional()
  @IsObject()
  @Validate(JsonMaxSizeConstraint, [8192])
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
  @IsUUID()
  equipmentId?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsUUID()
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

  @Field(() => TagStatus)
  status!: TagStatus;

  @Field(() => Int)
  revision!: number;

  @Field()
  createdAt!: Date;

  @Field()
  updatedAt!: Date;
}

@ObjectType()
export class UnifiedTagListType extends StandardPaginatedResponse(UnifiedTagType) {}

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

// ============================================================================
// Tag resolution (canonical TagRef → registry binding snapshot)
// ============================================================================

@ObjectType()
export class ResolvedTagBindingType {
  @Field()
  ref!: string;

  @Field(() => ID)
  unifiedTagId!: string;

  @Field(() => TagIoType)
  ioType!: TagIoType;

  @Field(() => TagDataType)
  dataType!: TagDataType;

  @Field(() => TagDirection)
  direction!: TagDirection;

  @Field({ nullable: true })
  engUnit?: string;

  @Field(() => GraphQLJSON)
  source!: Record<string, unknown>;

  @Field(() => Int)
  revision!: number;
}

@ObjectType()
export class UnresolvedTagRefType {
  @Field()
  ref!: string;

  /** 'INVALID_GRAMMAR' | 'NOT_FOUND' */
  @Field()
  reason!: string;
}

@ObjectType()
export class TagResolutionResultType {
  @Field(() => [ResolvedTagBindingType])
  resolved!: ResolvedTagBindingType[];

  @Field(() => [UnresolvedTagRefType])
  unresolved!: UnresolvedTagRefType[];
}
