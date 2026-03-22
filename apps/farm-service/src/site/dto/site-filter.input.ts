/**
 * Site Filter Input DTO
 */
import { InputType, Field } from '@nestjs/graphql';
import { IsOptional, IsString, IsBoolean, IsEnum } from 'class-validator';
import { SiteStatus } from '../entities/site.entity';
import { StandardPaginationInput } from '@aquaculture/backend-common';

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

// ARCH-NOTE: Renamed to avoid GraphQL schema collision with @aquaculture/backend-common PaginationInput.
// Now extends StandardPaginationInput (page/limit) from the shared lib.
@InputType('FarmPaginationInput')
export class PaginationInput extends StandardPaginationInput {}
