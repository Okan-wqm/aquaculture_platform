import { Transform } from 'class-transformer';
import { IsIn, IsOptional, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';

import {
  ADMIN_LEGAL_HOLD_RELEASE_REASON_MAX_LENGTH_V1,
  ADMIN_LEGAL_HOLD_RELEASE_REASON_MIN_LENGTH_V1,
  ADMIN_LEGAL_HOLD_RELEASE_OPERATION_STATUSES_V1,
  type AdminAuthorizeLegalHoldReleaseOperationV1,
  type AdminCreateLegalHoldReleaseOperationV1,
  type AdminLegalHoldReleaseOperationStatusV1,
} from '@platform/admin-http-contracts';

export class CreateLegalHoldReleaseOperationDto implements AdminCreateLegalHoldReleaseOperationV1 {
  @IsUUID('4')
  tenantId!: string;

  @IsUUID('4')
  requestId!: string;

  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(ADMIN_LEGAL_HOLD_RELEASE_REASON_MIN_LENGTH_V1)
  @MaxLength(ADMIN_LEGAL_HOLD_RELEASE_REASON_MAX_LENGTH_V1)
  releaseReason!: string;
}

export class AuthorizeLegalHoldReleaseOperationDto
  implements AdminAuthorizeLegalHoldReleaseOperationV1
{
  @IsUUID('4')
  tenantId!: string;

  @IsUUID('4')
  requestId!: string;
}

export class LegalHoldReleaseOperationQueryDto {
  @IsUUID('4')
  tenantId!: string;

  @IsOptional()
  @IsIn(ADMIN_LEGAL_HOLD_RELEASE_OPERATION_STATUSES_V1)
  status?: AdminLegalHoldReleaseOperationStatusV1;
}
