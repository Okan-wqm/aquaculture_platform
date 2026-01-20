/**
 * Department Filter Input DTO
 */
import { InputType, Field, ID } from '@nestjs/graphql';
import { IsOptional, IsString, IsBoolean, IsEnum, IsUUID } from 'class-validator';
import { DepartmentType, DepartmentStatus } from '../entities/department.entity';

@InputType()
export class DepartmentFilterInput {
  @Field(() => ID, { nullable: true })
  @IsOptional()
  @IsUUID()
  siteId?: string;

  @Field(() => DepartmentType, { nullable: true })
  @IsOptional()
  @IsEnum(DepartmentType)
  type?: DepartmentType;

  @Field(() => DepartmentStatus, { nullable: true })
  @IsOptional()
  @IsEnum(DepartmentStatus)
  status?: DepartmentStatus;

  @Field({ nullable: true })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  search?: string;
}
