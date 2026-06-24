import { IsBoolean, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';

export class RequestTenantErasureDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  reason!: string;

  @IsBoolean()
  @IsOptional()
  dryRun?: boolean;
}

export interface TenantErasureOperationAcceptedResponse {
  operationId: string;
  tenantId: string;
  status: 'IN_PROGRESS';
}
