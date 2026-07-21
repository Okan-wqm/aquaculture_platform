import { IsEnum, IsOptional, IsString } from 'class-validator';

import { PaginationQueryDto } from '../../shared/pagination-query.dto';
import { CustomPlanStatus } from '../entities/custom-plan.entity';
import { PlanTier } from '../entities/plan-definition.entity';

/**
 * Single query DTO for GET /billing/custom-plans (APA-114, RC-3).
 *
 * The handler previously mixed named `@Query('status')`/`tier`/`tenantId`/
 * `search` params with a bare `@Query() PaginationQueryDto`; under
 * `forbidNonWhitelisted` the bare DTO rejected those filter keys, so every
 * status/search/tier filter returned 400. One DTO extending
 * `PaginationQueryDto` carries the filters and pagination together.
 */
export class CustomPlanQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsString()
  tenantId?: string;

  @IsOptional()
  @IsEnum(CustomPlanStatus)
  status?: CustomPlanStatus;

  @IsOptional()
  @IsEnum(PlanTier)
  tier?: PlanTier;

  @IsOptional()
  @IsString()
  search?: string;
}
