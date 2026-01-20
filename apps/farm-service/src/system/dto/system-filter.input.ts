/**
 * System Filter Input DTO
 */
import { InputType, Field, ID } from '@nestjs/graphql';
import { IsOptional, IsString, IsBoolean, IsEnum, IsUUID } from 'class-validator';
import { SystemType, SystemStatus } from '../entities/system.entity';

@InputType()
export class SystemFilterInput {
  @Field(() => ID, { nullable: true })
  @IsOptional()
  @IsUUID()
  siteId?: string;

  @Field(() => ID, { nullable: true })
  @IsOptional()
  @IsUUID()
  departmentId?: string;

  @Field(() => ID, { nullable: true, description: 'Filter by parent system' })
  @IsOptional()
  @IsUUID()
  parentSystemId?: string;

  @Field(() => SystemType, { nullable: true })
  @IsOptional()
  @IsEnum(SystemType)
  type?: SystemType;

  @Field(() => SystemStatus, { nullable: true })
  @IsOptional()
  @IsEnum(SystemStatus)
  status?: SystemStatus;

  @Field({ nullable: true })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @Field({ nullable: true, description: 'Only get root systems (no parent)' })
  @IsOptional()
  @IsBoolean()
  rootOnly?: boolean;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  search?: string;
}
