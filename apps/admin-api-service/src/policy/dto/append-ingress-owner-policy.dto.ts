import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsISO8601,
  IsNotEmpty,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';

import type { IngressOwner, IngressOwnerPolicyState } from '@platform/event-contracts';

export class AppendIngressOwnerPolicyDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID('4')
  tenantId!: string;

  @ApiProperty({ minimum: 1 })
  @IsInt()
  @Min(1)
  version!: number;

  @ApiProperty({ enum: ['NESTJS', 'RUST'] })
  @IsIn(['NESTJS', 'RUST'])
  owner!: IngressOwner;

  @ApiProperty({ format: 'date-time' })
  @IsISO8601({ strict: true })
  effectiveEpoch!: string;

  @ApiProperty({ enum: ['PREPARING', 'ACTIVE', 'DRAINING'] })
  @IsIn(['PREPARING', 'ACTIVE', 'DRAINING'])
  state!: IngressOwnerPolicyState;

  @ApiProperty()
  @IsBoolean()
  drainBarrierSatisfied!: boolean;

  @ApiPropertyOptional({ maxLength: 128 })
  @ValidateIf((dto: AppendIngressOwnerPolicyDto) => dto.drainBarrierSatisfied)
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  drainBarrierEvidence?: string;

  @ApiProperty({ maxLength: 500 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  reason!: string;
}
