import { IsEnum, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';

import { PaginationQueryDto } from '../../shared/pagination-query.dto';
import { CustomPlanStatus } from '../entities/custom-plan.entity';
import { PlanTier } from '../entities/plan-definition.entity';

/** Complete, validated query contract for GET /billing/custom-plans. */
export class CustomPlanQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsUUID()
  tenantId?: string;

  @IsOptional()
  @IsEnum(CustomPlanStatus)
  status?: CustomPlanStatus;

  @IsOptional()
  @IsEnum(PlanTier)
  tier?: PlanTier;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  search?: string;
}
