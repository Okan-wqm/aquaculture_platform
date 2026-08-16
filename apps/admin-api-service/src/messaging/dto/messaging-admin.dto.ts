import {
  IsIn,
  IsInt,
  IsISO8601,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export class CreateLegalHoldDto {
  @IsUUID()
  tenantId!: string;

  @IsOptional()
  @IsUUID()
  channelId?: string | null;

  @IsString()
  @IsNotEmpty()
  @MaxLength(2_000)
  reason!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  legalMatterId!: string;

  @IsOptional()
  @IsString()
  @MaxLength(4_000)
  legalMatterDescription?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  requestedBy?: string;

  @IsOptional()
  @IsISO8601({ strict: true })
  expiresAt?: string;
}

export class UpdateRetentionPolicyDto {
  @IsOptional()
  @IsUUID()
  channelId?: string | null;

  @IsInt()
  @Min(1)
  @Max(36_500)
  retentionDays!: number;
}

export class TriggerExportDto {
  @IsOptional()
  @IsIn(['csv', 'json'])
  format?: 'csv' | 'json';
}
