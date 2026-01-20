/**
 * Site Filter Input DTO
 */
import { InputType, Field, Int } from '@nestjs/graphql';
import { IsOptional, IsString, IsBoolean, IsEnum, IsInt, Min, Max } from 'class-validator';
import { SiteStatus } from '../entities/site.entity';

@InputType()
export class SiteFilterInput {
  @Field(() => SiteStatus, { nullable: true })
  @IsOptional()
  @IsEnum(SiteStatus)
  status?: SiteStatus;

  @Field({ nullable: true })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  country?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  region?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  search?: string;
}

@InputType()
export class PaginationInput {
  @Field(() => Int, { nullable: true, defaultValue: 1 })
  @IsOptional()
  @IsInt()
  @Min(1)
  page?: number;

  @Field(() => Int, { nullable: true, defaultValue: 20 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @Field({ nullable: true, defaultValue: 'createdAt' })
  @IsOptional()
  @IsString()
  sortBy?: string;

  @Field({ nullable: true, defaultValue: 'DESC' })
  @IsOptional()
  @IsString()
  sortOrder?: 'ASC' | 'DESC';
}
